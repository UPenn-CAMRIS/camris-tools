# CAMRIS Billing Tools

A browser-based suite of billing tools for CAMRIS MRI operations. Everything
runs client-side — file parsing and every check happen entirely in the
browser via the File API. No data is ever uploaded anywhere; the app can be
hosted on any static webserver (or run offline from `file://`, with caveats —
see [Running it](#running-it)).

The suite has two tools, presented as separate pages behind one landing page:

- **Audit Tool** (`#/audit`) — checks Dogfish billing events against CAMS and
  REDCap data, and reports violations. A reimplementation of an original
  Julia audit script, rebuilt so non-technical staff can run it from a
  browser without a Julia environment.
- **Contrast Injection Tool** (`#/contrast`) — builds a contrast-injection
  billing file from a Contrast Report and a CAMRIS Technologists list. A
  reimplementation of `Contrast.jl` (kept as a reference in
  `contrast_test_set_1/`, not ported line-for-line).

Both tools share the same upload/sanity-check/table UI, so they look and
behave consistently.

## Audit Tool

Upload three CSV exports for the same period:

- **Dogfish Events** — the scanner billing/event log
- **CAMS Data** — fund and industry-sponsorship data per protocol
- **REDCap Export** — CAMRIS application/review data, including which fees a
  protocol's approved review letter authorizes, its funding type, and the
  PI's school

If a file has malformed rows (e.g. an unescaped quote inside a field), parsing
still continues on a best-effort basis, and an expandable box appears under
that file's upload row listing which rows were affected and why. Each row can
be edited in place and the file re-parsed with the correction. Once a
correction changes the file, a **Download** button saves a corrected copy as
`<name>-corrected.csv`: the uploaded file with only the edited rows changed,
keeping its byte-order mark and line endings. The file on disk is never
changed. (This applies to every CSV upload in both tools.)

The tool matches events to their protocol's CAMS and REDCap records (by a
normalized protocol number) and flags:

- Industry-sponsored protocols billed at the government rate, and vice versa.
  Industry sponsorship comes from two sources, CAMS and REDCap (see
  [Two sources for industry sponsorship](#two-sources-for-industry-sponsorship)),
  and each flag names the source that disagrees with the billing, or both.
  An event billed at the external rate, `Human MRI (industry/external)`, is
  never flagged as industry billed at the government rate: that rate serves
  external users whether or not they are industry, and every external event
  is listed for review instead (see the Human MRI (Industry/External) Events
  table). A study that REDCap marks as CHOP (the PI's school) is never
  flagged as government billed as industry, because a non-industry CHOP
  study is billed `Human MRI (Industry/CHOP)`.
- A CHOP study billed at the standard `Human MRI` rate instead of
  `Human MRI (Industry/CHOP)`
- Animal protocols billed under a human MRI service code, and vice versa
- Stimulus/Response Equipment or Neuroreader (Research Report Reader) fees that
  were billed but not approved, or approved but never billed. An approved
  Neuroreader fee that was never billed is not flagged on the SC3T or SC7T
  scanner (Stellar Chance), because scans there should not have Neuroreader
  services.
- A Stimulus/Response Equipment or Neuroreader fee billed at the standard rate
  on an industry-sponsored protocol, or at the industry rate
  (`Stimulus/Response Equipment Usage Fee (Ind)`,
  `Research Report Reader Fee (Industry)`) on one that isn't — the same
  rate-vs-sponsorship check applied to Human MRI, with the same two sources,
  applied to these ancillary fees. CHOP studies pay the standard fees. The
  industry fee rates took effect on 1 July 2026
  (`INDUSTRY_FEE_RATE_START` in `audit.ts`), so a standard fee on an
  industry-sponsored protocol is flagged only for scans on or after that
  date.
- Neuroreader fees billed on the SC3T or SC7T scanner (Stellar Chance)
- A Prodev-tier service billed on a protocol whose number doesn't carry the
  usual Prodev naming, and vice versa
- A no-show billed to a Prodev protocol
- A Stimulus/Response Equipment or Neuroreader fee, at either rate, billed on
  an external protocol. External protocols should never bill these fees.

Full plain-English descriptions of each rule are in an expandable panel under
each results table in the app itself.

### Output tables

1. **Violations by Protocol** — one row per error on a protocol: each
   `(protocol, issue)` pair, with columns Protocol Number, Issue,
   Disagreeing Source, Events (how many events have that issue), First
   Scan, and Last Scan. A protocol with two different issues has two rows.
   Good for seeing which protocols have a given problem. The count next to
   the heading reads, for example, "60 errors across 13 protocols".
2. **Violations by Event** — one row per error on a billing event, with
   columns Event ID, Protocol Number, Scan Time, Scanner, Issue, and
   Disagreeing Source. An event with two violations has two rows. Good for
   tracing a specific charge back to a specific scan. The count reads, for
   example, "51 errors across 42 events".

   In both tables, Disagreeing Source names the data that disagrees with
   what Dogfish billed: `CAMS`, `REDCap`, or `CAMS + REDCap` (industry
   sponsorship, for the rate checks; `REDCap` also for a CHOP study),
   `REDCap letter` (the fees the approved review letter includes),
   `Protocol format` (the animal `AR` protocol-number format), or `Scanner`
   (Stellar Chance). Rows are
   sorted by Event ID or protocol number, then in the fixed order of the
   issues. Each table's CSV file in a saved audit has exactly the columns
   shown on screen.
3. **Mismatches** — protocols that couldn't be fully checked because they
   weren't found in CAMS, weren't found in an active ("Complete") REDCap
   review, have an active REDCap review with a blank funding type, or have
   a protocol number that doesn't match an expected format.
   Deduped to one row per protocol. (Animal protocols showing "no active
   REDCap match" is expected — REDCap only tracks human IRB applications.)
4. **Prodev Naming Consistency** — events where a Prodev Tier 1/2 service and
   the protocol number's "-P"/"_P"/"Prodev" naming disagree, in either
   direction. A protocol can legitimately use a different naming convention
   and still be correctly billed, so a row here is worth a look, not
   necessarily an error.
5. **Add-On Fees Without MRI** — events billed for a Stimulus/Response
   Equipment and/or Neuroreader fee (at either the standard or the
   industry rate) with no MRI service code on the same event.
   These fees are meant to ride along with a scan, so this is a
   data-quality flag independent of the CAMS/REDCap checks above.
6. **Excess Late Cancellations** — each protocol is allowed two late
   cancellation events (`No Show/Cancellation Fee`) per calendar month,
   the month taken from Scan Time. Once a protocol goes past two in a
   month, every later cancellation event that month gets a row here, with
   its Event ID and that month's total cancellation count. Events are
   ordered by Scan Time then Event ID, so the first two in the month are
   the ones treated as within allowance. Protocols are grouped by their
   exact Dogfish protocol number (no normalization), and cancellation
   rows are grouped into events by Event ID. The Dogfish data does not
   distinguish a late cancellation from a no-show, so both are counted.
7. **No-Shows Billed To Prodev Protocols** — every no-show event
   (`No Show/Cancellation Fee`) whose protocol is a Prodev protocol, one
   row per Event ID. A protocol counts as Prodev when its raw protocol
   number has the same "-P"/"_P"/"Prodev" ending the Prodev Naming
   Consistency check uses, or when another event in the upload billed
   that exact protocol number at Prodev Tier 1 or 2. Protocol numbers
   must match exactly (no normalization), so a Prodev scan on `832792-P`
   does not mark a no-show on `832792`.
8. **Stimulus/Reader Fees On External Protocols** — every event (no-shows
   left out) that billed a Stimulus/Response Equipment or Neuroreader fee,
   at either the standard or the industry rate, on an external protocol,
   one row per Event ID. External protocols should never bill these fees.
   No data source outside Dogfish marks a protocol as external, so a
   protocol counts as external when the event itself billed the external
   MRI rate (`Human MRI (industry/external)` or the old label,
   `Human MRI (external)`), or when another event in the upload billed
   that exact protocol number at the external rate. The External Rate
   Billed On column says which ("This event" or "Another event"). As with
   the Prodev no-show table, protocol numbers must match exactly (no
   normalization), so an external scan on `500001` does not mark a fee on
   `500001-B`.
9. **SC7T Scanner Events** — every raw Dogfish row on the SC7T scanner,
   including no-shows and cancellations, unfiltered by any audit rule.
10. **Human MRI (Industry/External) Events** — every raw Dogfish row billed
    at the external MRI rate, on any scanner, unfiltered by any audit rule.
    It includes both the current label, `Human MRI (industry/external)`,
    and the old label, `Human MRI (external)`. No data source outside
    Dogfish marks a protocol as external, so this table is how a person
    checks each external event.

### Decisions

Four tables take a decision on each flagged row: Violations by Protocol,
Mismatches, Prodev Naming Consistency, and Human MRI (Industry/External)
Events. A decision is **Fix** or **Don't fix**, with a Reason (required for
Don't fix), and the tool fills in Decided By, Decided On, Confirmed By, and
Confirmed On.
Enter your initials next to Run Audit first; the decision controls stay
disabled until you do.

A decision belongs to a key, not to one row (`DECISION_KEYS` in
`decisions.ts`):

| Table | Decision key |
|---|---|
| Violations by Protocol | protocol number + issue |
| Mismatches | protocol number + the set of checks that failed |
| Prodev Naming Consistency | protocol number + direction of the mismatch |
| Human MRI (Industry/External) Events | protocol number |

The last two tables have one row per event, so a decision made on one row
fills every row with the same key. The disagreeing source and the event
counts are not part of any key. Each table's count also says how many rows
still need a decision: rows with no decision, and Don't fix rows with no
reason. Running the audit again on the same page keeps the decisions.

### Saving an audit

**Save audit (.zip)**, above the results, downloads the whole audit as one
file, named for the Dogfish scan period and the save date, for example
`camris_audit_2026-09-01_to_2026-09-29_saved_2026-09-30.zip`
(`savedAudit.ts`):

```
manifest.json
inputs/dogfish/<uploaded file name>    the three input files, exactly as
inputs/cams/<uploaded file name>       uploaded
inputs/redcap/<uploaded file name>
reports/<one CSV per results table>    with the decision columns, where a
                                       table takes decisions, and the
                                       earlier decisions not flagged
previous/reports/<decision CSVs>       the previous audit's decision
                                       files, when there is one
```

The manifest records the audit ID (the same each time one audit is saved
again), when it was created and saved, the saver's initials, the app build
(git commit), the Dogfish scan range, and each input's row corrections in
the order they were applied. Applying those corrections again, in order, to
the saved input gives the exact text the audit ran on. The zip holds the
inputs as they were when the audit was last run, so a file uploaded after
the last Run Audit is not in it.

The saved audit contains the full input data, so store and share it with the
same care as the Dogfish, CAMS, and REDCap exports themselves. The page asks
for confirmation before you leave it, or close the tab, with decisions that
are not in a saved audit.

### Opening a saved audit

The Audit page has two modes, chosen at the top: **Start a new audit**
(upload the three exports) and **Open a saved audit** (upload one saved
audit zip). Opening a saved audit restores it and runs it again:

- The three inputs come from the zip, and their saved row corrections are
  applied again (`applyRowCorrections` in `parseCsv.ts`). The input slots
  have no file pickers in this mode, because a different input file would
  be a different audit. Malformed rows can still be corrected; a new
  correction is added to the list, and the next save includes it.
- The decisions are read back from the four decision tables' CSV files
  (`decisionsFromCsv` in `decisions.ts`, `DECISION_REPORT_FILES` in
  `savedAudit.ts`). A decision's key is rebuilt from the CSV columns named
  in `DECISION_KEY_COLUMNS`, so those names must match the tables' column
  headers on the page.
- Saving again keeps the audit ID and creation time, and writes a new file
  with the new save date.

The whole zip is read and checked before the page changes, so a wrong or
damaged file, or one saved by a newer version of the tool, shows an error
and leaves any open audit as it was. A zip that unpacks to more than 200 MB
is refused. When the zip was saved by a different build of the tool, the
page says so, because changed audit rules can give different results; a
decision whose row is no longer flagged is not kept when the audit is saved
again.

### Using a previous audit

A new audit can be compared with a previous one: upload its saved zip in the
optional **Previous Audit** slot, or click **Start next audit from this one**
on an audit that is open (`previousAudit.ts`). Then:

- The four decision tables get a **Since Previous Audit** column: `New`,
  `Flagged again`, `Flagged again, source changed (was CAMS)` (Violations by
  Protocol), or `Flagged again (marked Fix on 2026-08-29)`. Without a
  previous audit the column is left out, on screen and in the CSV files.
- A previous **Don't fix** is filled in on a row flagged again, as
  `Don't fix (unconfirmed)`, with its original reason, Decided By, and
  Decided On. Every one needs a reviewer to click **Confirm** in this
  audit, which fills in Confirmed By and Confirmed On; until then the row
  counts as needing a decision. There is no confirm-all.
- A previous **Fix** is never filled in. A row flagged again gets a new
  decision.
- A decision covers every event of its key, so one key never carries two
  decisions. A case where some events are fine and others are not is
  recorded as Fix, with the exceptions in the reason; it is decided again in
  the next audit. If a previous audit's file has two different decisions
  for one key (only a file edited by hand can), neither is carried, and the
  row's label says so.
- Previous decisions whose rows this audit does not flag are listed in
  **Earlier Decisions Not Flagged**, a table collapsed by default, with
  Table, Protocol Number, and Details (the issue, the failed checks, or the
  mismatch direction) to identify each one. Every Don't fix stays there,
  audit after audit, so it is ready if its row is flagged again. A Fix is
  listed once, as resolved, when this upload covers the scans it was
  flagged on, then dropped. The ✕ on a row stops it from moving forward.
  The labels are `Not flagged, resolved` (this upload covers the scans it
  was flagged on), `Not flagged, outside this upload's dates`, and
  `Not flagged, carried from an earlier audit`.

The saved audit keeps what it needs of the previous one in `previous/`, and
the manifest lists the earlier decisions removed with ✕, so opening it again
gives the same comparison without the previous audit's file. Saved audits
are format version 2; the tool still opens version-1 files.

### REDCap collision guard

REDCap's protocol field is free text and can name a protocol more than one
way (see [Design decisions](#design-decisions-and-constraints)). If the same
name turns up on two REDCap rows that otherwise look like different
protocols, the app blocks the audit — the same way a missing required column
does — and shows both rows so the REDCap data can be checked by hand.

## Contrast Injection Tool

Upload three files:

- **Contrast Report** — Excel (`.xlsx`) or CSV, the source event export
- **CAMRIS Technologists** — CSV, maps each Technologist name to a PennKey
- **CAMS Data** — CSV, fund and industry-sponsorship data per protocol

The tool keeps only rows with a non-blank "Procedure-Related Meds" value and
a Technologist found in the CAMRIS Technologists file, then builds one output
row per kept event with the billing constants
(`lab=7, sublab=0, desc1="Contrast Injection", quantity=1, bill="Y"`). The
`code` is chosen per row from CAMS, using the same industry test as the Audit
Tool (`classifyIndustry` in `cams.ts`): `CAMRIS-051` when CAMS marks the row's
protocol "Industry Sponsored", `CAMRIS-003` for any other CAMS-known protocol.

A kept row whose "Linked Study IRB Number" is blank, or names a protocol with
no CAMS record, cannot be classified, so it is left out of the billing output
and listed in a second **CAMS Mismatches** table instead — the same way the
Audit Tool reports an event with no CAMS match rather than guessing. Rows
skipped for each reason (no meds, no technologist match) are counted and
shown. Both tables are exportable to CSV.

## Running it

Already hosted, no setup needed: **<https://upenn-camris.github.io/camris-tools/>**.
A GitHub Actions workflow (`.github/workflows/deploy.yml`) rebuilds and
redeploys this on every push to `main`.

To run it locally instead:

```bash
npm install
npm run dev      # local dev server with hot reload, for development
npm run build    # produces a static bundle in dist/
npm test         # runs both tools' logic against their test data from Node, no browser needed
```

`dist/` is a fully static site — copy it to any static webserver (nginx,
Apache, S3, GitHub Pages, etc.) and it works as-is.

Opening `dist/index.html` directly via `file://` (double-clicking it) mostly
works too, since the build uses relative asset paths, but Chrome and other
Chromium-based browsers block `<script type="module">` from loading over
`file://` regardless of path — if you hit a blank page that way, serve the
folder instead, e.g. `python3 -m http.server 8080 --directory dist`.

## Contributing

Every change reaches `main` through a reviewed pull request (see `CLAUDE.md`
for the full workflow, which follows the
[dev-workflow](https://github.com/mdtisdall/claude-dev-workflow) Claude Code
plugin). CI (`.github/workflows/ci.yml`) runs `scripts/check` on each PR.

### Development environment (Nix)

The repo ships a Nix flake devShell that pins the tools this project needs
outside of npm: `gh` (for PRs) and Node 20 (matching CI). With
[Nix](https://nixos.org/download) (flakes enabled) and
[direnv](https://direnv.net) installed:

```bash
direnv allow     # one-time; loads the devShell on cd into the repo
nix develop      # or this, if you don't use direnv
```

`npm install` / `npm run …` then behave as in [Running it](#running-it), on
the pinned Node. All the checks that CI runs are one command:

```bash
nix develop --command scripts/check
```

### `gh` authentication

`gh` uses a fine-grained GitHub PAT **scoped to this repository only**, with
the permissions listed in `.claude/gh-token-permissions`. It is stored as
`export GH_TOKEN=...` in the git-ignored `.envrc.local` (mode 600), which
`.envrc` loads; worktrees link to the main checkout's copy. Run `gh` as
`direnv exec . gh ...` so it picks up that token. Git itself uses SSH for
this repo, so `git` push/pull do not need the token.

To create, store, and validate the token, use the dev-workflow plugin's
`github-token` skill.

## Project structure

```
src/
  main.ts             hash router (#/, #/audit, #/contrast) — each page is a
                       dynamic import, so the Contrast page's Excel-parsing
                       dependency is never downloaded by someone using the
                       Audit page alone, and vice versa
  pages/
    landing.ts         the "which tool do you want" page
    audit.ts           Audit Tool page: file slots, sanity checks, results
    contrast.ts         Contrast Injection Tool page: file slots, results
  audit.ts              the audit rule engine — protocol normalization,
                        event grouping, CAMS/REDCap matching, the violation
                        checks, the report tables
  contrast.ts            the contrast rule engine — row filtering, per-row
                         billing-code selection, output row construction
  cams.ts                CAMS protocol lookup and the industry-sponsorship
                         test, shared by audit.ts and contrast.ts so the
                         two cannot answer "is this industry?" differently
  parseCsv.ts           CSV parsing (papaparse), tolerant of malformed rows
  parseXlsx.ts           Excel parsing (exceljs), for the Contrast Report
  sanityChecks.ts        required-column and coded-value checks, shared by
                         both tools
  uploadUi.ts             shared upload-row / sanity-check / malformed-row UI
  table.ts                 generic results-table renderer
  nav.ts                    the small "Home · other tool" nav bar
  leaveGuard.ts          asks before leaving a page with unsaved work
  decisions.ts           Fix / Don't fix decisions: the decision keys of
                         each table and the decision CSV columns
  decisionUi.ts          the editable decision cells in the results tables
  savedAudit.ts          builds and reads the saved-audit zip and its manifest
  previousAudit.ts       compares an audit with a previous one: Since
                         Previous Audit labels, carried decisions, earlier
                         decisions
  csvExport.ts           generic CSV export + download
  ruleExplanations.ts    plain-English descriptions shown under each table
  types.ts               shared type definitions
  style.css
test/
  run_test_set_1.ts       runs the audit engine against test_set_1/ from Node
  run_contrast_test_set_1.ts  runs the contrast engine against
                              contrast_test_set_1/ from Node
test_set_1/              sample CSV data for the Audit Tool
contrast_test_set_1/     sample data for the Contrast Injection Tool, plus
                          Contrast.jl, the Julia script this tool replaces
```

`audit.ts`, `contrast.ts`, `cams.ts`, `decisions.ts`, `savedAudit.ts`, and
`previousAudit.ts` are framework-agnostic (no DOM dependency), which is what lets `npm test`
exercise both tools' logic from Node without a browser.

## Design decisions and constraints

Read this before you change `audit.ts`, `cams.ts`, `sanityChecks.ts`, or how
a Dogfish service is recognized. It states rules that are easy to break by
accident.

### Add a new Dogfish service here, not there

`SERVICE_MAP` in `audit.ts` is the one list of known Dogfish services. A
service not in this list has two effects. First, `sanityChecks.ts` flags it
as an unrecognized value. Second, no check counts it as an MRI service — an
add-on fee on the same event wrongly shows on "Add-On Fees Without MRI," and
an animal-format protocol billing it wrongly skips the animal/human check.

To add a service, do three things. Add the exact Dogfish text as a key in
`SERVICE_MAP`. Add a matching field to `ServiceFlags` in `types.ts`. Add that
field to `emptyFlags()` and `orFlags()` in `audit.ts`, and — for an MRI
service — to `hasMriService()`. Do not skip a step — a partial add compiles,
but silently breaks one check. (An add-on fee like Stimulus or the Research
Report Reader stays out of `hasMriService()` on purpose: it is exactly what
the "Add-On Fees Without MRI" check looks for.)

Match the Dogfish text exactly, including case. `sanityChecks.ts` reads its
known-value list from `Object.keys(SERVICE_MAP)` automatically — do not
duplicate the list there.

When Dogfish renames a service, add the new name as a second key on the
same flag, and keep the old name, because older exports still use it. That
is how `Human MRI (industry/external)` and `Human MRI (external)` both map
to `humanMRIExternal`. Code that picks out a service by its flag must then
collect every matching key with `filter()`, as `READER_SERVICES` and
`HUMAN_MRI_EXTERNAL_SERVICES` do. `find()` returns only the first key, and
rows with the other name silently drop out.

### A service flag is not automatically "industry"

`billedIndustry` in `computeFlags()` only checks `humanMRIIndustry` and
`animalMRIIndustry`. A new service flag does not count as industry billing
unless you add it to that line on purpose. Every non-industry variant added
so far (external, after-hours, both Prodev tiers) was deliberately left out.
The external rate is also exempt from the "Industry Billed As Government"
check (`billedExternal` in `computeFlags()`), because it serves external
users whether or not they are industry.

The industry-rate ancillary-fee flags (`stimulusIndustry`,
`neuroreaderIndustry`) are also deliberately not on that line. `billedIndustry`
is about the MRI service code; those two fees have their own dedicated
Stimulus/Neuroreader "Billed As Government" / "Billed As Industry" check in
`computeFlags()`, which reads them directly.

### One definition of "is this protocol industry sponsored?"

Both tools ask that question of CAMS, and must answer it the same way, so the
lookup and the test live once in `cams.ts` — `buildCamsLookup()`,
`normalizeDogfishCamsProtocol()`, and `classifyIndustry()`. The Audit Tool
flags a mismatch between billed rate and sponsorship; the Contrast Injection
Tool picks `CAMRIS-051` vs `CAMRIS-003` from it. "Industry" means a CAMS
record whose "Industry Sponsored" is exactly `"Yes"`; `"No"`, `"Not
Reported"`, and blank all read as not industry; no CAMS record at all is
neither — the caller decides what to do with that (the audit lists it as a
mismatch, and so does contrast). Do not fork this logic into either tool.

### Two sources for industry sponsorship

The audit's rate checks also ask REDCap, as a second source. This does not
fork the CAMS test: CAMS still answers the way `classifyIndustry()` does,
and the Contrast Injection Tool still uses CAMS alone. REDCap says a
protocol is industry when its `funding_type` is 1 ("industry") or 4
("industry funding"); every other code, including the old government code
2, is not industry, and a blank code is no answer
(`REDCAP_INDUSTRY_FUNDING_TYPES` in `audit.ts`).

Each rate check compares the billed rate with both answers, and records
which sources disagree: `CAMS`, `REDCap`, or `CAMS + REDCap`
(`RateDisagreement` in `types.ts`). When both disagree, the two sources
agree with each other and only the billing differs. When only one does,
CAMS and REDCap contradict each other, so the fix may belong in that
source's data rather than in the billing. A source with no answer never
disagrees, and a check with neither answer does not run. REDCap never
overrides CAMS; it is reported beside it.

REDCap is also the only source that marks a CHOP study: `pi_school` 4
(`REDCAP_CHOP_PI_SCHOOL`). A non-industry CHOP study is billed
`Human MRI (Industry/CHOP)` but pays the standard ancillary fees, so only
the MRI rate checks look at it.

CAMS also has "Dogfish Scan Rate" and "PBR Scan Rate" columns. Do not use
either one to check the billed rate. "Dogfish Scan Rate" comes from the
same database as the Dogfish billing, so comparing the two checks the data
against itself. "PBR Scan Rate" does not match Dogfish's rates: many
industry protocols that Dogfish bills `Human MRI (Industry/CHOP)` show
`Human MRI (industry/external)` there.

### A protocol number has one normalized form, but REDCap can give it several names

`normalizeDogfishCamsProtocol()` (in `cams.ts`) strips a Dogfish or CAMS
protocol number down to a 6-digit base, or leaves it unchanged if it's an
animal (`AR` + 6 digits) or `xx-xxxx` protocol. Dogfish and CAMS always agree
on this one normalized form, so a plain lookup by that form works for both.
The Contrast Injection Tool normalizes its "Linked Study IRB Number" the same
way to match CAMS.

REDCap does not follow this rule. Its `irb_protocol_number` field is free
text, and can carry more than one identifier for the same protocol — an
internal tracking number plus a parenthetical real number, for example.
Treat this as expected, not a data error: `extractRedcapProtocolNames()`
returns every identifier-shaped name it finds in the text, and
`buildRedcapLookup()` registers the REDCap record under all of them. Do not
change this back to picking one "correct" name — that was the old design,
and it silently lost real matches.

Because a name is assumed to belong to only one protocol, the same name
showing up on two REDCap rows whose full name sets disagree is treated as a
data problem, not a resubmission, and blocks the audit. Two rows with the
exact same set of names are treated as the same protocol resubmitted, and
the later row wins — this is expected and does not block anything.

### The Prodev suffix check needs the raw protocol number

The Prodev naming check tests the protocol number's ending, before
normalization strips a trailing `-P`. Always run this kind of check against
`protocolNumberRaw`, never against the normalized form used for CAMS/REDCap
matching.

Two reports decide "is this Prodev?": Prodev Naming Consistency and
No-Shows Billed To Prodev Protocols. Both read the same
`PRODEV_PROTOCOL_SUFFIX` and the same `billedProdevTiers()` in `audit.ts`.
Change the Prodev definition there, not in either report.

### No server, no persistence, no shared state between tools

Every file a user uploads is parsed and held in memory in the browser tab; it
is never written to disk, sent over the network, or shared between the two
tool pages. Both pages take their own CAMS Data upload; each parses its own
copy, and neither reuses the other's.

Work carries over between sessions only through a file the user downloads:
the saved audit zip (see [Saving an audit](#saving-an-audit)). Decisions
live in memory until then. Do not move them into `localStorage` or any other
browser storage: the saved audit is the dated record of the audit, and it
must be the one place the decisions are kept.

A decision key is stored in the saved audit's CSV columns, so a later audit
can match decisions to its rows. If you rename an issue label in `audit.ts`
or change what a table's key is made of, decisions saved before the change
will no longer match.

### `exceljs`, not `xlsx`/SheetJS

The Contrast Report can be an Excel file. `exceljs` was chosen over the more
popular `xlsx` (SheetJS) package because `xlsx`'s published npm version has
unpatched high-severity advisories in its file-parsing path, and this tool
parses user-uploaded files. Do not swap it back without re-checking that.

`exceljs` reads an Excel datetime cell into a JS `Date` built from UTC
fields, not local time. Reading such a `Date` with local getters
(`getHours()`, and so on) silently shifts the value by the browser's time
zone offset. Always use the UTC getters (`getUTCFullYear()`, `getUTCHours()`,
and so on) on a `Date` that came from `exceljs`.
