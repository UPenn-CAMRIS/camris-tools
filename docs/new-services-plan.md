# Plan: add three new Dogfish services to the audit

Agreed 29 September 2026. No code has changed yet. Each part below is its own
branch and pull request.

This plan adds three Dogfish services to the billing audit:

- `Human MRI (industry/external)`, the new name for `Human MRI (external)`.
- `Research Report Reader Fee (Industry)`, the industry rate of the Research
  Report Reader fee.
- `Stimulus/Response Equipment Usage Fee (Ind)`, the industry rate of the
  Stimulus/Response Equipment fee.

The plan also changes how the Violations tables show errors, adds a table of
fees on external protocols, and adds REDCap as a second source for the rate
checks.

The sample data is `test_set_1/`, scans from 1 to 31 July 2026.

## Delivery order

1. **PR 1: add the three services.** New labels, one bug fix, the
   1 July 2026 fee cutover, and the external-rate exemption.
2. **PR 2: one row per error.** The Violations tables show one row per
   error. The CSV export matches the screen.
3. **PR 3: fees on external protocols.** A new table of Stimulus and Reader
   fees on external protocols.
4. **PR 4: CAMS vs REDCap.** The rate checks name which source disagrees.
   CHOP rules are added.

PR 2 comes before PR 4, so the new errors from PR 4 are new Issue values, not
new columns.

## Billing rules this plan relies on

| Rule | Detail |
|---|---|
| External MRI rate renamed | `Human MRI (industry/external)` is the new name for `Human MRI (external)`. The audit accepts both labels. |
| Industry fee rates | `Research Report Reader Fee (Industry)` and `Stimulus/Response Equipment Usage Fee (Ind)`, for industry studies only. They apply to scans on or after **1 July 2026**. |
| Old `(Industry/CHOP)` fee labels | These never existed in Dogfish. The audit had them from an earlier guess, and they are removed. |
| CHOP studies | A non-industry CHOP study is billed `Human MRI (Industry/CHOP)`. CHOP studies pay the standard Stimulus and Reader fees. |
| External protocols | No source outside Dogfish marks a protocol as external. External protocols are rare, and a person checks every one using the external events table. External protocols should never have Stimulus or Reader fees. |
| REDCap `funding_type` | 1 = industry. 4 = industry funding. 2 = government (an old code). The audit treats every other code as not industry, and a blank as unknown. |
| REDCap `pi_school` | 4 = CHOP. |
| CAMS "Dogfish Scan Rate" | Comes from the same database as the Dogfish billing, so it cannot be used to check billing. |

## PR 1: add the three services

### Service list (`SERVICE_MAP`, `src/audit.ts:25`)

| Dogfish label | Flag | Change |
|---|---|---|
| `Human MRI (industry/external)` | `humanMRIExternal` | Add |
| `Human MRI (external)` | `humanMRIExternal` | Keep, as the old label |
| `Research Report Reader Fee (Industry)` | `neuroreaderIndustry` | Replaces `Research Report Reader Fee (Industry/CHOP)` |
| `Stimulus/Response Equipment Usage Fee (Ind)` | `stimulusIndustry` | Replaces `Stimulus/Response Equipment Usage Fee (Industry/CHOP)` |

- Every label maps to a flag that already exists, so no new `ServiceFlags`
  field is needed.
- The upload checks read their list of known services from `SERVICE_MAP`, so
  the new labels are recognized automatically. If a removed
  `(Industry/CHOP)` fee label turns up in an upload, it is flagged as an
  unrecognized value.
- Labels must match Dogfish exactly, including case. These labels are as the
  user gave them. A real export will show any that differ, as unrecognized
  values.

### Bug fix: the external events table

`HUMAN_MRI_EXTERNAL_SERVICE` (`src/audit.ts:59`) uses `.find()`, which returns
only the first label that maps to the flag. With two external labels, every
row with the other label would silently drop out of the Human MRI (External)
Events table. That table is how a person reviews external events. Change it
to a set, built with `.filter()` the way `READER_SERVICES` is
(`src/audit.ts:52`). A test puts both labels in one upload and checks that
every row appears.

### Rule changes

| Rule | Change |
|---|---|
| Stimulus and Neuroreader Billed As Government | Only checked for scans on or after 1 July 2026. Compare the date at the start of Scan Time, the way the late-cancellation report reads the month. If Scan Time has no date, the check still runs. |
| Stimulus and Neuroreader Billed As Industry | No date limit. Only the rate name in the wording changes. |
| Industry Billed As Government (MRI) | Never raised for an event billed at the external rate. A person already reviews every external event. |
| Billing Missed and Extra, Neuroreader At Stellar Chance, Add-On Fees Without MRI, Animal Billed As Human | No logic change. These read the service flags, so the new labels are covered automatically. |

### Text, docs and tests

- **Rule explanations** (`src/ruleExplanations.ts:40-65`): replace
  `(Industry/CHOP)` with the new rate names, and state the cutover date.
- **Audit page** (`src/pages/audit.ts:160-164`, `499`): rename the section to
  "Human MRI (Industry/External) Events", and make its note list both labels.
  The export filename stays the same.
- **Comments** in `src/types.ts:108` and `116`, and the `(Industry/CHOP)`
  comments in `src/audit.ts`.
- **README** lines 52, 82, 105-106 and 277-280. Add a note under "Add a new
  Dogfish service": a renamed service keeps its old label as a second entry
  on the same flag, and service groups are built with `.filter()`, not
  `.find()`.
- **Existing test** `test/run_audit_industry_suffix_checks.ts`: use the new
  labels. Move its default Scan Time (2026-01-01) to on or after the cutover.
- **New test file**, added to the `test` script in `package.json`:
  - both external labels: the events table, counting as MRI for the add-on
    check, the animal check, no unrecognized-value warning
  - the removed labels being flagged as unrecognized
  - the cutover on 30 June, on 1 July, and with no date
  - the external-rate exemption

All July scans fall on or after the cutover, so the 12 standard Reader fees
on CAMS-industry protocols that PR #4 found are still flagged.

## PR 2: one row per error

The Violations tables currently have one column per check, and most cells
are empty. Instead, each error gets its own row. An event with two errors
takes two rows, with its event fields repeated. The CSV export has exactly the
rows and columns shown on screen, and there are no merged cells.

- **Violations by Event.** Columns: Event ID, Protocol, Scan Time, Scanner,
  Issue, Disagreeing source. Rows sort by Event ID, then by Issue, so an
  event's rows stay together.
- **Violations by Protocol.** Columns: Protocol, Issue, Disagreeing source,
  Events (a count), First scan, Last scan. Rows sort by Protocol, then by
  Issue.

### Issue values

| Issue | Disagreeing source |
|---|---|
| Industry billed as government (MRI) | CAMS (from PR 4: CAMS, REDCap, or CAMS + REDCap) |
| Government billed as industry (MRI) | CAMS (from PR 4: CAMS, REDCap, or CAMS + REDCap) |
| Stimulus billed as government / as industry | CAMS (from PR 4: CAMS, REDCap, or CAMS + REDCap) |
| Neuroreader billed as government / as industry | CAMS (from PR 4: CAMS, REDCap, or CAMS + REDCap) |
| Stimulus billing missed / extra | REDCap letter |
| Neuroreader billing missed / extra | REDCap letter |
| Neuroreader billed at Stellar Chance | Scanner |
| Animal billed as human / Human billed as animal | Protocol format |
| CHOP study billed at standard MRI rate (PR 4) | REDCap |

- Each table's header counts errors and distinct events or protocols, for
  example "51 errors across 42 events".
- The check logic does not change. Each event keeps its typed flags, and a
  final step turns every true flag into one error row. The protocol view
  groups those rows and adds the event count and the first and last scan
  dates. The existing tests still pass. New tests cover the conversion and
  the counts.
- The rule explanations become one list of issue names, matching the Issue
  column exactly.
- `src/table.ts` needs no changes, because every column is plain text.

## PR 3: Stimulus and Reader fees on external protocols

- **What it lists:** every event that bills a Stimulus or Reader fee, at
  either rate, on an external protocol. No-shows are left out, and there is
  no date limit.
- **What counts as external:** the event itself bills either external label,
  or another event in the upload bills that exact protocol number at the
  external rate. This is the same two-way test the No-Shows Billed To Prodev
  Protocols report uses. It also catches a fee on an event whose MRI line was
  wrongly billed as plain Human MRI.
- **Columns:** Event ID, Protocol, Project Title, Scan Time, Scanner, Fees
  billed, and External rate billed on ("this event" or "another event").
- **July sample:** no rows. The only external event (105581, protocol
  45084153) has no fee.

## PR 4: CAMS and REDCap as two sources for the rate checks

Each rate check compares the billed rate with CAMS and with REDCap, and names
whichever source disagrees. When both disagree, the two sources agree with
each other and only the billing differs. When only one disagrees, CAMS and
REDCap contradict each other, so the fix may belong in the source data, not
the billing.

### Sources

- **CAMS:** industry when "Industry Sponsored" is "Yes". `classifyIndustry`
  in `src/cams.ts` does not change. It remains the single CAMS definition,
  which the Contrast tool also uses.
- **REDCap:** industry when `funding_type` is 1 or 4. A blank means unknown.
  Used only by the audit.
- **CHOP:** when REDCap `pi_school` is 4.

### Expected rate

- **MRI:** `Industry/CHOP` for an industry or CHOP study, otherwise standard.
- **Stimulus and Reader fees:** the industry rate for an industry study,
  otherwise standard. This includes CHOP studies, which pay standard fees.

### Disagreeing source

| CAMS vs billed rate | REDCap vs billed rate | Result |
|---|---|---|
| agrees or missing | agrees or missing | No error |
| **disagrees** | agrees or missing | CAMS |
| agrees or missing | **disagrees** | REDCap |
| **disagrees** | **disagrees** | CAMS + REDCap |
| missing | missing | Not checked. The event goes to the Mismatches table, as it does today. |

- This covers all six rate checks: MRI, Stimulus and Reader, in both
  directions. The direction comes from the billed rate.
- **CHOP exemption:** "Government billed as industry (MRI)" is not raised
  when REDCap marks the study as CHOP. A CHOP study with no REDCap record
  cannot be exempted, so it can still show with source CAMS.
- **New issue:** "CHOP study billed at standard MRI rate", with source
  REDCap.
- **Upload checks:** `funding_type` (known values 1-7 and blank) and
  `pi_school` (known values 1-5 and blank) become required REDCap columns. A
  new Mismatches flag, "No REDCap Funding Type", covers blank values.
- **Rule explanations:** the "No Active REDCap Match" text changes, because a
  missing REDCap record now also affects the rate checks.
- **README:** REDCap is a second source used only by the audit. It never
  replaces the CAMS answer.
- **Tests:** every combination of billed rate, CAMS and REDCap, including
  missing records, in both directions. Also the fee checks together with the
  cutover, and CHOP both with and without a REDCap record.

### Estimated results on the July sample

| Issue | Disagreeing source | Events | Protocols |
|---|---|---:|---|
| Government billed as industry (MRI) | CAMS | 8 | 856642, 857904, 858176, 858805, 859345 |
| Government billed as industry (MRI) | REDCap | 9 | 842728, 850677 |
| Industry billed as government (MRI) | REDCap | 6 | 26-5880, 853909, 857385, 857829 |
| Neuroreader billed as government | CAMS + REDCap | 3 | 843759, 855200 |
| Neuroreader billed as government | CAMS | 9 | 842728, 850677 |
| Neuroreader billed as government | REDCap | 6 | 853909, 856642, 857385 |
| Stimulus billed as government | REDCap | 2 | 856642 |
| CHOP study billed at standard MRI rate | REDCap | 1 | 849938 (event 104783) |

These figures come from running the planned rules against `test_set_1` in a
one-off script, not from the finished code, so the real counts may differ
slightly. The five CAMS rows for the MRI check are flagged today; REDCap says
those studies are industry. The REDCap rows for the MRI check that were
billed at the standard rate may be under-billing that today's audit cannot
see.

## Considered and dropped

| Proposal | Why it was dropped |
|---|---|
| Check the billed MRI rate against CAMS "Dogfish Scan Rate" | That column comes from the same database as the billing, so the check compares the data with itself. |
| Check that the fee rate matches the MRI rate on the same event | For a CHOP study, `Industry/CHOP` MRI with a standard fee is correct, so this check would flag correct billing. PR 4's fee checks catch the industry cases whenever CAMS or REDCap has a record. |
| Check CAMS "PBR Scan Rate" | Too inconsistent to use. 27 industry rows say `industry/external` there, but Dogfish bills those protocols as `Industry/CHOP`. |
| Flag a protocol billed at both industry and standard MRI rates | No cases in the sample. |
| Merged cells grouping each event's errors | The CSV export would not match the screen. |
| A priority column | Not needed. The "CAMS + REDCap" source already shows when both sources disagree. |

## Follow-up, outside this plan

CAMS lists an `Animal MRI (Ex-vivo scanning)` rate, and `SERVICE_MAP` does
not include it. That CAMS column comes from Dogfish, so Dogfish probably has
this service. If it does, the audit would treat it as unrecognized.
