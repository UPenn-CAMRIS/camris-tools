export interface ServiceFlags {
  humanMRI: boolean;
  humanMRIIndustry: boolean;
  humanMRIExVivo: boolean;
  humanMRIExternal: boolean;
  humanMRIAfterHours: boolean;
  humanMRIProdevTier1: boolean;
  humanMRIProdevTier2: boolean;
  animalMRI: boolean;
  animalMRIIndustry: boolean;
  stimulus: boolean;
  neuroreader: boolean;
}

export interface ViolationRow {
  eventId: string;
  protocolNumber: string;
  scanTime: string;
  scanner: string;
  industryBilledAsGovernment: boolean;
  governmentBilledAsIndustry: boolean;
  animalBilledAsHuman: boolean;
  humanBilledAsAnimal: boolean;
  stimulusBillingMissed: boolean;
  stimulusBillingExtra: boolean;
  neuroreaderBillingMissed: boolean;
  neuroreaderBillingExtra: boolean;
  neuroreaderAtStellarChance: boolean;
}

/**
 * On a boolean-ish field, `undefined` means the check was not computed.
 * This happens when the source data needed for the check is missing.
 * `undefined` does not mean `false`. `false` means the check ran and found
 * no violation.
 *
 * ViolationRow only ever holds `true` or `false` values. If any field
 * would be `undefined`, the audit cannot conclusively flag that row as a
 * violation. The row appears on the mismatch report instead.
 */
export interface ComputedFlags {
  industryBilledAsGovernment: boolean | undefined;
  governmentBilledAsIndustry: boolean | undefined;
  animalBilledAsHuman: boolean;
  humanBilledAsAnimal: boolean;
  stimulusBillingMissed: boolean | undefined;
  stimulusBillingExtra: boolean | undefined;
  neuroreaderBillingMissed: boolean | undefined;
  neuroreaderBillingExtra: boolean | undefined;
  neuroreaderAtStellarChance: boolean;
}

/** Holds the same violation flags as ViolationRow, but with one row per
 * distinct protocol and violation-flag combination. It drops Event ID
 * and Scan Time, since both are unique per event and would prevent any
 * grouping. It also drops Scanner, since a protocol can be scanned on
 * more than one scanner across its events. Use this type to see which
 * protocols have a given violation, without one row per billing event. */
export type DedupedViolationRow = Omit<
  ViolationRow,
  "eventId" | "scanTime" | "scanner"
>;

export interface MismatchRow {
  eventId: string;
  protocolNumber: string;
  projectTitle: string;
  noCamsMatch: boolean;
  noActiveRedcapMatch: boolean;
  invalidProtocolFormat: boolean;
}

/** Holds the same mismatch flags as MismatchRow, but with one row per
 * distinct protocol and mismatch-flag combination. It drops Event ID. */
export type DedupedMismatchRow = Omit<MismatchRow, "eventId">;

/** One row per raw Dogfish CSV row on the target scanner. Unlike the
 * violation and mismatch tables, this list is not deduped or grouped by
 * Event ID. It also includes no-show and cancellation rows, which the
 * audit rules otherwise ignore. */
export interface ScannerEventRow {
  eventId: string;
  protocolNumber: string;
  projectTitle: string;
  service: string;
  scanTime: string;
  quantity: string;
  mandatoryService: string;
  schedulingUser: string;
  checkInUser: string;
}

/** A Dogfish event that billed a Stimulus fee, a Neuroreader fee, or
 * both, but no main MRI service code. Events are grouped by Event ID,
 * and no-shows are excluded. These fees should ride along with a scan.
 * A fee with no scan is a data-quality flag, separate from the CAMS and
 * REDCap checks. */
export interface AddOnWithoutMriRow {
  eventId: string;
  protocolNumber: string;
  stimulus: boolean;
  neuroreader: boolean;
}

/** One row per raw Dogfish CSV row billed as Human MRI (External). Like
 * ScannerEventRow, this is not grouped or deduped, and includes no-shows.
 * Unlike ScannerEventRow, it is not limited to one scanner, so it carries
 * its own Scanner column. */
export interface HumanMriExternalEventRow {
  eventId: string;
  protocolNumber: string;
  projectTitle: string;
  scanner: string;
  service: string;
  scanTime: string;
  quantity: string;
  mandatoryService: string;
  schedulingUser: string;
  checkInUser: string;
}

/** A protocol identifier found on two different REDCap rows whose full
 * set of identifiers does not otherwise match — REDCap's free-text
 * protocol field can name more than one protocol, and identifiers are
 * assumed unique to one protocol, so this is a data problem, not a
 * normal multi-row resubmission. */
export interface RedcapNameCollision {
  name: string;
  protocolFields: [string, string];
}

/** A Dogfish event whose Prodev-tier billing and protocol-number naming
 * disagree — either it billed a Prodev tier (1 or 2) without a matching
 * "-P"/"_P"/"Prodev" ending on its protocol number, or its protocol
 * number has that ending without either tier billed. The suffix does
 * not distinguish Tier 1 from Tier 2, so both checks treat the two
 * tiers as one "Prodev" concept. No-shows are excluded, like the rest
 * of the audit. */
export interface ProdevConsistencyRow {
  eventId: string;
  protocolNumber: string;
  projectTitle: string;
  scanTime: string;
  scanner: string;
  prodevServiceBilled: string;
  prodevServiceWithoutSuffix: boolean;
  suffixWithoutProdevService: boolean;
}

export interface AuditResult {
  violations: ViolationRow[];
  dedupedViolations: DedupedViolationRow[];
  mismatches: MismatchRow[];
  dedupedMismatches: DedupedMismatchRow[];
  scannerEvents: ScannerEventRow[];
  humanMriExternalEvents: HumanMriExternalEventRow[];
  prodevConsistencyIssues: ProdevConsistencyRow[];
  addOnsWithoutMri: AddOnWithoutMriRow[];
}
