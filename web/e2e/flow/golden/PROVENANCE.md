# Flow (EM) golden sample: wide-gap coupon, provenance

## The physical sample

A single-color, dark ASA test coupon printed from the wide-gap `em/gcodeGenerator.ts` spec
(`feature/em-wide-gaps`): pitch sweep 1.14 to 1.35 mm, 9 blocks per row, 5 lines per block,
nominal line width 0.42 mm, matching the default printer profile's 0.4 mm nozzle
(`nozzleDiameterMm * NOMINAL_WIDTH_FACTOR`). The default test settings (no field in "Test
settings" was changed from what a freshly created printer profile computes) reproduce this
spec exactly, so no settings form fields need to be touched to reproduce these captures.

Two scans of the coupon were taken, each at 0 degrees and again with the coupon rotated 180
degrees on the glass (the optional second orientation the flow supports to cancel one-sided
scanner-lamp shading), at two representative resolutions: 600 dpi (native) and 300 dpi
(native). All four are real flatbed scans, JPEG, unmodified byte-for-byte copies of the
originals (no resampling, per the project's rule against downscaling any scan image anywhere).

Source images (owner's capture session, `ScanNTune/Data/EM`):

- `em_widegap_0d_600dpi_black_white.jpg` (from `skew_0_600dpi.jpg`)
- `em_widegap_180d_600dpi_black_white.jpg` (from `skew_180_600dpi.jpg`)
- `em_widegap_0d_300dpi_black_white.jpg` (from `skew_0_300dpi.jpg`)

The matching 300 dpi rotated scan (`skew_180_300dpi.jpg`) exists in the owner's capture
session but was not run through the app to produce a combined-pair result in this session, so
no 300 dpi pair case is frozen here; only the single-scan 300 dpi result is frozen (see below).

## Scanner calibration used

CIS sensor, scale reference computed at each scan's own DPI (`px/mm = dpi / 25.4`, the flow's
standard scanner calibration relationship, not a fudge specific to this fixture):

- 600 dpi: `pxPerMm = 23.622`
- 300 dpi: `pxPerMm = 11.811`

Seeded directly into `localStorage` via the `seedCalibration` helper (the scanner-calibration
flow has its own dedicated webtest, `web/e2e/card-calibration/card.spec.ts`, per the writing-webtests
skill's seed-state carve-out), since this fixture pair was not captured through the card-calibration
UI in this session.

## Approval tier: owner-reviewed

The owner ran the flow's measurement pipeline directly against these real scans (outside the
Playwright UI, via the same engine/worker code path the app uses) and reviewed the resulting
per-scan and combined-pair numbers as plausible and internally consistent (block counts,
bias, pitch scale, and the flow correction agree closely between the 0 and 180 degree
orientations and between the two DPIs). This is the "owner inspected the output and judged it
correct from domain knowledge" tier: there is no printed correction applied back to a printer in
this capture session, so hardware validation does not apply; the values below are frozen as the
webtest's golden expectations under the owner-reviewed tier.

## Frozen values (captured by running the analysis, not through the Playwright UI in this
## session; the webtest re-derives the same numbers by driving the real UI end to end)

Spec header for every case: pitch 1.14 to 1.35 mm, 9 blocks x 5 lines, nominal line width
0.42 mm.

### Case: 600 dpi pair (`em_widegap_0d_600dpi_black_white.jpg` + `em_widegap_180d_600dpi_black_white.jpg`)

| field | value | tolerance | rationale |
|---|---|---|---|
| new slicer flow (entered current flow 1.0) | 1.1174 | ± 0.01 | Re-derived from the frozen width (see "Flow output in the rounded bead model" below): 0.084 / (0.2 x (0.4188 - 0.2 x (1 - pi / 4))) = 0.084 / 0.0751759 = 1.1174. The band still covers the propagated uncertainty: the width's standard error (about 0.0014 mm) times the rounded model's width sensitivity (1.114) gives about 0.004, plus UI rounding (`toFixed(3)`). |
| measured line width | 0.4188 mm | ± 0.01 mm | Same margin rationale; the two single-scan widths (0.4175, 0.4202) bracket this by about 0.001 mm either side. |
| blocks measured | 36 of 36 | exact | 18 blocks per scan (9 blocks x 2 rows) x 2 scans; both scans align and every block is measured, no dropped blocks. |
| separator check (bias) | 0.0025 mm | ± 0.003 mm | Matches the pipeline's `biasMm=0.0025`; band covers rounding. |
| pitch scale | 0.9956 | ± 0.003 | Matches the pipeline's `pitchScale=0.99560` (average of the two per-scan pitch scales 0.99571 and 0.99550); band covers rounding and the per-scan spread. |

### Case: 600 dpi single scan (0 degrees only, `em_widegap_0d_600dpi_black_white.jpg`)

| field | value | tolerance | rationale |
|---|---|---|---|
| new slicer flow (entered current flow 1.0) | 1.1213 | ± 0.015 | Re-derived from the frozen width: 0.084 / (0.2 x (0.4175 - 0.0429204)) = 0.084 / 0.0749159 = 1.1213. The originally stated uncertainty (± 0.0051) scaled by the width sensitivity (about 1.11) is about ± 0.006, inside the band. |
| measured line width | 0.4175 mm | ± 0.01 mm | Direct pipeline output `wMm=0.4175`. |
| blocks measured | 18 of 18 | exact | 9 blocks x 2 rows, single scan, full detection. |
| separator check (bias) | 0.0015 mm | ± 0.003 mm | Matches pipeline's `biasMm=0.0015`. |
| pitch scale | 0.9957 | ± 0.003 | Matches pipeline's `pitchScale=0.99571`. |

### Case: 300 dpi single scan (0 degrees only, `em_widegap_0d_300dpi_black_white.jpg`)

| field | value | tolerance | rationale |
|---|---|---|---|
| new slicer flow (entered current flow 1.0) | 1.1213 | ± 0.015 | Re-derived from the frozen width, which equals the 600 dpi single scan's, so the same 0.084 / 0.0749159 = 1.1213 (both read the same physical bead width against the same nominal). The originally stated uncertainty (± 0.0022) scaled by the width sensitivity is about ± 0.003, inside the band. |
| measured line width | 0.4175 mm | ± 0.01 mm | Direct pipeline output `wMm=0.4175`, matching the 600 dpi single-scan capture at the same orientation, cross-DPI agreement. |
| blocks measured | 18 of 18 | exact | 9 blocks x 2 rows, single scan, full detection at the lower resolution. |
| separator check (bias) | 0.0001 mm | ± 0.003 mm | Matches pipeline's `biasMm=0.0001`. |
| pitch scale | 0.9962 | ± 0.003 | Matches pipeline's `pitchScale=0.99623`. |

## Flow output in the rounded bead model

The new slicer flow rows were first frozen as nominal width over measured width (1.0028 for the
pair, 1.0060 for each single scan). The flow output was then moved to the bead model PrusaSlicer,
OrcaSlicer and SuperSlicer slice with (PrusaSlicer `Flow::mm3_per_mm`, a rectangle with
semicircular ends): new flow = the cross-section the coupon commanded / h x (w - h x (1 - pi / 4))
at the measured width w and layer height h. The measurement is unchanged, so the frozen widths
(0.4188 and 0.4175 mm) still stand, and the flow rows above are re-derived from them with the
coupon this sample was printed from: a 0.42 x 0.2 mm rectangle, 0.084 mm^2, and
h x (1 - pi / 4) = 0.0429204 mm at h = 0.2 mm. These flow rows are a formula check on the frozen
widths, not a new owner capture; the widths and every other row keep their owner-reviewed tier.

## Gaps for the phase 2 implementer

- No 300 dpi pair case is frozen: only the 300 dpi 0-degree single scan has a full pipeline
  capture in this session's notes. A 300 dpi pair case can be added once the pipeline is run
  against `skew_0_300dpi.jpg` + `skew_180_300dpi.jpg` together and the owner reviews that
  combined result.
- These values were captured by running the measurement pipeline directly rather than by
  driving the app's Playwright UI end to end in this session (unlike the card-calibration
  golden set, which was captured through the live UI). The webtest itself is the first time
  these numbers are read off the actual rendered UI; if the UI's displayed value falls outside
  the stated tolerance band, treat that as a real discrepancy to investigate, not a reason to
  widen the band.
