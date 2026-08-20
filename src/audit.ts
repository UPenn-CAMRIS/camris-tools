import type { CsvRow } from "./parseCsv";
import type {
  AddOnWithoutMriRow,
  AuditResult,
  ComputedFlags,
  DedupedMismatchRow,
  DedupedViolationRow,
  MismatchRow,
  ScannerEventRow,
  ServiceFlags,
  ViolationRow,
} from "./types";

export const SERVICE_MAP: Record<string, keyof ServiceFlags> = {
  "Human MRI": "humanMRI",
  "Human MRI (Industry/CHOP)": "humanMRIIndustry",
  "Human MRI (Ex-vivo scanning)": "humanMRIExVivo",
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
const STELLAR_CHANCE_SCANNERS = new Set(["SC3T", "SC7T"]);

// Dogfish and CAMS protocol numbers use one of three formats:
// - a 6-digit number, optionally followed by a suffix such as "_7X"
//   (this code strips the suffix)
// - an animal protocol: "AR" followed by 6 digits
// - a "xx-xxxx" number: 2 digits, a hyphen, then 4 digits
const SIX_DIGIT_PREFIX = /^\d{6}/;
const ANIMAL_PROTOCOL = /^AR\d{6}/;
const YEAR_SEQUENCE_PROTOCOL = /^\d{2}-\d{4}/;
const PROTOCOL_FORMAT_PREFIXES = [
  SIX_DIGIT_PREFIX,
  ANIMAL_PROTOCOL,
  YEAR_SEQUENCE_PROTOCOL,
];

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

/** REDCap's irb_protocol_number field holds free text, not a clean value.
 * This function extracts the real protocol number in three steps, in order:
 *
 * 1. If the value starts with a recognized protocol format, use that. This
 *    handles clean values and values with trailing notes (for example,
 *    "26-5894 (reliance agreement; penn not IRB of record)").
 * 2. Otherwise, look for a number in parentheses. REDCap uses this to give
 *    the real protocol number when the rest of the field holds something
 *    else, such as a CHOP protocol number (for example,
 *    "CHOP_14-011487 (821881)" — 821881 is the number we want, not 011487).
 * 3. Otherwise, use the first standalone 6-digit run in the value (for
 *    example, "832748_Prodev" after a PI's name).
 */
function extractRedcapProtocol(rawIrbNumber: string): string {
  for (const pattern of PROTOCOL_FORMAT_PREFIXES) {
    const match = rawIrbNumber.match(pattern);
    if (match) return match[0];
  }

  const parenMatch = rawIrbNumber.match(/\((\d{6})\)/);
  if (parenMatch) return parenMatch[1];

  const embeddedMatch = rawIrbNumber.match(/\d{6}/);
  if (embeddedMatch) return embeddedMatch[0];

  return rawIrbNumber;
}

interface DogfishEvent {
  eventId: string;
  protocolNumberRaw: string;
  scanTime: string;
  projectTitle: string;
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

function hasMriService(flags: ServiceFlags): boolean {
  return (
    flags.humanMRI ||
    flags.humanMRIIndustry ||
    flags.humanMRIExVivo ||
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

function buildRedcapLookup(redcapRows: CsvRow[]): Map<string, RedcapRecord> {
  const lookup = new Map<string, RedcapRecord>();

  for (const row of redcapRows) {
    const complete = field(row, "camris_review_letter_complete");
    if (complete !== REDCAP_REVIEW_LETTER_COMPLETE) continue;

    const rawIrb = field(row, "irb_protocol_number");
    if (rawIrb === "") continue;

    const protocolNumber = extractRedcapProtocol(rawIrb);

    // The last matching "complete" row for a protocol wins.
    lookup.set(protocolNumber, {
      neuroreader: field(row, "fees_reviewletter___2") === REDCAP_CHECKED,
      stimulus: field(row, "fees_reviewletter___6") === REDCAP_CHECKED,
    });
  }

  return lookup;
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
      (flags.humanMRI || flags.humanMRIIndustry) && animalFormat,
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

/** Removes Event ID and Scan Time from each violation. It then collapses
 * the rows into groups of unique remaining fields. Event ID and Scan Time
 * are both unique per event, so keeping either field would prevent any
 * grouping. Use this function to turn a per-event table into a
 * per-protocol table. */
function dedupeViolations(violations: ViolationRow[]): DedupedViolationRow[] {
  const seen = new Map<string, DedupedViolationRow>();

  for (const { eventId: _eventId, scanTime: _scanTime, ...rest } of violations) {
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
  const redcapLookup = buildRedcapLookup(redcapRows);

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
    addOnsWithoutMri: buildAddOnsWithoutMri(events),
  };
}
