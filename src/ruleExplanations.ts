import { INDUSTRY_FEE_RATE_START, VIOLATION_ISSUES } from "./audit";
import type { ViolationFlag } from "./types";

export interface RuleExplanation {
  label: string;
  description: string;
}

// The description of each violation issue. Its label is the issue name
// from VIOLATION_ISSUES, so the two cannot drift apart, and the Record
// type makes the compiler reject a flag with no description.
const VIOLATION_DESCRIPTIONS: Record<
  ViolationFlag,
  Omit<RuleExplanation, "label">
> = {
  industryBilledAsGovernment: {
    description:
      'A Dogfish event for the protocol was billed at a non-industry MRI rate, but CAMS ("Industry Sponsored" is "Yes") or REDCap (an industry funding type), or both, mark the protocol as industry-sponsored — industry-funded work may have been billed at the cheaper government/academic rate. Disagreeing Source names which. An event billed at the external rate, Human MRI (industry/external), is never flagged here: that rate serves external users whether or not they are industry, and every external event is listed on the Human MRI (Industry/External) Events table for review.',
  },
  governmentBilledAsIndustry: {
    description:
      "A Dogfish event was billed under an industry MRI service code, but CAMS or REDCap, or both, say the protocol is not industry-sponsored — non-industry work may have been billed at the more expensive industry rate. Disagreeing Source names which. A study that REDCap marks as a CHOP study (the PI's school is CHOP) is never flagged here, because a non-industry CHOP study is billed Human MRI (Industry/CHOP).",
  },
  chopBilledAsStandard: {
    description:
      "REDCap marks the protocol as a CHOP study (the PI's school is CHOP), but the event was billed at the standard Human MRI rate. A CHOP study is billed Human MRI (Industry/CHOP), so the scan may have been billed at too low a rate.",
  },
  animalBilledAsHuman: {
    description:
      'A Dogfish event was billed under a Human MRI service code, but the protocol number matches the animal-protocol format ("AR" followed by 6 digits) — an animal study may have been billed as a human scan.',
  },
  humanBilledAsAnimal: {
    description:
      'A Dogfish event was billed under an Animal MRI service code, but the protocol number does not match the animal-protocol format ("AR" followed by 6 digits) — a human study may have been billed as an animal scan.',
  },
  stimulusBillingMissed: {
    description:
      "The protocol's approved REDCap review letter includes the Stimulus/Response Equipment fee, but no Stimulus charge was found in Dogfish — a fee that should have been billed may have been missed.",
  },
  stimulusBillingExtra: {
    description:
      "Dogfish billed a Stimulus/Response Equipment fee for the protocol, but the approved REDCap review letter does not include that fee — an extra, unapproved fee may have been billed.",
  },
  stimulusBilledAsGovernment: {
    description:
      `Dogfish billed the standard Stimulus/Response Equipment fee, but CAMS or REDCap, or both, mark the protocol as industry-sponsored — the fee should have carried the "(Ind)" industry rate. Disagreeing Source names which. Only scans on or after ${INDUSTRY_FEE_RATE_START} are checked, because the industry rate did not exist before then.`,
  },
  stimulusBilledAsIndustry: {
    description:
      'Dogfish billed the Stimulus/Response Equipment fee at the "(Ind)" industry rate, but CAMS or REDCap, or both, say the protocol is not industry-sponsored — the fee should have carried the standard rate. Disagreeing Source names which. This includes CHOP studies, which pay the standard fee.',
  },
  neuroreaderBillingMissed: {
    description:
      "The protocol's approved REDCap review letter includes the Research Report Reader (Neuroreader) fee, but no such charge was found in Dogfish — a fee that should have been billed may have been missed. Events on the SC3T or SC7T scanner (Stellar Chance) are never flagged here, because scans there should not have Neuroreader services.",
  },
  neuroreaderBillingExtra: {
    description:
      "Dogfish billed a Research Report Reader (Neuroreader) fee for the protocol, but the approved REDCap review letter does not include that fee — an extra, unapproved fee may have been billed.",
  },
  neuroreaderBilledAsGovernment: {
    description:
      `Dogfish billed the standard Research Report Reader (Neuroreader) fee, but CAMS or REDCap, or both, mark the protocol as industry-sponsored — the fee should have carried the "(Industry)" rate. Disagreeing Source names which. Only scans on or after ${INDUSTRY_FEE_RATE_START} are checked, because the industry rate did not exist before then.`,
  },
  neuroreaderBilledAsIndustry: {
    description:
      'Dogfish billed the Research Report Reader (Neuroreader) fee at the "(Industry)" rate, but CAMS or REDCap, or both, say the protocol is not industry-sponsored — the fee should have carried the standard rate. Disagreeing Source names which. This includes CHOP studies, which pay the standard fee.',
  },
  neuroreaderAtStellarChance: {
    description:
      "A Research Report Reader (Neuroreader) fee was billed on the SC3T or SC7T scanner (Stellar Chance) — flagged for review.",
  },
};

export const VIOLATION_RULE_EXPLANATIONS: RuleExplanation[] = [
  ...VIOLATION_ISSUES.map(({ flag, issue }) => ({
    label: issue,
    ...VIOLATION_DESCRIPTIONS[flag],
  })),
  {
    label: "Disagreeing Source",
    description:
      'The data that disagrees with what Dogfish billed. For the industry/government rate checks: "CAMS" (CAMS marks the protocol industry-sponsored, or not), "REDCap" (the protocol\'s REDCap funding type is an industry code, or not), or "CAMS + REDCap" when both disagree. When both disagree, CAMS and REDCap agree with each other and only the billing differs. When only one disagrees, CAMS and REDCap contradict each other, so the fix may belong in that source\'s data rather than in the billing. A source with no answer (no record, or a blank REDCap funding type) never disagrees. For the other checks: "REDCap" (the PI\'s school, for a CHOP study), "REDCap letter" (the fees that the approved REDCap review letter includes), "Protocol format" (whether the protocol number matches the animal-protocol format, "AR" followed by 6 digits), or "Scanner" (the scanner the event was on).',
  },
];

export const MISMATCH_RULE_EXPLANATIONS: RuleExplanation[] = [
  {
    label: "No CAMS Match",
    description:
      "The event's protocol number could not be found in the CAMS data, so CAMS had no answer for the checks that compare a billed rate with industry sponsorship: industry/government billed as (MRI), and the Stimulus and Neuroreader billed as government/industry fee checks. Those checks still ran against REDCap when the protocol has an active REDCap record with a funding type, and were skipped only when it has neither. Every other check ran normally, and any violations found still appear on the Violations tables above. If this row shows no violations, that means the checks that could run found none, not that nothing was checked.",
  },
  {
    label: "No Active REDCap Match",
    description:
      'No REDCap record with a completed review letter ("camris_review_letter_complete" = Complete) was found for this protocol. The four Stimulus and Neuroreader billing missed/extra checks and the CHOP check need an active REDCap record, so they were skipped for this event, and the industry/government rate checks ran against CAMS alone. Every other check ran normally, and any violations found still appear on the Violations tables above. This is expected for animal protocols, which REDCap does not track, so it does not by itself indicate a problem.',
  },
  {
    label: "No REDCap Funding Type",
    description:
      'The protocol has an active REDCap record, but its funding type ("funding_type") is blank, so REDCap has no answer on whether the protocol is industry-sponsored. The industry/government rate checks ran against CAMS alone. Filling in the funding type in REDCap lets both sources be compared.',
  },
  {
    label: "Invalid Protocol Format",
    description:
      'The protocol number does not match any expected format — a plain 6-digit number, "AR" followed by 6 digits, or "xx-xxxx" (2 digits, hyphen, 4 digits) — so it may be mistyped or entered inconsistently in Dogfish. This flag does not by itself stop any check from running: CAMS and REDCap matching use the protocol number as written, so a match, and the checks that depend on it, can still succeed even with an unexpected format. Treat this flag as a data-quality note on the protocol number itself, separate from whether matching succeeded.',
  },
];

export const CONTRAST_RULE_EXPLANATIONS: RuleExplanation[] = [
  {
    label: "code",
    description:
      'The code to bill: CAMRIS-051 for an industry-sponsored protocol, CAMRIS-003 otherwise. It starts as the Suggested Code, and you can change it; generating the output again discards the changes. A CHOP study that is not industry sponsored is CAMRIS-003: CHOP studies pay the standard rate for contrast, as for the Stimulus and Reader fees.',
  },
  {
    label: "Suggested Code",
    description:
      "The code most of the sources that answer point to (see Says Industry). When two sources answer and disagree, the MRI service wins, then CAMS. When no source answers, there is no suggested code, and you must choose one.",
  },
  {
    label: "Says Industry, Says Not Industry",
    description:
      'The sources that say the protocol is, or is not, industry sponsored. Each is read the way the Audit Tool reads it. MRI service: the MRI rate Dogfish billed for the same scan. Human MRI (Industry/CHOP) or Animal MRI (Industry/CHOP) says industry, and any other MRI rate says not industry. The external rate, Human MRI (industry/external), gives no answer, because it serves external users whether or not they are industry. The Industry/CHOP rate on a CHOP study also gives no answer, because a non-industry CHOP study is billed at it too. CAMS: "Industry Sponsored" is "Yes" for industry; any other value is not industry. REDCap: funding type 1 or 4 is industry; any other code is not industry. A source with no answer is in neither column. When both columns name a source, the sources disagree: the Suggested Code follows the majority, but check the row, because the fix may belong in the billing or in a source\'s data.',
  },
  {
    label: "REDCap CHOP",
    description:
      "REDCap marks the study as CHOP (the PI's school). This changes only how the MRI service is read, as described above.",
  },
  {
    label: "Dogfish Event ID, MRI Service",
    description:
      "The Dogfish event matched to this scan, and the MRI services billed on it. The Contrast Report has no Event ID, so the match is by protocol and time: an event that billed an MRI service, on the same protocol number (normalized the way the audit normalizes it) on the date of Begin Exam Time, with the Scan Time nearest to Begin Exam Time.",
  },
  {
    label: "No Dogfish MRI Match",
    description:
      "No Dogfish event billed an MRI service on this protocol on this date, so the MRI service has no answer. The Dogfish upload may not cover this date, or the scan was billed under a different protocol number.",
  },
  {
    label: "No CAMS Match",
    description:
      "The protocol number could not be found in the CAMS data, so CAMS has no answer. As in the audit.",
  },
  {
    label: "No Active REDCap Match",
    description:
      'No REDCap record with a completed review letter ("camris_review_letter_complete" = Complete) was found for this protocol, so REDCap has no answer. As in the audit.',
  },
  {
    label: "No REDCap Funding Type",
    description:
      'The protocol has an active REDCap record, but its funding type ("funding_type") is blank, so REDCap has no answer. As in the audit.',
  },
  {
    label: "Invalid Protocol Format",
    description:
      'The Linked Study IRB Number does not match any expected format: a plain 6-digit number, "AR" followed by 6 digits, or "xx-xxxx" (2 digits, hyphen, 4 digits). A blank number is flagged too. As in the audit, this is a data-quality note; matching still uses the number as written.',
  },
];

export const PRODEV_RULE_EXPLANATIONS: RuleExplanation[] = [
  {
    label: "Prodev Service Without Suffix",
    description:
      'The event billed Human MRI (Prodev Tier 1) or (Prodev Tier 2), but its protocol number does not end with "-P", "_P", or "Prodev" — the naming that usually marks a Prodev-tier protocol. This may be a legitimate, differently-named exception rather than a billing error; it is flagged for review either way.',
  },
  {
    label: "Suffix Without Prodev Service",
    description:
      'The protocol number ends with "-P", "_P", or "Prodev", but the event was not billed at either Prodev tier — a Prodev-tier scan may have been billed at the wrong rate.',
  },
];

export const NO_SHOW_PRODEV_RULE_EXPLANATIONS: RuleExplanation[] = [
  {
    label: "Prodev Suffix",
    description:
      'The protocol number ends with "-P", "_P", or "Prodev" — the naming that usually marks a Prodev protocol — so the no-show is billed to a Prodev protocol.',
  },
  {
    label: "Prodev Billed On Protocol",
    description:
      'Another Dogfish event in this upload billed the same protocol number at Human MRI (Prodev Tier 1) or (Prodev Tier 2), so the protocol is treated as Prodev even if its number lacks the usual ending. Prodev Services Billed lists which tiers. The protocol number must match exactly: a Prodev scan on "123456-P" does not mark a no-show on "123456".',
  },
];

/** Renders the collapsible panel of rule explanations shown under a
 * results table. `summary` is the panel's clickable heading. */
export function renderRuleExplanations(
  items: RuleExplanation[],
  summary = "What do these columns mean?"
): string {
  return `
    <details class="detail-box rule-explainer">
      <summary>${summary}</summary>
      <dl>
        ${items
          .map(
            (item) =>
              `<dt>${item.label}</dt><dd>${item.description}</dd>`
          )
          .join("")}
      </dl>
    </details>
  `;
}
