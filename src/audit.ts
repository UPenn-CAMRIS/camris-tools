import type { CsvRow } from "./parseCsv";
import type {
  AddOnWithoutMriRow,
  AuditResult,
  ComputedFlags,
  DedupedViolationRow,
  MismatchRow,
  ScannerEventRow,
  ServiceFlags,
  ViolationRow,
} from "./types";

const SERVICE_MAP: Record<string, keyof ServiceFlags> = {
  "Human MRI": "humanMRI",
  "Human MRI (Industry/CHOP)": "humanMRIIndustry",
  "Human MRI (Ex-vivo scanning)": "humanMRIExVivo",
  "Animal MRI": "animalMRI",
  "Animal MRI (Industry/CHOP)": "animalMRIIndustry",
  "Stimulus/Response Equipment Usage Fee": "stimulus",
  "Research Report Reader Fee": "neuroreader",
};

const NO_SHOW_SERVICE = "No Show/Cancellation Fee";
export const TARGET_SCANNER = "SC7T";

const NEUROREADER_SERVICE = "Research Report Reader Fee";
const STELLAR_CHANCE_SCANNERS = new Set(["SC3T", "SC7T"]);

// Dogfish/CAMS protocol numbers are a bare 6-digit number (optionally with a
// suffix like "_7X" that this strips), an animal protocol starting with "AR"
// followed by 6 digits, or a "xx-xxxx" (2 digits, hyphen, 4 digits) number.
const SIX_DIGIT_PREFIX = /^\d{6}/;
const ANIMAL_PROTOCOL = /^AR\d{6}/;
const YEAR_SEQUENCE_PROTOCOL = /^\d{2}-\d{4}/;
const PROTOCOL_FORMAT_PREFIXES = [
  SIX_DIGIT_PREFIX,
  ANIMAL_PROTOCOL,
  YEAR_SEQUENCE_PROTOCOL,
];

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

/** Normalizes a Dogfish/CAMS protocol number to its 6-digit base, stripping
 * suffixes. Values that don't start with 6 digits (e.g. animal protocols)
 * are returned unchanged, matching the source data's own convention. */
function normalizeDogfishCamsProtocol(rawProtocolNumber: string): string {
  const match = rawProtocolNumber.match(SIX_DIGIT_PREFIX);
  return match ? match[0] : rawProtocolNumber;
}

/** RedCap's irb_protocol_number is free text, not a clean field. If it
 * starts with a recognized protocol format, use that — handles clean values
 * and ones with trailing notes (e.g. "26-5894 (reliance agreement; penn not
 * IRB of record)"). Otherwise the number is usually embedded after other
 * text, like a PI name ("832748_Prodev"); prefer a parenthesized number
 * when present, since that's the convention this data uses to cite the
 * real protocol number when the field otherwise holds something else (e.g.
 * "CHOP_14-011487 (821881)" — the CHOP number isn't the one we want), else
 * fall back to the first standalone 6-digit run. */
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
  flags: ServiceFlags;
  neuroreaderAtStellarChance: boolean;
}

function buildDogfishEvents(dogfishRows: CsvRow[]): DogfishEvent[] {
  const eventsById = new Map<string, DogfishEvent>();

  for (const row of dogfishRows) {
    const service = (row["Service"] ?? "").trim();
    if (service === NO_SHOW_SERVICE) continue;

    const eventId = (row["Event ID"] ?? "").trim();
    if (eventId === "") continue;

    const protocolNumberRaw = (row["Protocol Number"] ?? "").trim();
    const scanner = (row["Scanner"] ?? "").trim();

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
    const scanner = (row["Scanner"] ?? "").trim();
    if (scanner !== TARGET_SCANNER) continue;

    rows.push({
      eventId: (row["Event ID"] ?? "").trim(),
      protocolNumber: (row["Protocol Number"] ?? "").trim(),
      service: (row["Service"] ?? "").trim(),
      scanTime: (row["Scan Time"] ?? "").trim(),
      quantity: (row["Quantity"] ?? "").trim(),
      mandatoryService: (row["Mandatory Service"] ?? "").trim(),
      schedulingUser: (row["Scheduling User"] ?? "").trim(),
      checkInUser: (row["Check-In User"] ?? "").trim(),
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

/** Stimulus/Neuroreader fees are meant to accompany a scan on the same
 * event. One billed with no MRI service code alongside it is a
 * data-quality flag, independent of whether it's also a CAMS/RedCap
 * mismatch or violation. */
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
    const rawProtocol = (row["Protocol Number"] ?? "").trim();
    if (rawProtocol === "") continue;

    const normalized = normalizeDogfishCamsProtocol(rawProtocol);
    // First matching record wins, matching how the RedCap side collapses
    // duplicates via "first"/"last" in the original audit logic.
    if (!lookup.has(normalized)) {
      lookup.set(normalized, {
        industrySponsored: (row["Industry Sponsored"] ?? "").trim(),
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
    const complete = (row["camris_review_letter_complete"] ?? "").trim();
    if (complete !== REDCAP_REVIEW_LETTER_COMPLETE) continue;

    const rawIrb = (row["irb_protocol_number"] ?? "").trim();
    if (rawIrb === "") continue;

    const protocolNumber = extractRedcapProtocol(rawIrb);

    // Last matching "complete" row for a protocol wins.
    lookup.set(protocolNumber, {
      neuroreader:
        (row["fees_reviewletter___2"] ?? "").trim() === REDCAP_CHECKED,
      stimulus:
        (row["fees_reviewletter___6"] ?? "").trim() === REDCAP_CHECKED,
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

function dedupeViolations(violations: ViolationRow[]): DedupedViolationRow[] {
  const seen = new Map<string, DedupedViolationRow>();

  for (const { eventId: _eventId, ...rest } of violations) {
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
    scannerEvents: buildScannerEvents(dogfishRows),
    addOnsWithoutMri: buildAddOnsWithoutMri(events),
  };
}
