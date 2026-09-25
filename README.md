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
  protocol's approved review letter authorizes

If a file has malformed rows (e.g. an unescaped quote inside a field), parsing
still continues on a best-effort basis, and an expandable box appears under
that file's upload row listing which rows were affected, why, and their
(non-empty) parsed values — so you can decide whether to fix the source file.

The tool matches events to their protocol's CAMS and REDCap records (by a
normalized protocol number) and flags:

- Industry-sponsored protocols billed at the government rate, and vice versa
- Animal protocols billed under a human MRI service code, and vice versa
- Stimulus/Response Equipment or Neuroreader (Research Report Reader) fees that
  were billed but not approved, or approved but never billed
- A Stimulus/Response Equipment or Neuroreader fee billed at the standard rate
  on an industry-sponsored protocol, or at the "(Industry/CHOP)" rate on one
  that isn't — the same rate-vs-sponsorship check applied to Human MRI,
  applied to these ancillary fees
- Neuroreader fees billed on the SC3T or SC7T scanner (Stellar Chance)
- A Prodev-tier service billed on a protocol whose number doesn't carry the
  usual Prodev naming, and vice versa

Full plain-English descriptions of each rule are in an expandable panel under
each results table in the app itself.

### Output tables

1. **Violations by Protocol** — one row per distinct
   `(protocol, violation combination)`, Event ID dropped. Good for seeing which
   protocols have a given problem.
2. **Violations by Event** — one row per billing event, for tracing a specific
   charge back to a specific scan.
3. **Mismatches** — protocols that couldn't be fully checked because they
   weren't found in CAMS, weren't found in an active ("Complete") REDCap
   review, or have a protocol number that doesn't match an expected format.
   Deduped to one row per protocol. (Animal protocols showing "no active
   REDCap match" is expected — REDCap only tracks human IRB applications.)
4. **Prodev Naming Consistency** — events where a Prodev Tier 1/2 service and
   the protocol number's "-P"/"_P"/"Prodev" naming disagree, in either
   direction. A protocol can legitimately use a different naming convention
   and still be correctly billed, so a row here is worth a look, not
   necessarily an error.
5. **Add-On Fees Without MRI** — events billed for a Stimulus/Response
   Equipment and/or Neuroreader fee (at either the standard or
   "(Industry/CHOP)" rate) with no MRI service code on the same event.
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
7. **SC7T Scanner Events** — every raw Dogfish row on the SC7T scanner,
   including no-shows and cancellations, unfiltered by any audit rule.
8. **Human MRI (External) Events** — every raw Dogfish row billed as Human
   MRI (External), on any scanner, unfiltered by any audit rule.

Every table can be exported to CSV from the button above it.

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

`audit.ts`, `contrast.ts`, and `cams.ts` are framework-agnostic (no DOM
dependency), which is what lets `npm test` exercise both tools' logic from
Node without a browser.

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

### A service flag is not automatically "industry"

`billedIndustry` in `computeFlags()` only checks `humanMRIIndustry` and
`animalMRIIndustry`. A new service flag does not count as industry billing
unless you add it to that line on purpose. Every non-industry variant added
so far (External, after-hours, both Prodev tiers) was deliberately left out.

The `(Industry/CHOP)` ancillary-fee flags (`stimulusIndustry`,
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

### No server, no persistence, no shared state between tools

Every file a user uploads is parsed and held in memory in the browser tab; it
is never written to disk, sent over the network, or shared between the two
tool pages. Both pages take their own CAMS Data upload; each parses its own
copy, and neither reuses the other's.

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
