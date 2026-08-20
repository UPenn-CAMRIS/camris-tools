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
      "The protocol's approved REDCap review letter includes the Stimulus/Response Equipment fee, but no Stimulus charge was found in Dogfish — a fee that should have been billed may have been missed.",
  },
  {
    label: "Stimulus Billing Extra",
    description:
      "Dogfish billed a Stimulus/Response Equipment fee for the protocol, but the approved REDCap review letter does not include that fee — an extra, unapproved fee may have been billed.",
  },
  {
    label: "Neuroreader Billing Missed",
    description:
      "The protocol's approved REDCap review letter includes the Research Report Reader (Neuroreader) fee, but no such charge was found in Dogfish — a fee that should have been billed may have been missed.",
  },
  {
    label: "Neuroreader Billing Extra",
    description:
      "Dogfish billed a Research Report Reader (Neuroreader) fee for the protocol, but the approved REDCap review letter does not include that fee — an extra, unapproved fee may have been billed.",
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
      "The event's protocol number could not be found in the CAMS data. The Industry Billed As Government and Government Billed As Industry checks need CAMS data, so only those two checks were skipped for this event. Every other check — Stimulus and Neuroreader billing, Animal/Human Billed As, Neuroreader Billed At Stellar Chance — still ran normally, and any violations they found still appear on the Violations tables above. If this row shows no violations, that means those other checks ran and found none, not that nothing was checked.",
  },
  {
    label: "No Active REDCap Match",
    description:
      'No REDCap record with a completed review letter ("camris_review_letter_complete" = Complete) was found for this protocol. The four Stimulus and Neuroreader billing checks need an active REDCap record, so only those were skipped for this event. Every other check — Industry/Government Billed As, Animal/Human Billed As, Neuroreader Billed At Stellar Chance — still ran normally, and any violations they found still appear on the Violations tables above. This is expected for animal protocols, which REDCap does not track, so it does not by itself indicate a problem.',
  },
  {
    label: "Invalid Protocol Format",
    description:
      'The protocol number does not match any expected format — a plain 6-digit number, "AR" followed by 6 digits, or "xx-xxxx" (2 digits, hyphen, 4 digits) — so it may be mistyped or entered inconsistently in Dogfish. This flag does not by itself stop any check from running: CAMS and REDCap matching use the protocol number as written, so a match, and the checks that depend on it, can still succeed even with an unexpected format. Treat this flag as a data-quality note on the protocol number itself, separate from whether matching succeeded.',
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

export function renderRuleExplanations(items: RuleExplanation[]): string {
  return `
    <details class="detail-box rule-explainer">
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
