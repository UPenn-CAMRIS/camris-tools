/** CAMS protocol lookup and the industry-sponsorship test, shared by the
 * Audit Tool and the Contrast Injection Tool so the two cannot drift.
 * Both tools ask the same question — "is this protocol industry
 * sponsored, per CAMS?" — and must answer it the same way. */

// A Dogfish or CAMS protocol number that starts with 6 digits carries its
// identity in those 6 digits; any trailing suffix (for example "_7X" or
// "-P") names a billing-rate variant, not a different protocol. Values
// that are not 6-digit-prefixed (an animal "AR######" number, or an
// "xx-xxxx" number) have no such suffix and are left alone.
export const SIX_DIGIT_PREFIX = /^\d{6}/;

/** Converts a Dogfish or CAMS protocol number to its 6-digit base. It
 * strips any suffix. If a value does not start with 6 digits (for
 * example, an animal protocol), the function returns it unchanged. This
 * matches the convention already used in the source data. */
export function normalizeDogfishCamsProtocol(rawProtocolNumber: string): string {
  const match = rawProtocolNumber.match(SIX_DIGIT_PREFIX);
  return match ? match[0] : rawProtocolNumber;
}

export interface CamsRecord {
  industrySponsored: string;
}

/** Reads a field from a raw tabular row (CSV or sheet). Returns "" if the
 * value is missing or null, and trims whitespace either way. */
function field(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return value == null ? "" : String(value).trim();
}

/** Builds a lookup from normalized protocol number to its CAMS record.
 * The first record for a given normalized number wins — the same way the
 * REDCap lookup collapses duplicate records, matching the original Julia
 * audit script. */
export function buildCamsLookup(
  camsRows: Record<string, unknown>[]
): Map<string, CamsRecord> {
  const lookup = new Map<string, CamsRecord>();

  for (const row of camsRows) {
    const rawProtocol = field(row, "Protocol Number");
    if (rawProtocol === "") continue;

    const normalized = normalizeDogfishCamsProtocol(rawProtocol);
    if (!lookup.has(normalized)) {
      lookup.set(normalized, {
        industrySponsored: field(row, "Industry Sponsored"),
      });
    }
  }

  return lookup;
}

/**
 * The industry-sponsorship state of a protocol, per CAMS:
 * - `"industry"` — found in CAMS with "Industry Sponsored" exactly "Yes".
 * - `"government"` — found in CAMS with any other value ("No", "Not
 *   Reported", or blank all read as not industry).
 * - `"unknown"` — no CAMS record for this protocol number, so the
 *   question cannot be answered. The audit reports this as a mismatch
 *   rather than guessing; the contrast tool does the same.
 */
export type IndustryStatus = "industry" | "government" | "unknown";

/** Classifies a raw (un-normalized) Dogfish/CAMS protocol number against
 * a CAMS lookup. This is the single definition of the test the audit
 * applies inline in `computeFlags()`. */
export function classifyIndustry(
  camsLookup: Map<string, CamsRecord>,
  rawProtocolNumber: string
): IndustryStatus {
  const cams = camsLookup.get(
    normalizeDogfishCamsProtocol(rawProtocolNumber)
  );
  if (!cams) return "unknown";
  return cams.industrySponsored === "Yes" ? "industry" : "government";
}
