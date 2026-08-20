import type { CsvRow } from "./parseCsv";
import type {
  AddOnWithoutMriRow,
  AuditResult,
  ComputedFlags,
  DedupedMismatchRow,
  DedupedViolationRow,
  HumanMriExternalEventRow,
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
  "Research Report Reader Fee": "neuroreader",
};

export const NO_SHOW_SERVICE = "No Show/Cancellation Fee";
export const TARGET_SCANNER = "SC7T";

// Derived from SERVICE_MAP instead of a separate literal, so the two
// cannot drift apart if Dogfish ever renames this service.
const NEUROREADER_SERVICE = Object.keys(SERVICE_MAP).find(
  (service) => SERVICE_MAP[service] === "neuroreader"
)!;
const HUMAN_MRI_EXTERNAL_SERVICE = Object.keys(SERVICE_MAP).find(
  (service) => SERVICE_MAP[service] === "humanMRIExternal"
)!;
const STELLAR_CHANCE_SCANNERS = new Set(["SC3T", "SC7T"]);

// Dogfish and CAMS protocol numbers use one of three formats:
// - a 6-digit number, optionally followed by a suffix such as "_7X"
//   (this code strips the suffix)
// - an animal protocol: "AR" followed by 6 digits
// - a "xx-xxxx" number: 2 digits, a hyphen, then 4 digits
const SIX_DIGIT_PREFIX = /^\d{6}/;
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
    neuroreader: false,
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
    neuroreader: a.neuroreader || b.neuroreader,
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

/** Converts a Dogfish or CAMS protocol number to its 6-digit base. It
 * strips any suffix. If a value does not start with 6 digits (for
 * example, an animal protocol), the function returns it unchanged. This
 * matches the convention already used in the source data. */
function normalizeDogfishCamsProtocol(rawProtocolNumber: string): string {
  const match = rawProtocolNumber.match(SIX_DIGIT_PREFIX);
  return match ? match[0] : rawProtocolNumber;
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
      service === NEUROREADER_SERVICE && STELLAR_CHANCE_SCANNERS.has(scanner);

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
    const hasAddOn = flags.stimulus || flags.neuroreader;
    if (hasAddOn && !hasMriService(flags)) {
      rows.push({
        eventId: event.eventId,
        protocolNumber: event.protocolNumberRaw,
        stimulus: flags.stimulus,
        neuroreader: flags.neuroreader,
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

interface CamsRecord {
  industrySponsored: string;
}

function buildCamsLookup(camsRows: CsvRow[]): Map<string, CamsRecord> {
  const lookup = new Map<string, CamsRecord>();

  for (const row of camsRows) {
    const rawProtocol = field(row, "Protocol Number");
    if (rawProtocol === "") continue;

    const normalized = normalizeDogfishCamsProtocol(rawProtocol);
    // The first matching record wins. The REDCap lookup below also
    // collapses duplicate records this way, matching the original
    // Julia audit script.
    if (!lookup.has(normalized)) {
      lookup.set(normalized, {
        industrySponsored: field(row, "Industry Sponsored"),
      });
    }
  }

  return lookup;
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

  return {
    industryBilledAsGovernment: cams
      ? !billedIndustry && cams.industrySponsored === "Yes"
      : undefined,
    governmentBilledAsIndustry: cams
      ? billedIndustry && cams.industrySponsored !== "Yes"
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
      ? !flags.stimulus && redcap.stimulus
      : undefined,
    stimulusBillingExtra: redcap
      ? flags.stimulus && !redcap.stimulus
      : undefined,
    neuroreaderBillingMissed: redcap
      ? !flags.neuroreader && redcap.neuroreader
      : undefined,
    neuroreaderBillingExtra: redcap
      ? flags.neuroreader && !redcap.neuroreader
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
    computed.neuroreaderBillingMissed === true ||
    computed.neuroreaderBillingExtra === true ||
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
        neuroreaderBillingMissed: computed.neuroreaderBillingMissed === true,
        neuroreaderBillingExtra: computed.neuroreaderBillingExtra === true,
        neuroreaderAtStellarChance: computed.neuroreaderAtStellarChance,
      });
    }
  }

  return {
    violations,
    dedupedViolations: dedupeViolations(violations),
    mismatches,
    dedupedMismatches: dedupeMismatches(mismatches),
    scannerEvents: buildScannerEvents(dogfishRows),
    humanMriExternalEvents: buildHumanMriExternalEvents(dogfishRows),
    prodevConsistencyIssues: buildProdevConsistencyIssues(events),
    addOnsWithoutMri: buildAddOnsWithoutMri(events),
  };
}
