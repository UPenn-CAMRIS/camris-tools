export interface RuleExplanation {
  label: string;
  description: string;
}

export const VIOLATION_RULE_EXPLANATIONS: RuleExplanation[] = [
  {
    label: "Industry Billed As Government",
    description:
      "A Dogfish event for the protocol was billed at a non-industry MRI rate, but CAMS marks the protocol as industry-sponsored — industry-funded work may have been billed at the cheaper government/academic rate.",
  },
  {
    label: "Government Billed As Industry",
    description:
      "A Dogfish event was billed under an industry MRI service code, but CAMS does not mark the protocol as industry-sponsored — non-industry work may have been billed at the more expensive industry rate.",
  },
  {
    label: "Animal Billed As Human",
    description:
      'A Dogfish event was billed under a Human MRI service code, but the protocol number matches the animal-protocol format ("AR" followed by 6 digits) — an animal study may have been billed as a human scan.',
  },
  {
    label: "Human Billed As Animal",
    description:
      'A Dogfish event was billed under an Animal MRI service code, but the protocol number does not match the animal-protocol format ("AR" followed by 6 digits) — a human study may have been billed as an animal scan.',
  },
  {
    label: "Stimulus Billing Missed",
    description:
      "The protocol's approved RedCap review letter includes the Stimulus/Response Equipment fee, but no Stimulus charge was found in Dogfish — a fee that should have been billed may have been missed.",
  },
  {
    label: "Stimulus Billing Extra",
    description:
      "Dogfish billed a Stimulus/Response Equipment fee for the protocol, but the approved RedCap review letter does not include that fee — an extra, unapproved fee may have been billed.",
  },
  {
    label: "Neuroreader Billing Missed",
    description:
      "The protocol's approved RedCap review letter includes the Research Report Reader (Neuroreader) fee, but no such charge was found in Dogfish — a fee that should have been billed may have been missed.",
  },
  {
    label: "Neuroreader Billing Extra",
    description:
      "Dogfish billed a Research Report Reader (Neuroreader) fee for the protocol, but the approved RedCap review letter does not include that fee — an extra, unapproved fee may have been billed.",
  },
  {
    label: "Neuroreader Billed At Stellar Chance",
    description:
      "A Research Report Reader (Neuroreader) fee was billed on the SC3T or SC7T scanner (Stellar Chance) — flagged for review.",
  },
];

export const MISMATCH_RULE_EXPLANATIONS: RuleExplanation[] = [
  {
    label: "No CAMS Match",
    description:
      "The event's protocol number could not be found in the CAMS data, so the Industry Billed As Government / Government Billed As Industry checks could not be evaluated for it.",
  },
  {
    label: "No Active RedCap Match",
    description:
      'No RedCap record with a completed review letter ("camris_review_letter_complete" = Complete) was found for this protocol, so the Stimulus and Neuroreader billing checks could not be evaluated. This is expected for animal protocols, which are not tracked in RedCap — it does not necessarily indicate a problem.',
  },
  {
    label: "Invalid Protocol Format",
    description:
      'The protocol number does not match any expected format — a plain 6-digit number, "AR" followed by 6 digits, or "xx-xxxx" (2 digits, hyphen, 4 digits) — so it may be mistyped or entered inconsistently in Dogfish.',
  },
];

export function renderRuleExplanations(items: RuleExplanation[]): string {
  return `
    <details class="rule-explainer">
      <summary>What do these columns mean?</summary>
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
