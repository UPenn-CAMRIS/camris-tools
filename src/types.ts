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
  stimulusIndustry: boolean;
  neuroreader: boolean;
  neuroreaderIndustry: boolean;
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
  stimulusBilledAsGovernment: boolean;
  stimulusBilledAsIndustry: boolean;
  neuroreaderBillingMissed: boolean;
  neuroreaderBillingExtra: boolean;
  neuroreaderBilledAsGovernment: boolean;
  neuroreaderBilledAsIndustry: boolean;
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
  stimulusBilledAsGovernment: boolean | undefined;
  stimulusBilledAsIndustry: boolean | undefined;
  neuroreaderBillingMissed: boolean | undefined;
  neuroreaderBillingExtra: boolean | undefined;
  neuroreaderBilledAsGovernment: boolean | undefined;
  neuroreaderBilledAsIndustry: boolean | undefined;
  neuroreaderAtStellarChance: boolean;
}

/** The ViolationRow fields that each hold one violation check's result:
 * every boolean field. A new boolean field on ViolationRow is a new
 * flag, and VIOLATION_ISSUES in audit.ts must then define its issue. */
export type ViolationFlag = {
  [K in keyof ViolationRow]: ViolationRow[K] extends boolean ? K : never;
}[keyof ViolationRow];

/** The data that disagrees with what Dogfish billed, for one violation
 * issue: CAMS industry sponsorship, the protocol number's animal or human
 * format, the fees on the approved REDCap review letter, or the scanner
 * the event ran on. */
export type DisagreeingSource =
  | "CAMS"
  | "Protocol format"
  | "REDCap letter"
  | "Scanner";

/** One violation check, as the results tables name it. */
export interface ViolationIssue {
  flag: ViolationFlag;
  issue: string;
  source: DisagreeingSource;
}

/** One violation on one Dogfish event: one row for each true flag on a
 * ViolationRow. An event with two violations gets two rows, with its
 * Event ID, Protocol Number, Scan Time, and Scanner repeated on each. */
export interface ViolationIssueRow {
  eventId: string;
  protocolNumber: string;
  scanTime: string;
  scanner: string;
  issue: string;
  source: DisagreeingSource;
}

/** One violation issue on one protocol, over all of its events. Protocols
 * are grouped by their exact, un-normalized Dogfish Protocol Number. A
 * protocol with two different issues gets two rows. */
export interface ProtocolIssueRow {
  protocolNumber: string;
  issue: string;
  source: DisagreeingSource;
  /** The number of distinct Event IDs with this issue on this protocol. */
  events: number;
  /** The earliest and latest Scan Time of those events, compared as text.
   * A blank Scan Time is ignored; "" when every one is blank. */
  firstScan: string;
  lastScan: string;
}

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
 * REDCap checks. Either rate of a fee — the standard service or its
 * industry variant — sets that fee's column to true here. */
export interface AddOnWithoutMriRow {
  eventId: string;
  protocolNumber: string;
  stimulus: boolean;
  neuroreader: boolean;
}

/** One row per raw Dogfish CSV row billed at the external MRI rate, under
 * its current label "Human MRI (industry/external)" or its old label
 * "Human MRI (external)". Like ScannerEventRow, this is not grouped or
 * deduped, and includes no-shows.
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

/** A "No Show/Cancellation Fee" event that is over its protocol's monthly
 * late-cancellation allowance. Each protocol is allowed a fixed number of
 * such events per calendar month (LATE_CANCELLATION_ALLOWANCE in
 * audit.ts), the month taken from Scan Time. Protocols are grouped by
 * their exact, un-normalized Dogfish Protocol Number, and cancellation
 * rows are grouped into events by Event ID. Within a protocol-month the
 * events are ordered by Scan Time, then Event ID; the first
 * LATE_CANCELLATION_ALLOWANCE are treated as within allowance and every
 * later one gets a row here. A cancellation row with a blank Event ID, or
 * a Scan Time with no "YYYY-MM" prefix, cannot be placed and is left out. */
export interface LateCancellationRow {
  protocolNumber: string;
  /** Calendar month of the event, "YYYY-MM", from Scan Time. */
  month: string;
  eventId: string;
  scanTime: string;
  scanner: string;
  projectTitle: string;
  /** Total late-cancellation events for this protocol in this month,
   * including the ones within allowance. */
  cancellationsInMonth: number;
}

/** A "No Show/Cancellation Fee" event billed to a Prodev protocol. A
 * protocol counts as Prodev when its raw Dogfish Protocol Number ends
 * with "-P", "_P", or "Prodev" (the same ending the Prodev naming check
 * tests), or when another Dogfish event in the upload billed that exact
 * protocol number at a Prodev tier. Protocols are matched by their
 * exact, un-normalized number. No-show rows are grouped into events by
 * Event ID, one row per event. */
export interface NoShowOnProdevRow {
  eventId: string;
  protocolNumber: string;
  projectTitle: string;
  scanTime: string;
  scanner: string;
  /** The protocol number has the Prodev ending. */
  prodevSuffix: boolean;
  /** Another event billed this protocol at a Prodev tier. */
  prodevBilledOnProtocol: boolean;
  /** The Prodev-tier services billed on the protocol's other events,
   * comma-separated; "" when there were none. */
  prodevServicesBilled: string;
}

export interface AuditResult {
  violations: ViolationRow[];
  violationIssues: ViolationIssueRow[];
  protocolIssues: ProtocolIssueRow[];
  mismatches: MismatchRow[];
  dedupedMismatches: DedupedMismatchRow[];
  excessLateCancellations: LateCancellationRow[];
  noShowsOnProdevProtocols: NoShowOnProdevRow[];
  scannerEvents: ScannerEventRow[];
  humanMriExternalEvents: HumanMriExternalEventRow[];
  prodevConsistencyIssues: ProdevConsistencyRow[];
  addOnsWithoutMri: AddOnWithoutMriRow[];
}
