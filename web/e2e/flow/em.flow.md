# Flow spec: extrusion multiplier (flow) calibration, wide-gap coupon

Feature folder: `web/e2e/flow/`. Golden sample set and its provenance:
`web/e2e/flow/golden/PROVENANCE.md`. All literal values in this spec are copied verbatim from
that file; none are computed here.

This flow depends on scanner calibration for its scale reference. Per the writing-webtests
skill's seed-state carve-out, the scanner calibration is seeded directly into `localStorage`
via `web/e2e/helpers/seedCalibration.ts` rather than re-run through the card-calibration UI
(card calibration has its own dedicated webtest, `web/e2e/card-calibration/card.spec.ts`). It
also depends on a printer profile existing; one is created fresh through the real profile UI
in every case (defaults are valid, only the name is entered).

## Case table

| case | fixtures | resolution | seeded px/mm |
|---|---|---|---|
| 600 dpi pair | `golden/em_widegap_0_600dpi.jpg`, `golden/em_widegap_180_600dpi.jpg` | 600 dpi | 23.622 |
| 600 dpi single scan | `golden/em_widegap_0_600dpi.jpg` | 600 dpi | 23.622 |
| 300 dpi single scan | `golden/em_widegap_0_300dpi.jpg` | 300 dpi | 11.811 |

All three cases share the identical journey below and differ only in the fixture(s), the
seeded calibration, and the expected literals in "Assertions per case". Generate one named test
per row from a shared body; do not duplicate the test body.

## User journey (identical for all cases)

1. Seed the scanner calibration into `localStorage` before navigation, via
   `seedCalibration(page, { pxPerMm, dpi, referenceMm: 85.6, measuredWidthPx: pxPerMm * 85.6,
   straightnessPx: 0.1, parallelismDegrees: 0.02, calibratedUtc: '2026-07-01T00:00:00.000Z',
   scannerType: 'CIS', measuredAxis: 'horizontal' })`. The seed shape mirrors
   `ScannerCalibration`; `measuredWidthPx` is filled from `pxPerMm * referenceMm` so the object
   is internally consistent, not itself an assertion target.
2. Open the app at its entry page and click the "Flow calibration" nav button (`data-testid="nav-em"`).
   The page heading reads "Flow calibration".
3. Since no printer profile exists yet, click `profile-new` (`data-testid="profile-new"`), wait
   for `profile-page` (`data-testid="profile-page"`) to be visible, fill the field labeled
   "Profile name" with `E2E Printer` (defaults for every other profile field are valid and left
   untouched, including the 0.4 mm nozzle that produces this coupon's spec: pitch 1.14 to 1.35 mm,
   9 blocks x 5 lines, nominal line width 0.42 mm), then click `profile-save`
   (`data-testid="profile-save"`). This returns to the Flow calibration page with the new
   profile selected.
4. Leave every "Test settings" field at its default (they already reproduce the golden spec
   above; do not change pitch, block count, lines per block, or print speed).
5. In "Current slicer flow" (`data-testid="em-current-flow"`), enter `1`. The corrected flow the
   result panel shows is always relative to this entered value; entering `1` also gates the
   Analyze button open (blank leaves it disabled).
6. Upload the case's fixture(s) through the real file input `em-scan-input`
   (`data-testid="em-scan-input"`, `<input type="file" multiple>`) via `setInputFiles`, passing
   both fixture paths at once for the pair case and a single path for the single-scan cases.
7. Click `em-analyze` (`data-testid="em-analyze"`).
8. Wait for `em-width` (`data-testid="em-width"`) to become visible (analysis on a real
   scan takes well over a minute; do not shrink the wait timeout below 120000 ms, per the
   skill's standard EM wait precedent). Assert `em-scan-error` (`data-testid="em-scan-error"`)
   and `em-failure` (`data-testid="em-failure"`) both have count 0: the scan must not have been
   rejected.
9. Read the result tiles and facts off the result panel, per "Assertions per case" below.

## Assertions per case

Every value below is copied verbatim from `PROVENANCE.md`; the tolerance bands are the literal
bands recorded there, not computed by the test.

### Case: 600 dpi pair

| testid | assertion |
|---|---|
| `em-flow` | leading number `1.0028` within ± 0.01 (text is `"<factor> ± <uncertainty>"`, e.g. `1.003 ± 0.003`; parse the leading number) |
| `em-width` | `0.4188` mm within ± 0.01 mm (text is `"<value> mm"`, parse the leading number) |
| `em-blocks` | exact text `36 of 36` |
| `em-bias` | leading number `0.0025` mm within ± 0.003 mm (text is `"separator check <value> mm"`) |
| `em-pitch-scale` | leading number `0.9956` within ± 0.003 (text is `"pitch scale <value>"`) |

### Case: 600 dpi single scan

| testid | assertion |
|---|---|
| `em-flow` | leading number `1.0060` within ± 0.015 |
| `em-width` | `0.4175` mm within ± 0.01 mm |
| `em-blocks` | exact text `18 of 18` |
| `em-bias` | leading number `0.0015` mm within ± 0.003 mm |
| `em-pitch-scale` | leading number `0.9957` within ± 0.003 |

### Case: 300 dpi single scan

| testid | assertion |
|---|---|
| `em-flow` | leading number `1.0060` within ± 0.015 |
| `em-width` | `0.4175` mm within ± 0.01 mm |
| `em-blocks` | exact text `18 of 18` |
| `em-bias` | leading number `0.0001` mm within ± 0.003 mm |
| `em-pitch-scale` | leading number `0.9962` within ± 0.003 |

All numeric fields are read with `innerText()` on their `data-testid` element and parsed with
`parseFloat` on the leading number (each string carries a fixed unit or label prefix/suffix
around the number, per the testid inventory above); `em-blocks` is a plain count string, string
matched exactly.

## Notes for the phase 2 implementer

- This is the wide-gap EM coupon (`feature/em-wide-gaps`): pitch sweep raised to 1.14-1.35 mm
  from the earlier 0.70-1.10 mm range: use the current default spec, do not hand-enter the old
  range.
- No 300 dpi pair case exists yet (see `PROVENANCE.md` gaps); only 600 dpi pair and single-scan
  cases at both resolutions are covered here.
- No rejection case is added by this spec: the flow's existing rejection coverage (missing
  calibration, mismatched fiducials) is out of scope for this wide-gap golden set addition and
  is not being changed here.
