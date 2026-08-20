# CAMRIS Billing Audit

A browser-based tool that checks CAMRIS MRI billing events against a set of audit
rules and reports the violations. Everything runs client-side — CSV parsing and
rule evaluation happen entirely in the browser via the File API. No data is ever
uploaded anywhere; the app can be hosted on any static webserver (or run
offline from `file://`, with caveats — see [Running it](#running-it)).

It's a reimplementation of an original Julia audit script, rebuilt so
non-technical staff can run it from a browser without a Julia environment.

## What it checks

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
- Neuroreader fees billed on the SC3T or SC7T scanner (Stellar Chance)

Full plain-English descriptions of each rule are in an expandable panel under
each results table in the app itself.

## Output tables

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
4. **SC7T Scanner Events** — every raw Dogfish row on the SC7T scanner,
   including no-shows and cancellations, unfiltered by any audit rule.
5. **Add-On Fees Without MRI** — events billed for a Stimulus/Response
   Equipment and/or Neuroreader fee with no MRI service code on the same
   event. These fees are meant to ride along with a scan, so this is a
   data-quality flag independent of the CAMS/REDCap checks above.

Every table can be exported to CSV from the button above it.

## Running it

```bash
npm install
npm run dev      # local dev server with hot reload, for development
npm run build    # produces a static bundle in dist/
npm test         # runs the rule engine against test_set_1/ from Node, no browser needed
```

`dist/` is a fully static site — copy it to any static webserver (nginx,
Apache, S3, GitHub Pages, etc.) and it works as-is.

Opening `dist/index.html` directly via `file://` (double-clicking it) mostly
works too, since the build uses relative asset paths, but Chrome and other
Chromium-based browsers block `<script type="module">` from loading over
`file://` regardless of path — if you hit a blank page that way, serve the
folder instead, e.g. `python3 -m http.server 8080 --directory dist`.

## Project structure

```
src/
  main.ts             UI wiring: file uploads, run button, table rendering, CSV export
  audit.ts             the rule engine — protocol normalization, event grouping,
                        CAMS/REDCap matching, the violation checks, SC7T event
                        listing, and the add-on-without-MRI check
  parseCsv.ts           CSV parsing (papaparse), tolerant of malformed rows
  csvExport.ts          generic CSV export + download
  ruleExplanations.ts   plain-English descriptions shown under each table
  types.ts              shared type definitions
  style.css
test/
  run_test_set_1.ts    runs the engine against test_set_1/ from Node for fast iteration
test_set_1/             sample CSV data for testing
```

`audit.ts` is framework-agnostic (no DOM dependency), which is what lets
`npm test` exercise the same rule logic from Node without a browser.
