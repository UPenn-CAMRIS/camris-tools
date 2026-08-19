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
  scanTime: string;
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
  neuroreaderAtStellarChance: boolean;
}

/** Same violation flags as ViolationRow, but deduped across events: one row
 * per distinct (protocol number, violation flags) combination, dropping
 * Event ID and Scan Time (both unique per event, so keeping either would
 * defeat the dedup). Useful for seeing which protocols have a given
 * violation type without one row per billing event. */
export type DedupedViolationRow = Omit<ViolationRow, "eventId" | "scanTime">;

export interface MismatchRow {
  eventId: string;
  protocolNumber: string;
  noCamsMatch: boolean;
  noActiveRedcapMatch: boolean;
  invalidProtocolFormat: boolean;
}

/** Same mismatch flags as MismatchRow, but deduped across events: one row
 * per distinct (protocol number, mismatch flags) combination, dropping
 * Event ID. */
export type DedupedMismatchRow = Omit<MismatchRow, "eventId">;

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

/** A Dogfish event (grouped by Event ID, no-shows excluded) that billed a
 * Stimulus and/or Neuroreader add-on fee but no main MRI service code —
 * these fees are meant to ride along with a scan, so one appearing alone is
 * a data-quality flag independent of the CAMS/RedCap checks. */
export interface AddOnWithoutMriRow {
  eventId: string;
  protocolNumber: string;
  stimulus: boolean;
  neuroreader: boolean;
}

export interface AuditResult {
  violations: ViolationRow[];
  dedupedViolations: DedupedViolationRow[];
  mismatches: MismatchRow[];
  dedupedMismatches: DedupedMismatchRow[];
  scannerEvents: ScannerEventRow[];
  addOnsWithoutMri: AddOnWithoutMriRow[];
}
