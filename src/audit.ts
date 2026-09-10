import type { CsvRow } from "./parseCsv";
import {
  buildCamsLookup,
  normalizeDogfishCamsProtocol,
  SIX_DIGIT_PREFIX,
  type CamsRecord,
} from "./cams";
import type {
  AddOnWithoutMriRow,
  AuditResult,
  ComputedFlags,
  DedupedMismatchRow,
  DedupedViolationRow,
  HumanMriExternalEventRow,
  LateCancellationRow,
  MismatchRow,
  ProdevConsistencyRow,
  RedcapNameCollision,
  ScannerEventRow,
  ServiceFlags,
  ViolationRow,
} from "./types";

export const SERVICE_MAP: Record<string, keyof ServiceFlags> = {
  "Human MRI": "humanMRI",
  "Human MRI (Industry/CHOP)": "humanMRIIndustry",
  "Human MRI (Ex-vivo scanning)": "humanMRIExVivo",
  "Human MRI (external)": "humanMRIExternal",
  "MRI after hr no tech": "humanMRIAfterHours",
  "Human MRI (Prodev Tier 1)": "humanMRIProdevTier1",
  "Human MRI (Prodev Tier 2)": "humanMRIProdevTier2",
  "Animal MRI": "animalMRI",
  "Animal MRI (Industry/CHOP)": "animalMRIIndustry",
  "Stimulus/Response Equipment Usage Fee": "stimulus",
  "Stimulus/Response Equipment Usage Fee (Industry/CHOP)": "stimulusIndustry",
  "Research Report Reader Fee": "neuroreader",
  "Research Report Reader Fee (Industry/CHOP)": "neuroreaderIndustry",
};

export const NO_SHOW_SERVICE = "No Show/Cancellation Fee";
export const TARGET_SCANNER = "SC7T";

// How many "No Show/Cancellation Fee" events a single protocol is allowed
// per calendar month before the rest are reported as excess.
export const LATE_CANCELLATION_ALLOWANCE = 2;

// Derived from SERVICE_MAP instead of separate literals, so the two
// cannot drift apart if Dogfish ever renames a service. The Research
// Report Reader fee has two Dogfish services — the standard one and the
// "(Industry/CHOP)" rate — and the Stellar Chance check covers both.
const READER_SERVICES = new Set(
  Object.keys(SERVICE_MAP).filter(
    (service) =>
      SERVICE_MAP[service] === "neuroreader" ||
      SERVICE_MAP[service] === "neuroreaderIndustry"
  )
);
const HUMAN_MRI_EXTERNAL_SERVICE = Object.keys(SERVICE_MAP).find(
  (service) => SERVICE_MAP[service] === "humanMRIExternal"
)!;
const STELLAR_CHANCE_SCANNERS = new Set(["SC3T", "SC7T"]);

// Dogfish and CAMS protocol numbers use one of three formats:
// - a 6-digit number, optionally followed by a suffix such as "_7X"
//   (SIX_DIGIT_PREFIX, imported from ./cams, which strips the suffix)
// - an animal protocol: "AR" followed by 6 digits
// - a "xx-xxxx" number: 2 digits, a hyphen, then 4 digits
const ANIMAL_PROTOCOL = /^AR\d{6}/;
const YEAR_SEQUENCE_PROTOCOL = /^\d{2}-\d{4}/;

// A protocol billed at a Prodev tier is expected to end with "-P", "_P",
// or "Prodev" (case-insensitive) on its raw, un-normalized number — the
// "-P" would otherwise be stripped by normalizeDogfishCamsProtocol.
const PRODEV_PROTOCOL_SUFFIX = /(?:[-_]p|prodev)$/i;

/** Reads a field from a raw CSV row. Returns "" if the field is missing,
 * and trims whitespace either way. */
function field(row: CsvRow, key: string): string {
  return (row[key] ?? "").trim();
}

function emptyFlags(): ServiceFlags {
  return {
    humanMRI: false,
    humanMRIIndustry: false,
    humanMRIExVivo: false,
    humanMRIExternal: false,
    humanMRIAfterHours: false,
    humanMRIProdevTier1: false,
    humanMRIProdevTier2: false,
    animalMRI: false,
    animalMRIIndustry: false,
    stimulus: false,
    stimulusIndustry: false,
    neuroreader: false,
    neuroreaderIndustry: false,
  };
}

function orFlags(a: ServiceFlags, b: ServiceFlags): ServiceFlags {
  return {
    humanMRI: a.humanMRI || b.humanMRI,
    humanMRIIndustry: a.humanMRIIndustry || b.humanMRIIndustry,
    humanMRIExVivo: a.humanMRIExVivo || b.humanMRIExVivo,
    humanMRIExternal: a.humanMRIExternal || b.humanMRIExternal,
    humanMRIAfterHours: a.humanMRIAfterHours || b.humanMRIAfterHours,
    humanMRIProdevTier1: a.humanMRIProdevTier1 || b.humanMRIProdevTier1,
    humanMRIProdevTier2: a.humanMRIProdevTier2 || b.humanMRIProdevTier2,
    animalMRI: a.animalMRI || b.animalMRI,
    animalMRIIndustry: a.animalMRIIndustry || b.animalMRIIndustry,
    stimulus: a.stimulus || b.stimulus,
    stimulusIndustry: a.stimulusIndustry || b.stimulusIndustry,
    neuroreader: a.neuroreader || b.neuroreader,
    neuroreaderIndustry: a.neuroreaderIndustry || b.neuroreaderIndustry,
  };
}

function isAnimalProtocolFormat(rawProtocolNumber: string): boolean {
  return ANIMAL_PROTOCOL.test(rawProtocolNumber);
}

function isValidProtocolFormat(rawProtocolNumber: string): boolean {
  return (
    SIX_DIGIT_PREFIX.test(rawProtocolNumber) ||
    ANIMAL_PROTOCOL.test(rawProtocolNumber) ||
    YEAR_SEQUENCE_PROTOCOL.test(rawProtocolNumber)
  );
}

/** REDCap's irb_protocol_number field holds free text, not a clean value,
 * and can name a protocol more than one way in the same field — for
 * example "25-2374 (45084153)" names the same protocol by an internal
 * tracking number and by its real, 6-digit Penn protocol number. This
 * function returns every name found, instead of guessing which one is
 * "the" real number:
 *
 * - An animal-format or year-sequence-format name at the very start of
 *   the text (for example, "26-5894" in
 *   "26-5894 (reliance agreement; penn not IRB of record)").
 * - Every run of 6 or more digits anywhere in the text, inside
 *   parentheses or bare, truncated to its first 6 digits — matching the
 *   convention already used for Dogfish and CAMS's own Protocol Number
 *   column. This covers both a parenthetical override (for example,
 *   "821881" from "CHOP_14-011487 (821881)") and a standalone run after
 *   other text (for example, "832748" from "832748_Prodev").
 *
 * A value with none of these, such as a placeholder like "TBD" or
 * "Pending", gets no name at all. Such a protocol has no real number
 * yet, so it cannot be matched to Dogfish or CAMS by number — treating
 * the placeholder text itself as a name would wrongly link every
 * "TBD" protocol together.
 */
function extractRedcapProtocolNames(rawIrbNumber: string): string[] {
  const names = new Set<string>();

  const animalMatch = rawIrbNumber.match(ANIMAL_PROTOCOL);
  if (animalMatch) names.add(animalMatch[0]);

  const yearMatch = rawIrbNumber.match(YEAR_SEQUENCE_PROTOCOL);
  if (yearMatch) names.add(yearMatch[0]);

  for (const digitRun of rawIrbNumber.match(/\d{6,}/g) ?? []) {
    names.add(digitRun.slice(0, 6));
  }

  return [...names];
}

interface DogfishEvent {
  eventId: string;
  protocolNumberRaw: string;
  scanTime: string;
  projectTitle: string;
  scanner: string;
  flags: ServiceFlags;
  neuroreaderAtStellarChance: boolean;
}

function buildDogfishEvents(dogfishRows: CsvRow[]): DogfishEvent[] {
  const eventsById = new Map<string, DogfishEvent>();

  for (const row of dogfishRows) {
    const service = field(row, "Service");
    if (service === NO_SHOW_SERVICE) continue;

    const eventId = field(row, "Event ID");
    if (eventId === "") continue;

    const protocolNumberRaw = field(row, "Protocol Number");
    const scanTime = field(row, "Scan Time");
    const projectTitle = field(row, "Project Title");
    const scanner = field(row, "Scanner");

    const flagKey = SERVICE_MAP[service];
    const rowFlags = emptyFlags();
    if (flagKey) rowFlags[flagKey] = true;

    const rowNeuroreaderAtStellarChance =
      READER_SERVICES.has(service) && STELLAR_CHANCE_SCANNERS.has(scanner);

    const existing = eventsById.get(eventId);
    if (existing) {
      existing.flags = orFlags(existing.flags, rowFlags);
      existing.neuroreaderAtStellarChance ||= rowNeuroreaderAtStellarChance;
    } else {
      eventsById.set(eventId, {
        eventId,
        protocolNumberRaw,
        scanTime,
        projectTitle,
        scanner,
        flags: rowFlags,
        neuroreaderAtStellarChance: rowNeuroreaderAtStellarChance,
      });
    }
  }

  return [...eventsById.values()];
}

function buildScannerEvents(dogfishRows: CsvRow[]): ScannerEventRow[] {
  const rows: ScannerEventRow[] = [];

  for (const row of dogfishRows) {
    const scanner = field(row, "Scanner");
    if (scanner !== TARGET_SCANNER) continue;

    rows.push({
      eventId: field(row, "Event ID"),
      protocolNumber: field(row, "Protocol Number"),
      projectTitle: field(row, "Project Title"),
      service: field(row, "Service"),
      scanTime: field(row, "Scan Time"),
      quantity: field(row, "Quantity"),
      mandatoryService: field(row, "Mandatory Service"),
      schedulingUser: field(row, "Scheduling User"),
      checkInUser: field(row, "Check-In User"),
    });
  }

  return rows;
}

/** Every raw Dogfish row billed as Human MRI (External), on any scanner.
 * Like buildScannerEvents, this is not grouped or deduped, and includes
 * no-shows. */
function buildHumanMriExternalEvents(
  dogfishRows: CsvRow[]
): HumanMriExternalEventRow[] {
  const rows: HumanMriExternalEventRow[] = [];

  for (const row of dogfishRows) {
    const service = field(row, "Service");
    if (service !== HUMAN_MRI_EXTERNAL_SERVICE) continue;

    rows.push({
      eventId: field(row, "Event ID"),
      protocolNumber: field(row, "Protocol Number"),
      projectTitle: field(row, "Project Title"),
      scanner: field(row, "Scanner"),
      service,
      scanTime: field(row, "Scan Time"),
      quantity: field(row, "Quantity"),
      mandatoryService: field(row, "Mandatory Service"),
      schedulingUser: field(row, "Scheduling User"),
      checkInUser: field(row, "Check-In User"),
    });
  }

  return rows;
}

/** Groups every "No Show/Cancellation Fee" row into cancellation events
 * (by Event ID) and, per protocol per calendar month, reports the events
 * beyond LATE_CANCELLATION_ALLOWANCE. The month comes from Scan Time.
 * Protocols are grouped by their exact Dogfish Protocol Number — no
 * normalization — so "819126" and "819126-C" count separately. Within a
 * protocol-month the events are ordered by Scan Time, then Event ID, and
 * every event past the allowance gets one row, carrying the month's total
 * cancellation count. A row with a blank Event ID, a blank Protocol
 * Number, or a Scan Time with no leading "YYYY-MM" is skipped — it cannot
 * be tied to a specific event, protocol, or month. */
function buildExcessLateCancellations(
  dogfishRows: CsvRow[]
): LateCancellationRow[] {
  interface CancellationEvent {
    eventId: string;
    protocolNumber: string;
    month: string;
    scanTime: string;
    scanner: string;
    projectTitle: string;
  }

  // Collapse the raw rows to one entry per Event ID first — a single
  // cancellation event can be billed on more than one Dogfish row.
  const eventsById = new Map<string, CancellationEvent>();

  for (const row of dogfishRows) {
    if (field(row, "Service") !== NO_SHOW_SERVICE) continue;

    const eventId = field(row, "Event ID");
    if (eventId === "" || eventsById.has(eventId)) continue;

    const protocolNumber = field(row, "Protocol Number");
    if (protocolNumber === "") continue;

    const scanTime = field(row, "Scan Time");
    const month = scanTime.match(/^\d{4}-\d{2}/)?.[0];
    if (!month) continue;

    eventsById.set(eventId, {
      eventId,
      protocolNumber,
      month,
      scanTime,
      scanner: field(row, "Scanner"),
      projectTitle: field(row, "Project Title"),
    });
  }

  // Bucket the events by (protocol, month). The key is a JSON array —
  // like the JSON keys dedupeViolations uses — so no delimiter can
  // collide with a character inside the protocol number.
  const byProtocolMonth = new Map<string, CancellationEvent[]>();
  for (const event of eventsById.values()) {
    const key = JSON.stringify([event.protocolNumber, event.month]);
    const bucket = byProtocolMonth.get(key);
    if (bucket) bucket.push(event);
    else byProtocolMonth.set(key, [event]);
  }

  const rows: LateCancellationRow[] = [];
  for (const bucket of byProtocolMonth.values()) {
    if (bucket.length <= LATE_CANCELLATION_ALLOWANCE) continue;

    bucket.sort(
      (a, b) =>
        a.scanTime.localeCompare(b.scanTime) ||
        a.eventId.localeCompare(b.eventId)
    );

    for (const event of bucket.slice(LATE_CANCELLATION_ALLOWANCE)) {
      rows.push({
        protocolNumber: event.protocolNumber,
        month: event.month,
        eventId: event.eventId,
        scanTime: event.scanTime,
        scanner: event.scanner,
        projectTitle: event.projectTitle,
        cancellationsInMonth: bucket.length,
      });
    }
  }

  rows.sort(
    (a, b) =>
      a.protocolNumber.localeCompare(b.protocolNumber) ||
      a.month.localeCompare(b.month) ||
      a.scanTime.localeCompare(b.scanTime) ||
      a.eventId.localeCompare(b.eventId)
  );

  return rows;
}

function hasMriService(flags: ServiceFlags): boolean {
  return (
    flags.humanMRI ||
    flags.humanMRIIndustry ||
    flags.humanMRIExVivo ||
    flags.humanMRIExternal ||
    flags.humanMRIAfterHours ||
    flags.humanMRIProdevTier1 ||
    flags.humanMRIProdevTier2 ||
    flags.animalMRI ||
    flags.animalMRIIndustry
  );
}

/** A Stimulus or Neuroreader fee should accompany a scan on the same
 * event. A fee billed with no MRI service code on that event is a
 * data-quality flag. This is true even if the event is also a CAMS or
 * REDCap mismatch or violation. */
function buildAddOnsWithoutMri(events: DogfishEvent[]): AddOnWithoutMriRow[] {
  const rows: AddOnWithoutMriRow[] = [];

  for (const event of events) {
    const { flags } = event;
    // Either rate of a fee — the standard service or its "(Industry/CHOP)"
    // variant — counts as that add-on being billed on the event.
    const stimulusBilled = flags.stimulus || flags.stimulusIndustry;
    const readerBilled = flags.neuroreader || flags.neuroreaderIndustry;
    const hasAddOn = stimulusBilled || readerBilled;
    if (hasAddOn && !hasMriService(flags)) {
      rows.push({
        eventId: event.eventId,
        protocolNumber: event.protocolNumberRaw,
        stimulus: stimulusBilled,
        neuroreader: readerBilled,
      });
    }
  }

  return rows;
}

/** Checks each event's Prodev-tier billing against its protocol number's
 * naming. The "-P"/"_P"/"Prodev" ending does not say which tier, so both
 * tiers count as one "Prodev" concept for this check. */
function buildProdevConsistencyIssues(
  events: DogfishEvent[]
): ProdevConsistencyRow[] {
  const rows: ProdevConsistencyRow[] = [];

  for (const event of events) {
    const { flags, protocolNumberRaw } = event;
    const billedTiers = [
      flags.humanMRIProdevTier1 ? "Human MRI (Prodev Tier 1)" : undefined,
      flags.humanMRIProdevTier2 ? "Human MRI (Prodev Tier 2)" : undefined,
    ].filter((tier): tier is string => tier !== undefined);

    const hasProdevService = billedTiers.length > 0;
    const hasProdevSuffix = PRODEV_PROTOCOL_SUFFIX.test(protocolNumberRaw);

    const prodevServiceWithoutSuffix = hasProdevService && !hasProdevSuffix;
    const suffixWithoutProdevService = hasProdevSuffix && !hasProdevService;

    if (prodevServiceWithoutSuffix || suffixWithoutProdevService) {
      rows.push({
        eventId: event.eventId,
        protocolNumber: protocolNumberRaw,
        projectTitle: event.projectTitle,
        scanTime: event.scanTime,
        scanner: event.scanner,
        prodevServiceBilled: billedTiers.join(", "),
        prodevServiceWithoutSuffix,
        suffixWithoutProdevService,
      });
    }
  }

  return rows;
}

interface RedcapRecord {
  neuroreader: boolean;
  stimulus: boolean;
}

const REDCAP_REVIEW_LETTER_COMPLETE = "2";
const REDCAP_CHECKED = "1";

export interface RedcapLookupResult {
  lookup: Map<string, RedcapRecord>;
  collisions: RedcapNameCollision[];
}

/** Builds the REDCap protocol lookup, keyed by every name each "complete"
 * row's irb_protocol_number produces (see extractRedcapProtocolNames).
 * One protocol can span several REDCap rows over time — a resubmission,
 * or a later row adding an annotation — and those rows are expected to
 * produce the exact same set of names; the later row's data wins, same
 * as before this function returned more than one name per row.
 *
 * A name is only trusted if every row that produces it agrees on the
 * *entire* set of names for that row. If two rows produce the same name
 * but disagree on the rest of their names, this function cannot tell a
 * genuine resubmission from two different protocols whose REDCap text
 * happens to overlap — for example, a coordinator's free-text note
 * mentioning a different, unrelated protocol's number. That name is
 * reported as a collision instead of being trusted for either row. */
export function buildRedcapLookup(redcapRows: CsvRow[]): RedcapLookupResult {
  const lookup = new Map<string, RedcapRecord>();
  const ownerByName = new Map<string, { rawIrb: string; names: Set<string> }>();
  const collisions: RedcapNameCollision[] = [];
  const reportedCollisions = new Set<string>();

  for (const row of redcapRows) {
    const complete = field(row, "camris_review_letter_complete");
    if (complete !== REDCAP_REVIEW_LETTER_COMPLETE) continue;

    const rawIrb = field(row, "irb_protocol_number");
    if (rawIrb === "") continue;

    const names = extractRedcapProtocolNames(rawIrb);
    if (names.length === 0) continue;

    const nameSet = new Set(names);
    const record: RedcapRecord = {
      neuroreader: field(row, "fees_reviewletter___2") === REDCAP_CHECKED,
      stimulus: field(row, "fees_reviewletter___6") === REDCAP_CHECKED,
    };

    for (const name of names) {
      const owner = ownerByName.get(name);
      const sameRow = owner?.rawIrb === rawIrb;
      const sameNameSet =
        owner !== undefined &&
        owner.names.size === nameSet.size &&
        [...owner.names].every((n) => nameSet.has(n));

      if (owner !== undefined && !sameRow && !sameNameSet) {
        const collisionKey = [owner.rawIrb, rawIrb].sort().join(" ") + " " + name;
        if (!reportedCollisions.has(collisionKey)) {
          reportedCollisions.add(collisionKey);
          collisions.push({ name, protocolFields: [owner.rawIrb, rawIrb] });
        }
        continue;
      }

      ownerByName.set(name, { rawIrb, names: nameSet });
      // The last matching "complete" row for a protocol wins.
      lookup.set(name, record);
    }
  }

  return { lookup, collisions };
}

function computeFlags(
  event: DogfishEvent,
  cams: CamsRecord | undefined,
  redcap: RedcapRecord | undefined
): ComputedFlags {
  const { flags, protocolNumberRaw } = event;
  const billedIndustry = flags.humanMRIIndustry || flags.animalMRIIndustry;
  const animalFormat = isAnimalProtocolFormat(protocolNumberRaw);
  const camsIndustry = cams?.industrySponsored === "Yes";

  // Either rate of an ancillary fee — the standard service or its
  // "(Industry/CHOP)" variant — counts as that fee being billed for the
  // REDCap approved-vs-billed reconciliation below. The rate-vs-
  // sponsorship check further down is what looks at which rate it was.
  const stimulusBilled = flags.stimulus || flags.stimulusIndustry;
  const readerBilled = flags.neuroreader || flags.neuroreaderIndustry;

  return {
    industryBilledAsGovernment: cams
      ? !billedIndustry && camsIndustry
      : undefined,
    governmentBilledAsIndustry: cams
      ? billedIndustry && !camsIndustry
      : undefined,
    animalBilledAsHuman:
      (flags.humanMRI ||
        flags.humanMRIIndustry ||
        flags.humanMRIExternal ||
        flags.humanMRIAfterHours ||
        flags.humanMRIProdevTier1 ||
        flags.humanMRIProdevTier2) &&
      animalFormat,
    humanBilledAsAnimal:
      (flags.animalMRI || flags.animalMRIIndustry) && !animalFormat,
    stimulusBillingMissed: redcap
      ? !stimulusBilled && redcap.stimulus
      : undefined,
    stimulusBillingExtra: redcap
      ? stimulusBilled && !redcap.stimulus
      : undefined,
    // An ancillary fee should carry the "(Industry/CHOP)" rate when, and
    // only when, CAMS marks the protocol industry-sponsored. These mirror
    // industryBilledAsGovernment / governmentBilledAsIndustry above, but
    // scoped to the specific fee billed on this event, and need a CAMS
    // record the same way (no record -> undefined -> the event lands on
    // the Mismatches table). The "(Industry/CHOP)" ancillary flags are
    // deliberately kept out of billedIndustry (see README) — this pair of
    // checks is the only place they are read.
    stimulusBilledAsGovernment: cams
      ? flags.stimulus && camsIndustry
      : undefined,
    stimulusBilledAsIndustry: cams
      ? flags.stimulusIndustry && !camsIndustry
      : undefined,
    neuroreaderBillingMissed: redcap
      ? !readerBilled && redcap.neuroreader
      : undefined,
    neuroreaderBillingExtra: redcap
      ? readerBilled && !redcap.neuroreader
      : undefined,
    neuroreaderBilledAsGovernment: cams
      ? flags.neuroreader && camsIndustry
      : undefined,
    neuroreaderBilledAsIndustry: cams
      ? flags.neuroreaderIndustry && !camsIndustry
      : undefined,
    neuroreaderAtStellarChance: event.neuroreaderAtStellarChance,
  };
}

/** Removes Event ID, Scan Time, and Scanner from each violation. It then
 * collapses the rows into groups of unique remaining fields. Event ID
 * and Scan Time are both unique per event, so keeping either field
 * would prevent any grouping. Scanner can differ across a protocol's
 * events, so it has no single correct value at the protocol level. Use
 * this function to turn a per-event table into a per-protocol table. */
function dedupeViolations(violations: ViolationRow[]): DedupedViolationRow[] {
  const seen = new Map<string, DedupedViolationRow>();

  for (const {
    eventId: _eventId,
    scanTime: _scanTime,
    scanner: _scanner,
    ...rest
  } of violations) {
    const key = JSON.stringify(rest);
    if (!seen.has(key)) seen.set(key, rest);
  }

  return [...seen.values()];
}

/** Works like dedupeViolations, but for mismatches. Mismatches have only
 * one per-event field, Event ID, so this function drops just that field. */
function dedupeMismatches(mismatches: MismatchRow[]): DedupedMismatchRow[] {
  const seen = new Map<string, DedupedMismatchRow>();

  for (const { eventId: _eventId, ...rest } of mismatches) {
    const key = JSON.stringify(rest);
    if (!seen.has(key)) seen.set(key, rest);
  }

  return [...seen.values()];
}

function hasAnyViolation(computed: ComputedFlags): boolean {
  return (
    computed.industryBilledAsGovernment === true ||
    computed.governmentBilledAsIndustry === true ||
    computed.animalBilledAsHuman === true ||
    computed.humanBilledAsAnimal === true ||
    computed.stimulusBillingMissed === true ||
    computed.stimulusBillingExtra === true ||
    computed.stimulusBilledAsGovernment === true ||
    computed.stimulusBilledAsIndustry === true ||
    computed.neuroreaderBillingMissed === true ||
    computed.neuroreaderBillingExtra === true ||
    computed.neuroreaderBilledAsGovernment === true ||
    computed.neuroreaderBilledAsIndustry === true ||
    computed.neuroreaderAtStellarChance
  );
}

export function runAudit(
  dogfishRows: CsvRow[],
  camsRows: CsvRow[],
  redcapRows: CsvRow[]
): AuditResult {
  const events = buildDogfishEvents(dogfishRows);
  const camsLookup = buildCamsLookup(camsRows);
  const { lookup: redcapLookup } = buildRedcapLookup(redcapRows);

  const violations: ViolationRow[] = [];
  const mismatches: MismatchRow[] = [];

  for (const event of events) {
    const normalizedProtocol = normalizeDogfishCamsProtocol(
      event.protocolNumberRaw
    );
    const cams = camsLookup.get(normalizedProtocol);
    const redcap = redcapLookup.get(normalizedProtocol);
    const validFormat = isValidProtocolFormat(event.protocolNumberRaw);

    const noCamsMatch = !cams;
    const noActiveRedcapMatch = !redcap;
    const invalidProtocolFormat = !validFormat;

    if (noCamsMatch || noActiveRedcapMatch || invalidProtocolFormat) {
      mismatches.push({
        eventId: event.eventId,
        protocolNumber: event.protocolNumberRaw,
        projectTitle: event.projectTitle,
        noCamsMatch,
        noActiveRedcapMatch,
        invalidProtocolFormat,
      });
    }

    const computed = computeFlags(event, cams, redcap);
    if (hasAnyViolation(computed)) {
      violations.push({
        eventId: event.eventId,
        protocolNumber: event.protocolNumberRaw,
        scanTime: event.scanTime,
        scanner: event.scanner,
        industryBilledAsGovernment: computed.industryBilledAsGovernment === true,
        governmentBilledAsIndustry: computed.governmentBilledAsIndustry === true,
        animalBilledAsHuman: computed.animalBilledAsHuman,
        humanBilledAsAnimal: computed.humanBilledAsAnimal,
        stimulusBillingMissed: computed.stimulusBillingMissed === true,
        stimulusBillingExtra: computed.stimulusBillingExtra === true,
        stimulusBilledAsGovernment:
          computed.stimulusBilledAsGovernment === true,
        stimulusBilledAsIndustry: computed.stimulusBilledAsIndustry === true,
        neuroreaderBillingMissed: computed.neuroreaderBillingMissed === true,
        neuroreaderBillingExtra: computed.neuroreaderBillingExtra === true,
        neuroreaderBilledAsGovernment:
          computed.neuroreaderBilledAsGovernment === true,
        neuroreaderBilledAsIndustry:
          computed.neuroreaderBilledAsIndustry === true,
        neuroreaderAtStellarChance: computed.neuroreaderAtStellarChance,
      });
    }
  }

  return {
    violations,
    dedupedViolations: dedupeViolations(violations),
    mismatches,
    dedupedMismatches: dedupeMismatches(mismatches),
    excessLateCancellations: buildExcessLateCancellations(dogfishRows),
    scannerEvents: buildScannerEvents(dogfishRows),
    humanMriExternalEvents: buildHumanMriExternalEvents(dogfishRows),
    prodevConsistencyIssues: buildProdevConsistencyIssues(events),
    addOnsWithoutMri: buildAddOnsWithoutMri(events),
  };
}
