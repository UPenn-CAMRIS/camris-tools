export interface ServiceFlags {
  humanMRI: boolean;
  humanMRIIndustry: boolean;
  humanMRIExVivo: boolean;
  animalMRI: boolean;
  animalMRIIndustry: boolean;
  stimulus: boolean;
  neuroreader: boolean;
}

export interface ViolationRow {
  eventId: string;
  protocolNumber: string;
  industryBilledAsGovernment: boolean;
  governmentBilledAsIndustry: boolean;
  animalBilledAsHuman: boolean;
  humanBilledAsAnimal: boolean;
  stimulusBillingMissed: boolean;
  stimulusBillingExtra: boolean;
  neuroreaderBillingMissed: boolean;
  neuroreaderBillingExtra: boolean;
}

/**
 * `undefined` on a boolean-ish field means "not computed" (the source data
 * needed to evaluate it was missing) rather than "false" (evaluated, no
 * violation). ViolationRow only ever contains `true`/`false` because a row
 * with any undefined field can't be conclusively flagged as a violation and
 * instead surfaces on the mismatch report.
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
}

/** Same violation flags as ViolationRow, but deduped across events: one row
 * per distinct (protocol number, violation flags) combination, dropping
 * Event ID. Useful for seeing which protocols have a given violation type
 * without one row per billing event. */
export type DedupedViolationRow = Omit<ViolationRow, "eventId">;

export interface MismatchRow {
  eventId: string;
  protocolNumber: string;
  noCamsMatch: boolean;
  noActiveRedcapMatch: boolean;
  invalidProtocolFormat: boolean;
}

/** One row per raw Dogfish CSV row on the target scanner — unlike the
 * violation/mismatch tables, this is not deduped or grouped by Event ID and
 * includes no-show/cancellation rows that the audit rules otherwise ignore. */
export interface ScannerEventRow {
  eventId: string;
  protocolNumber: string;
  service: string;
  scanTime: string;
  quantity: string;
  mandatoryService: string;
  schedulingUser: string;
  checkInUser: string;
}

export interface AuditResult {
  violations: ViolationRow[];
  dedupedViolations: DedupedViolationRow[];
  mismatches: MismatchRow[];
  scannerEvents: ScannerEventRow[];
}
