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
  DisagreeingSource,
  FeeOnExternalProtocolRow,
  FixedSourceViolationFlag,
  HumanMriExternalEventRow,
  LateCancellationRow,
  MismatchRow,
  NoShowOnProdevRow,
  ProdevConsistencyRow,
  ProtocolIssueRow,
  RateDisagreement,
  RedcapNameCollision,
  ScannerEventRow,
  ServiceFlags,
  ViolationFlag,
  ViolationIssue,
  ViolationIssueRow,
  ViolationRow,
} from "./types";

export const SERVICE_MAP: Record<string, keyof ServiceFlags> = {
  "Human MRI": "humanMRI",
  "Human MRI (Industry/CHOP)": "humanMRIIndustry",
  "Human MRI (Ex-vivo scanning)": "humanMRIExVivo",
  "Human MRI (industry/external)": "humanMRIExternal",
  // The old name of "Human MRI (industry/external)". Older exports still
  // use it.
  "Human MRI (external)": "humanMRIExternal",
  "MRI after hr no tech": "humanMRIAfterHours",
  "Human MRI (Prodev Tier 1)": "humanMRIProdevTier1",
  "Human MRI (Prodev Tier 2)": "humanMRIProdevTier2",
  "Animal MRI": "animalMRI",
  "Animal MRI (Industry/CHOP)": "animalMRIIndustry",
  "Stimulus/Response Equipment Usage Fee": "stimulus",
  "Stimulus/Response Equipment Usage Fee (Ind)": "stimulusIndustry",
  "Research Report Reader Fee": "neuroreader",
  "Research Report Reader Fee (Industry)": "neuroreaderIndustry",
};

export const NO_SHOW_SERVICE = "No Show/Cancellation Fee";
export const TARGET_SCANNER = "SC7T";

// How many "No Show/Cancellation Fee" events a single protocol is allowed
// per calendar month before the rest are reported as excess.
export const LATE_CANCELLATION_ALLOWANCE = 2;

// The first scan date ("YYYY-MM-DD") on which the industry rates of the
// Stimulus/Response Equipment and Research Report Reader fees exist.
// Before it, the standard fee was the only rate, so a standard fee on an
// industry-sponsored protocol is correct for an earlier scan.
export const INDUSTRY_FEE_RATE_START = "2026-07-01";

// Derived from SERVICE_MAP instead of separate literals, so the two
// cannot drift apart if Dogfish ever renames a service. The Research
// Report Reader fee has two Dogfish services — the standard one and the
// "(Industry)" rate — and the Stellar Chance check covers both.
const READER_SERVICES = new Set(
  Object.keys(SERVICE_MAP).filter(
    (service) =>
      SERVICE_MAP[service] === "neuroreader" ||
      SERVICE_MAP[service] === "neuroreaderIndustry"
  )
);
// Every Dogfish label for the external MRI rate, current and old. Use a
// set built with filter(), not find(): find() returns only the first
// label, and the other label's rows would silently drop out of the
// external events table.
const HUMAN_MRI_EXTERNAL_SERVICES = new Set(
  Object.keys(SERVICE_MAP).filter(
    (service) => SERVICE_MAP[service] === "humanMRIExternal"
  )
);
const STELLAR_CHANCE_SCANNERS = new Set(["SC3T", "SC7T"]);

// The issue name for each ViolationRow flag, and the disagreeing source
// of each check that has a fixed one. A rate check has no fixed source:
// its ViolationRow value names the sources that disagree. The mapped type
// makes the compiler reject a flag with no entry here, so a new flag
// cannot silently drop out of the tables, and a fixed-source flag with
// no source. The entry order is the order issues appear in, everywhere.
const VIOLATION_ISSUE_DEFINITIONS: {
  [F in ViolationFlag]: F extends FixedSourceViolationFlag
    ? { issue: string; source: DisagreeingSource }
    : { issue: string };
} = {
  industryBilledAsGovernment: {
    issue: "Industry billed as government (MRI)",
  },
  governmentBilledAsIndustry: {
    issue: "Government billed as industry (MRI)",
  },
  chopBilledAsStandard: {
    issue: "CHOP study billed at standard MRI rate",
    source: "REDCap",
  },
  animalBilledAsHuman: {
    issue: "Animal billed as human",
    source: "Protocol format",
  },
  humanBilledAsAnimal: {
    issue: "Human billed as animal",
    source: "Protocol format",
  },
  stimulusBillingMissed: {
    issue: "Stimulus billing missed",
    source: "REDCap letter",
  },
  stimulusBillingExtra: {
    issue: "Stimulus billing extra",
    source: "REDCap letter",
  },
  stimulusBilledAsGovernment: {
    issue: "Stimulus billed as government",
  },
  stimulusBilledAsIndustry: {
    issue: "Stimulus billed as industry",
  },
  neuroreaderBillingMissed: {
    issue: "Neuroreader billing missed",
    source: "REDCap letter",
  },
  neuroreaderBillingExtra: {
    issue: "Neuroreader billing extra",
    source: "REDCap letter",
  },
  neuroreaderBilledAsGovernment: {
    issue: "Neuroreader billed as government",
  },
  neuroreaderBilledAsIndustry: {
    issue: "Neuroreader billed as industry",
  },
  neuroreaderAtStellarChance: {
    issue: "Neuroreader billed at Stellar Chance",
    source: "Scanner",
  },
};

/** Every violation issue, in the order the results tables and the rule
 * explanations list them. The one definition of each issue's name and,
 * for a check with a fixed one, its disagreeing source. */
export const VIOLATION_ISSUES: ViolationIssue[] = (
  Object.keys(VIOLATION_ISSUE_DEFINITIONS) as ViolationFlag[]
).map(
  (flag) => ({ flag, ...VIOLATION_ISSUE_DEFINITIONS[flag] }) as ViolationIssue
);

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

// The Dogfish services for the two Prodev tiers, derived from SERVICE_MAP
// like READER_SERVICES above.
const PRODEV_TIER_1_SERVICE = Object.keys(SERVICE_MAP).find(
  (service) => SERVICE_MAP[service] === "humanMRIProdevTier1"
)!;
const PRODEV_TIER_2_SERVICE = Object.keys(SERVICE_MAP).find(
  (service) => SERVICE_MAP[service] === "humanMRIProdevTier2"
)!;

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

/** True when a Scan Time's date is on or after `date` ("YYYY-MM-DD").
 * Scan Time starts with "YYYY-MM-DD", which compares correctly as text.
 * A Scan Time with no such date also returns true, so a check gated on
 * a date still runs and can flag the event, instead of hiding it. */
function isOnOrAfter(scanTime: string, date: string): boolean {
  const scanDate = scanTime.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  return scanDate === undefined || scanDate >= date;
}

/** True when a raw protocol number has one of the expected formats (see
 * above). The audit and the Contrast Injection Tool both flag a number
 * that does not as a mismatch. */
export function isValidProtocolFormat(rawProtocolNumber: string): boolean {
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

export interface DogfishEvent {
  eventId: string;
  protocolNumberRaw: string;
  scanTime: string;
  projectTitle: string;
  scanner: string;
  flags: ServiceFlags;
  /** The Dogfish services of the event's rows, each once, in row order. */
  services: string[];
  neuroreaderAtStellarChance: boolean;
}

/** Groups the Dogfish rows into events by Event ID, with the services
 * of every row of the event as flags. No-show rows are left out. */
export function buildDogfishEvents(dogfishRows: CsvRow[]): DogfishEvent[] {
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
      if (!existing.services.includes(service)) existing.services.push(service);
      existing.neuroreaderAtStellarChance ||= rowNeuroreaderAtStellarChance;
    } else {
      eventsById.set(eventId, {
        eventId,
        protocolNumberRaw,
        scanTime,
        projectTitle,
        scanner,
        flags: rowFlags,
        services: [service],
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

/** Every raw Dogfish row billed at the external MRI rate, under either
 * of its labels, on any scanner. Like buildScannerEvents, this is not
 * grouped or deduped, and includes no-shows. */
function buildHumanMriExternalEvents(
  dogfishRows: CsvRow[]
): HumanMriExternalEventRow[] {
  const rows: HumanMriExternalEventRow[] = [];

  for (const row of dogfishRows) {
    const service = field(row, "Service");
    if (!HUMAN_MRI_EXTERNAL_SERVICES.has(service)) continue;

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
  // like the JSON keys dedupeMismatches uses — so no delimiter can
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

/** True when `service` is an MRI service, at any rate. */
export function isMriService(service: string): boolean {
  const flag = SERVICE_MAP[service];
  if (!flag) return false;
  const flags = emptyFlags();
  flags[flag] = true;
  return hasMriService(flags);
}

/** True when the event billed an MRI service, at any rate. */
export function hasMriService(flags: ServiceFlags): boolean {
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
    // Either rate of a fee — the standard service or its industry
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

/** Reports every event that bills a Stimulus or Neuroreader fee, at
 * either rate, on an external protocol. External protocols should never
 * bill these fees. No data source outside Dogfish marks a protocol as
 * external, so a protocol counts as external for an event when either:
 * - the event itself bills the external MRI rate, under either label, or
 * - some other Dogfish event in the upload bills that same protocol at
 *   the external rate.
 * The second test also catches a fee on an event whose MRI line was
 * wrongly billed at another rate. Protocols are matched by their exact,
 * un-normalized Dogfish Protocol Number, the same way
 * buildNoShowsOnProdevProtocols matches them: normalization would merge
 * different protocols that share a 6-digit base. `events` holds only the
 * non-no-show billing, so no-shows are left out. */
function buildFeesOnExternalProtocols(
  events: DogfishEvent[]
): FeeOnExternalProtocolRow[] {
  const externalProtocols = new Set<string>();
  for (const event of events) {
    if (event.flags.humanMRIExternal) {
      externalProtocols.add(event.protocolNumberRaw);
    }
  }

  const rows: FeeOnExternalProtocolRow[] = [];

  for (const event of events) {
    const { flags } = event;
    const billedExternalHere = flags.humanMRIExternal;
    if (!billedExternalHere && !externalProtocols.has(event.protocolNumberRaw)) {
      continue;
    }

    // Either rate of a fee — the standard service or its industry
    // variant — counts as that fee being billed. The names match the
    // columns of the Add-On Fees Without MRI table.
    const feesBilled: string[] = [];
    if (flags.stimulus || flags.stimulusIndustry) feesBilled.push("Stimulus");
    if (flags.neuroreader || flags.neuroreaderIndustry) {
      feesBilled.push("Neuroreader");
    }
    if (feesBilled.length === 0) continue;

    rows.push({
      eventId: event.eventId,
      protocolNumber: event.protocolNumberRaw,
      projectTitle: event.projectTitle,
      scanTime: event.scanTime,
      scanner: event.scanner,
      feesBilled: feesBilled.join(", "),
      externalRateBilledOn: billedExternalHere ? "This event" : "Another event",
    });
  }

  rows.sort(
    (a, b) =>
      compareNumericText(a.protocolNumber, b.protocolNumber) ||
      a.scanTime.localeCompare(b.scanTime) ||
      compareNumericText(a.eventId, b.eventId)
  );

  return rows;
}

/** The Dogfish service names of the Prodev tiers billed on an event, in
 * tier order. Empty when the event billed neither tier. */
function billedProdevTiers(flags: ServiceFlags): string[] {
  const tiers: string[] = [];
  if (flags.humanMRIProdevTier1) tiers.push(PRODEV_TIER_1_SERVICE);
  if (flags.humanMRIProdevTier2) tiers.push(PRODEV_TIER_2_SERVICE);
  return tiers;
}

/** Checks each event's Prodev-tier billing against its protocol number's
 * naming. The "-P"/"_P"/"Prodev" ending does not say which tier, so both
 * tiers count as one "Prodev" concept for this check. */
function buildProdevConsistencyIssues(
  events: DogfishEvent[]
): ProdevConsistencyRow[] {
  const rows: ProdevConsistencyRow[] = [];

  for (const event of events) {
    const { protocolNumberRaw } = event;
    const billedTiers = billedProdevTiers(event.flags);

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

/** Reports every "No Show/Cancellation Fee" event whose protocol is a
 * Prodev protocol. A protocol counts as Prodev when either:
 * - its raw Dogfish Protocol Number has the Prodev ending
 *   (PRODEV_PROTOCOL_SUFFIX, the same test the Prodev naming check uses), or
 * - some other Dogfish event in the upload billed that same protocol at
 *   a Prodev tier (the same Prodev-tier flags the naming check reads).
 * Protocols are matched by their exact, un-normalized Dogfish Protocol
 * Number, because normalization strips the "-P" that separates a Prodev
 * protocol from its parent. No-show rows are grouped into events by
 * Event ID; a row with a blank Event ID or blank Protocol Number is
 * skipped, as it cannot be tied to an event or protocol. */
function buildNoShowsOnProdevProtocols(
  dogfishRows: CsvRow[],
  events: DogfishEvent[]
): NoShowOnProdevRow[] {
  // `events` holds only the non-no-show billing, so this is the Prodev
  // tiers each protocol was billed at by its real scans.
  const prodevTiersByProtocol = new Map<string, Set<string>>();
  for (const event of events) {
    for (const tier of billedProdevTiers(event.flags)) {
      const tiers = prodevTiersByProtocol.get(event.protocolNumberRaw);
      if (tiers) tiers.add(tier);
      else prodevTiersByProtocol.set(event.protocolNumberRaw, new Set([tier]));
    }
  }

  const rows: NoShowOnProdevRow[] = [];
  const seenEventIds = new Set<string>();

  for (const row of dogfishRows) {
    if (field(row, "Service") !== NO_SHOW_SERVICE) continue;

    const eventId = field(row, "Event ID");
    if (eventId === "" || seenEventIds.has(eventId)) continue;

    const protocolNumber = field(row, "Protocol Number");
    if (protocolNumber === "") continue;

    const prodevSuffix = PRODEV_PROTOCOL_SUFFIX.test(protocolNumber);
    const prodevTiers = prodevTiersByProtocol.get(protocolNumber);
    if (!prodevSuffix && !prodevTiers) continue;

    seenEventIds.add(eventId);
    rows.push({
      eventId,
      protocolNumber,
      projectTitle: field(row, "Project Title"),
      scanTime: field(row, "Scan Time"),
      scanner: field(row, "Scanner"),
      prodevSuffix,
      prodevBilledOnProtocol: prodevTiers !== undefined,
      prodevServicesBilled: [
        PRODEV_TIER_1_SERVICE,
        PRODEV_TIER_2_SERVICE,
      ]
        .filter((tier) => prodevTiers?.has(tier))
        .join(", "),
    });
  }

  rows.sort(
    (a, b) =>
      a.protocolNumber.localeCompare(b.protocolNumber) ||
      a.scanTime.localeCompare(b.scanTime) ||
      a.eventId.localeCompare(b.eventId)
  );

  return rows;
}

export interface RedcapRecord {
  neuroreader: boolean;
  stimulus: boolean;
  /** Whether REDCap's funding type is an industry code. `undefined` when
   * the funding type is blank, so REDCap cannot say. */
  industry: boolean | undefined;
  /** Whether the PI's school is CHOP. */
  chop: boolean;
}

const REDCAP_REVIEW_LETTER_COMPLETE = "2";
const REDCAP_CHECKED = "1";

// The funding_type codes that mean industry funding: 1 is "industry" and
// 4 is "industry funding". Every other code (for example 2, an old code
// for government) is not industry.
const REDCAP_INDUSTRY_FUNDING_TYPES = new Set(["1", "4"]);

// The pi_school code for CHOP. A non-industry CHOP study is billed
// Human MRI (Industry/CHOP), but pays the standard ancillary fees.
const REDCAP_CHOP_PI_SCHOOL = "4";

/** Whether a REDCap funding_type code means industry funding, or
 * `undefined` for a blank code. */
function redcapIndustry(fundingType: string): boolean | undefined {
  return fundingType === ""
    ? undefined
    : REDCAP_INDUSTRY_FUNDING_TYPES.has(fundingType);
}

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
      industry: redcapIndustry(field(row, "funding_type")),
      chop: field(row, "pi_school") === REDCAP_CHOP_PI_SCHOOL,
    };

    for (const name of names) {
      const owner = ownerByName.get(name);
      const sameRow = owner?.rawIrb === rawIrb;
      const sameNameSet =
        owner !== undefined &&
        owner.names.size === nameSet.size &&
        [...owner.names].every((n) => nameSet.has(n));

      if (owner !== undefined && !sameRow && !sameNameSet) {
        const collisionKey = [owner.rawIrb, rawIrb].sort().join("\u0000") + "\u0000" + name;
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

/** Negates a source's answer, keeping "no answer" (undefined) as is. */
function not(answer: boolean | undefined): boolean | undefined {
  return answer === undefined ? undefined : !answer;
}

/** Names the sources that disagree with the billed rate, for one rate
 * check. `applies` is whether the event billed the rate this check is
 * about. `camsDisagrees` and `redcapDisagrees` are whether each source
 * says that rate is wrong for the protocol, or undefined when that source
 * has no answer. A source with no answer never disagrees. When neither
 * source has an answer, the check cannot run, so the result is
 * undefined and the event lands on the Mismatches table. */
function rateDisagreement(
  applies: boolean,
  camsDisagrees: boolean | undefined,
  redcapDisagrees: boolean | undefined
): RateDisagreement | undefined {
  if (camsDisagrees === undefined && redcapDisagrees === undefined) {
    return undefined;
  }
  if (!applies) return "";
  if (camsDisagrees && redcapDisagrees) return "CAMS + REDCap";
  if (camsDisagrees) return "CAMS";
  if (redcapDisagrees) return "REDCap";
  return "";
}

/** True when the event billed an MRI service at the Industry/CHOP rate.
 * Only these two services count as industry billing (see README, "A
 * service flag is not automatically industry"). */
export function billedIndustryRate(flags: ServiceFlags): boolean {
  return flags.humanMRIIndustry || flags.animalMRIIndustry;
}

/** What the MRI rate billed on an event says about the protocol's
 * industry sponsorship, as a third source beside CAMS and REDCap. The
 * Contrast Injection Tool uses it; it reads the rate the same way the
 * audit's MRI rate checks do.
 *
 * - `true`: billed at the Industry/CHOP rate, on a study that is not
 *   CHOP.
 * - `false`: billed at any other MRI rate except the external one.
 * - `undefined`: no answer. The event has no MRI service; or it billed
 *   the external rate, which serves external users whether or not they
 *   are industry; or it billed the Industry/CHOP rate on a CHOP study,
 *   where that rate is correct whether or not the study is industry. */
export function mriServiceIndustry(
  flags: ServiceFlags,
  chop: boolean
): boolean | undefined {
  if (!hasMriService(flags) || flags.humanMRIExternal) return undefined;
  if (billedIndustryRate(flags)) return chop ? undefined : true;
  return false;
}

function computeFlags(
  event: DogfishEvent,
  cams: CamsRecord | undefined,
  redcap: RedcapRecord | undefined
): ComputedFlags {
  const { flags, protocolNumberRaw } = event;
  const billedIndustry = billedIndustryRate(flags);
  const animalFormat = isAnimalProtocolFormat(protocolNumberRaw);

  // Each source's answer to "is this protocol industry-sponsored?", or
  // undefined when that source has no answer: no CAMS record, or no
  // REDCap record or a blank REDCap funding type. The CAMS test is the
  // same one classifyIndustry() applies (see cams.ts).
  const camsIndustry = cams ? cams.industrySponsored === "Yes" : undefined;
  const redcapIndustry = redcap?.industry;

  // REDCap is the only source that marks a CHOP study. A non-industry
  // CHOP study is billed Human MRI (Industry/CHOP), so that rate is not
  // an error on it. CHOP studies pay the standard ancillary fees, so the
  // fee checks do not look at this.
  const chop = redcap?.chop === true;

  // The external MRI rate serves external users, industry or not, so
  // industry sponsorship cannot say whether it is right. An event billed
  // at it is never flagged as industry billed as government. A person
  // reviews every external event on the Human MRI (Industry/External)
  // Events table instead.
  const billedExternal = flags.humanMRIExternal;

  // Either rate of an ancillary fee — the standard service or its
  // industry variant — counts as that fee being billed for the REDCap
  // approved-vs-billed reconciliation below. The rate-vs-sponsorship
  // check further down is what looks at which rate it was.
  const stimulusBilled = flags.stimulus || flags.stimulusIndustry;
  const readerBilled = flags.neuroreader || flags.neuroreaderIndustry;

  // A standard ancillary fee on an industry-sponsored protocol is only
  // wrong once the industry fee rates exist.
  const industryFeeRateInEffect = isOnOrAfter(
    event.scanTime,
    INDUSTRY_FEE_RATE_START
  );

  // Scans on the Stellar Chance scanners should not have Neuroreader
  // services, so a missing Neuroreader charge there is expected and not
  // flagged as missed billing.
  const atStellarChance = STELLAR_CHANCE_SCANNERS.has(event.scanner);

  return {
    // The MRI rate should be an industry rate when, and only when, the
    // protocol is industry-sponsored or a CHOP study. Each rate check
    // compares the billed rate with CAMS and with REDCap, and names the
    // sources that disagree (see rateDisagreement).
    industryBilledAsGovernment: rateDisagreement(
      !billedIndustry && !billedExternal,
      camsIndustry,
      redcapIndustry
    ),
    governmentBilledAsIndustry: rateDisagreement(
      billedIndustry && !chop,
      not(camsIndustry),
      not(redcapIndustry)
    ),
    chopBilledAsStandard: redcap
      ? chop && flags.humanMRI && !billedIndustry
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
    // An ancillary fee should carry its industry rate when, and only
    // when, the protocol is industry-sponsored. These mirror
    // industryBilledAsGovernment / governmentBilledAsIndustry above, but
    // scoped to the specific fee billed on this event, and without the
    // CHOP exception. The industry-rate ancillary flags are deliberately
    // kept out of billedIndustry (see README) — these checks are the
    // only place they are read. "Billed as government" is checked only
    // from INDUSTRY_FEE_RATE_START on; "billed as industry" has no date
    // limit.
    stimulusBilledAsGovernment: rateDisagreement(
      flags.stimulus && industryFeeRateInEffect,
      camsIndustry,
      redcapIndustry
    ),
    stimulusBilledAsIndustry: rateDisagreement(
      flags.stimulusIndustry,
      not(camsIndustry),
      not(redcapIndustry)
    ),
    neuroreaderBillingMissed: redcap
      ? !readerBilled && redcap.neuroreader && !atStellarChance
      : undefined,
    neuroreaderBillingExtra: redcap
      ? readerBilled && !redcap.neuroreader
      : undefined,
    neuroreaderBilledAsGovernment: rateDisagreement(
      flags.neuroreader && industryFeeRateInEffect,
      camsIndustry,
      redcapIndustry
    ),
    neuroreaderBilledAsIndustry: rateDisagreement(
      flags.neuroreaderIndustry,
      not(camsIndustry),
      not(redcapIndustry)
    ),
    neuroreaderAtStellarChance: event.neuroreaderAtStellarChance,
  };
}

/** Compares two identifiers so that runs of digits sort by number: "9"
 * comes before "10". */
function compareNumericText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/** The disagreeing source of one issue on one event, or undefined when
 * the event does not have that issue. A check with a fixed source takes
 * it from its definition; a rate check's value names its sources. */
function issueSource(
  violation: ViolationRow,
  definition: ViolationIssue
): DisagreeingSource | undefined {
  if (definition.source !== undefined) {
    return violation[definition.flag] ? definition.source : undefined;
  }
  return violation[definition.flag] || undefined;
}

/** Splits each violation into one row per flagged check, so that each row is
 * one error on one event. Rows are sorted by Event ID, then by issue in
 * VIOLATION_ISSUES order. */
function buildViolationIssues(violations: ViolationRow[]): ViolationIssueRow[] {
  const ranked: { row: ViolationIssueRow; rank: number }[] = [];

  for (const violation of violations) {
    VIOLATION_ISSUES.forEach((definition, rank) => {
      const source = issueSource(violation, definition);
      if (source === undefined) return;
      ranked.push({
        row: {
          eventId: violation.eventId,
          protocolNumber: violation.protocolNumber,
          scanTime: violation.scanTime,
          scanner: violation.scanner,
          issue: definition.issue,
          source,
        },
        rank,
      });
    });
  }

  ranked.sort(
    (a, b) =>
      compareNumericText(a.row.eventId, b.row.eventId) || a.rank - b.rank
  );
  return ranked.map(({ row }) => row);
}

/** Groups the violations by raw protocol number and issue, one row per
 * pair, with the number of distinct events and the first and last Scan
 * Time among them. Scan Time compares as text, which puts
 * "YYYY-MM-DD HH:MM:SS" values in time order; blank values are ignored.
 * Rows are sorted by protocol number, then by issue in VIOLATION_ISSUES
 * order. */
function buildProtocolIssues(violations: ViolationRow[]): ProtocolIssueRow[] {
  interface Group {
    protocolNumber: string;
    issue: string;
    source: DisagreeingSource;
    rank: number;
    eventIds: Set<string>;
    firstScan: string;
    lastScan: string;
  }

  // The key is a JSON array, like the JSON keys dedupeMismatches uses, so
  // no delimiter can collide with a character inside the protocol number.
  const groups = new Map<string, Group>();

  for (const violation of violations) {
    VIOLATION_ISSUES.forEach((definition, rank) => {
      const source = issueSource(violation, definition);
      if (source === undefined) return;

      // A rate check's source is part of the key: in principle one
      // protocol's events could disagree with different sources.
      const key = JSON.stringify([
        violation.protocolNumber,
        definition.flag,
        source,
      ]);
      let group = groups.get(key);
      if (!group) {
        group = {
          protocolNumber: violation.protocolNumber,
          issue: definition.issue,
          source,
          rank,
          eventIds: new Set(),
          firstScan: "",
          lastScan: "",
        };
        groups.set(key, group);
      }

      group.eventIds.add(violation.eventId);
      const { scanTime } = violation;
      if (scanTime === "") return;
      if (group.firstScan === "" || scanTime < group.firstScan) {
        group.firstScan = scanTime;
      }
      if (group.lastScan === "" || scanTime > group.lastScan) {
        group.lastScan = scanTime;
      }
    });
  }

  return [...groups.values()]
    .sort(
      (a, b) =>
        compareNumericText(a.protocolNumber, b.protocolNumber) ||
        a.rank - b.rank
    )
    .map((group) => ({
      protocolNumber: group.protocolNumber,
      issue: group.issue,
      source: group.source,
      events: group.eventIds.size,
      firstScan: group.firstScan,
      lastScan: group.lastScan,
    }));
}

/** Removes Event ID from each mismatch. It then collapses the rows into
 * groups of unique remaining fields, one row per distinct protocol and
 * mismatch-flag combination. */
function dedupeMismatches(mismatches: MismatchRow[]): DedupedMismatchRow[] {
  const seen = new Map<string, DedupedMismatchRow>();

  for (const { eventId: _eventId, ...rest } of mismatches) {
    const key = JSON.stringify(rest);
    if (!seen.has(key)) seen.set(key, rest);
  }

  return [...seen.values()];
}

/** True when any check flagged the event: a boolean check that is true,
 * or a rate check that names at least one disagreeing source. */
function hasAnyViolation(computed: ComputedFlags): boolean {
  return Object.values(computed).some(
    (value) => value === true || (typeof value === "string" && value !== "")
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
    const noRedcapFundingType =
      redcap !== undefined && redcap.industry === undefined;
    const invalidProtocolFormat = !validFormat;

    if (
      noCamsMatch ||
      noActiveRedcapMatch ||
      noRedcapFundingType ||
      invalidProtocolFormat
    ) {
      mismatches.push({
        eventId: event.eventId,
        protocolNumber: event.protocolNumberRaw,
        projectTitle: event.projectTitle,
        noCamsMatch,
        noActiveRedcapMatch,
        noRedcapFundingType,
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
        industryBilledAsGovernment: computed.industryBilledAsGovernment ?? "",
        governmentBilledAsIndustry: computed.governmentBilledAsIndustry ?? "",
        chopBilledAsStandard: computed.chopBilledAsStandard === true,
        animalBilledAsHuman: computed.animalBilledAsHuman,
        humanBilledAsAnimal: computed.humanBilledAsAnimal,
        stimulusBillingMissed: computed.stimulusBillingMissed === true,
        stimulusBillingExtra: computed.stimulusBillingExtra === true,
        stimulusBilledAsGovernment: computed.stimulusBilledAsGovernment ?? "",
        stimulusBilledAsIndustry: computed.stimulusBilledAsIndustry ?? "",
        neuroreaderBillingMissed: computed.neuroreaderBillingMissed === true,
        neuroreaderBillingExtra: computed.neuroreaderBillingExtra === true,
        neuroreaderBilledAsGovernment:
          computed.neuroreaderBilledAsGovernment ?? "",
        neuroreaderBilledAsIndustry: computed.neuroreaderBilledAsIndustry ?? "",
        neuroreaderAtStellarChance: computed.neuroreaderAtStellarChance,
      });
    }
  }

  return {
    violations,
    violationIssues: buildViolationIssues(violations),
    protocolIssues: buildProtocolIssues(violations),
    mismatches,
    dedupedMismatches: dedupeMismatches(mismatches),
    excessLateCancellations: buildExcessLateCancellations(dogfishRows),
    noShowsOnProdevProtocols: buildNoShowsOnProdevProtocols(
      dogfishRows,
      events
    ),
    scannerEvents: buildScannerEvents(dogfishRows),
    humanMriExternalEvents: buildHumanMriExternalEvents(dogfishRows),
    prodevConsistencyIssues: buildProdevConsistencyIssues(events),
    addOnsWithoutMri: buildAddOnsWithoutMri(events),
    feesOnExternalProtocols: buildFeesOnExternalProtocols(events),
  };
}
