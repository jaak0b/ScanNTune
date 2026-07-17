# XY skew/shrinkage golden sample: provenance

## The physical sample

One printed `XY` calibration coupon (the flat plate, `calibration_coupon_xy.stl`, default geometry:
`gridN` 5, i.e. a 5x5 ring lattice, `baselineMm` 100). The owner printed the coupon with a known,
deliberately injected skew of about **0.5 degrees** (the physical ground truth the owner set up to
validate against) and has confirmed the app's measurement of that plate is correct.

Per this repo's approval-test contract, the golden values below freeze the **app's own displayed
output** for the approved case, never the nominal 0.5 injected figure: the app reads back skew
values in the high 0.49 to 0.50 degree range across every capture below, which is what is frozen.

## The scans

Four scans of the same physical XY plate, a quarter turn apart on the glass, at two representative
resolutions (the flow's mandatory low/high boundary-value pair):

- `xy_0d_300dpi_black_white.jpg`, `xy_90d_300dpi_black_white.jpg`, `xy_180d_300dpi_black_white.jpg`, `xy_270d_300dpi_black_white.jpg` (300 dpi)
- `xy_0d_150dpi_black_white.jpg`, `xy_90d_150dpi_black_white.jpg`, `xy_180d_150dpi_black_white.jpg`, `xy_270d_150dpi_black_white.jpg` (150 dpi)

Each scan detects `23 of 23` rings against the plate's own 5x5 geometry (25 grid vertices minus the
2 solid orientation-marker rings), confirming every fixture is a clean, fully-inside-frame scan of
the same physical part.

Recapture 2026-07-14: the owner reprinted the golden plate (the same deliberately injected
~0.5 degree skew) and rescanned all eight fixtures on the same Canon MG3600 scanner, this time
scanned with the first-layer side on the glass per the current face-on-glass flip convention and
saved as JPEG (the `.jpg` files above replace the earlier `.png` set). Every frozen value below was
re-captured from the running app against these scans; the previous PNG set's values are retired
with it. The new scans read `scan-flip` `None` on every fixture.

## Approval tiers, per output family

- **Skew, both-axis scale, and the Klipper firmware command (`SET_SKEW` / `SKEW_PROFILE`):
  hardware-validated.** The owner runs Klipper. The coupon's ~0.5 degree injected skew and the
  app's measured skew agree, and the owner has confirmed the app's measurement (skew and scale) is
  correct for this printed sample. This is the strongest tier: a real printed defect, a real
  firmware family the owner runs, and a real human judgment that the app's reading matches the
  physical part.
- **Marlin (`M852`) and RepRapFirmware (`M556`) commands: owner-reviewed.** The owner does not run
  either firmware on real hardware, so these commands cannot be hardware-validated by a print. Per
  the project's two-tier approval model, the owner instead reviewed the app's emitted Marlin and RRF
  output for this scan (captured below) and judged it correct from domain knowledge (the sign
  convention documented in `correctionFormatter.ts`: RRF's `AxisTransform` adds the factor, opposite
  of Marlin's planner, so the RRF value is the negation of the Marlin-style factor at the same
  physical skew). **These two firmwares' values are recorded here for owner sign-off; they are not
  yet hardware-confirmed and should be reviewed again before being frozen into a committed test.**
- **The reset commands (step 2, `SET_SKEW CLEAR=1` / `M852 I0 J0 K0` / `M556 S100 X0 Y0 Z0`)** are
  static per-firmware boilerplate with no scan-dependent figures; they inherit the same tier as
  their firmware family above (Klipper reset is exercised as part of the owner's real hardware
  workflow; Marlin/RRF resets are owner-reviewed text only).
- **The size fix (`size-code`, "XY shrinkage: N %")** is driven by the "Format" selector, which is
  independent of the Firmware selector (see "Firmware vs. Format are independent controls" below).
  Its default format, Shrinkage %, is a slicer-facing figure with no firmware-specific sign
  convention, so it carries the same tier as the scale figures it is computed from: hardware-validated
  for this Klipper-associated capture.

## Firmware vs. Format are independent controls (important correction to the original test brief)

The XY/skew page has two separate selectors that are easy to conflate:

- **Firmware** (top-right of the page, `Klipper` / `Marlin` / `RepRapFirmware`): drives the step 2
  reset command AND the "Fix skew" tab's `skew-code`. This is a simple `v-select`; there is no
  printer-profile system on this page (unlike PA/EM/IS). Switching it re-renders the already-computed
  skew fix instantly; it does **not** require re-analyzing the scans.
- **Format** (inside the "Fix size" tab, `Shrinkage %` / `Steps/mm` / `Rotation distance` / `Scale %`):
  drives `size-code`. It is completely independent of the Firmware selector: switching Firmware between
  Klipper/Marlin/RepRapFirmware while Format stays on `Shrinkage %` leaves `size-code` unchanged. This
  was confirmed empirically: `size-code` read the identical string (`XY shrinkage: 100.16 %` for the
  300 dpi case) under all three Firmware selections.

Every capture below used the default Format, `Shrinkage %` (the only one of the four formats that
needs no additional user-entered "current steps/mm" or "current rotation distance" input, so it is
reachable with no extra data entry). `size-code` is therefore recorded once per DPI case, not once
per firmware.

## Seed calibration (scanner calibration carve-out)

This flow needs a stored card calibration (see `web/e2e/card-calibration/golden/PROVENANCE.md` and
`card.flow.md`, the dedicated webtest that covers the card-calibration step itself). Per the skill's
seed-state carve-out, the skew webtests seed the calibration directly into `localStorage` rather than
re-running the card UI, using the exact shape `useCalibration.ts` persists under the key
`scanntune.calibration` (`ScannerCalibration` in `web/src/engine/types.ts`).

To get the seed value for each DPI, the card flow was run once for real in the app (sensor `CIS`,
measured long side `85.55` mm) on `web/e2e/card-calibration/golden/card_150dpi.jpg` and
`card_300dpi.jpg`. The 300 dpi run reproduced the already-frozen card golden exactly
(`pxpermm` `11.796`, `effective-dpi` `300`, `vs-nominal` `-0.131 %`), confirming this is the same
capture the card webtest already approved. The 150 dpi run is captured fresh here.

### 150 dpi seed (from `card_150dpi.jpg`)

Displayed: `pxpermm` `5.892`, `effective-dpi` `150`, `vs-nominal` `-0.226 %`, `saved` "Saved, used
for every scan".

`localStorage['scanntune.calibration']` (verbatim, read back from the app after the card flow):

```json
{
  "pxPerMm": 5.89214823680637,
  "dpi": 150,
  "referenceMm": 85.55,
  "measuredWidthPx": 504.07328165878494,
  "straightnessPx": 0.3566679395601973,
  "parallelismDegrees": 0.1834685153880538,
  "calibratedUtc": "2026-07-12T15:51:51.601Z",
  "scannerType": "CIS",
  "measuredAxis": "horizontal"
}
```

### 300 dpi seed (from `card_300dpi.jpg`)

Displayed: `pxpermm` `11.796`, `effective-dpi` `300`, `vs-nominal` `-0.131 %`, `saved` "Saved, used
for every scan" (matches the already-frozen `card.flow.md` 300 dpi case exactly).

`localStorage['scanntune.calibration']` (verbatim):

```json
{
  "pxPerMm": 11.795605844449824,
  "dpi": 300,
  "referenceMm": 85.55,
  "measuredWidthPx": 1009.1140799926824,
  "straightnessPx": 0.8872102214925227,
  "parallelismDegrees": 0.03666165562292687,
  "calibratedUtc": "2026-07-12T15:53:32.665Z",
  "scannerType": "CIS",
  "measuredAxis": "horizontal"
}
```

`calibratedUtc` is not asserted by any test; it only needs to be a valid ISO-8601 string for
`hasFiniteNumbers`/`isUsableCalibration` to accept the seeded object (it is not in the required
finite-number field list, but keeping the captured value is simplest and matches an exact real
capture rather than a fabricated one).

## Coupon geometry

The correct, matching-the-physical-plate values (also the app's own defaults, `defaultCouponSpec()`
in `web/src/engine/types.ts`, and the XY page's own default field values before any scan is loaded):

- **Rings per side (`gridN`)**: **5**
- **Plate baseline (mm) (`baselineMm`)**: **100**

Confirmed live in the app: the "Plate baseline (mm)" and "Rings per side" fields read `100` and `5`
before any scan is uploaded, and every golden scan below detects `23 of 23` rings against this
geometry (5x5 = 25 grid vertices minus the 2 solid marker rings = 23 measurable ring holes).

## Frozen displayed values

Captured by driving the real running app (Vite dev server, same bundle Playwright drives) through
the actual UI: seeded the calibration above via `localStorage`, opened the app (default screen is
already the skew/shrinkage page, no navigation click needed), uploaded the case's scans through the
real `scans-input` file input, waited for each scan's `ring-count` and the plane's
`plane-status-XY` to read "Ready to analyze.", clicked `analyze-btn`, and read the results panel
verbatim. No value below was computed, derived, or read from engine source; every literal is what
the app showed on screen.

### Case: 300 dpi, quarter-turn pair (`xy_0d_300dpi_black_white.jpg` + `xy_90d_300dpi_black_white.jpg`)

Per-scan: `ring-count` `23 of 23` (both), `scan-angle` `359.5°` and `90.1°`, `scan-flip` `None` (both).
`plane-status-XY`: `Ready to analyze.`

| testid | displayed value | tolerance band | rationale |
|---|---|---|---|
| `scale-X` | `+0.144 %` | ± 0.05 percentage points (sign: positive) | The same physical plate's X scale reads +0.144% (0/90 pair), +0.146% (180/270 pair), and +0.145% (all 4 scans) at 300 dpi: a 0.002 pp cross-pairing spread. ± 0.05 pp is well above that noise floor and still catches a sign flip or gross error. |
| `scale-Y` | `+0.117 %` | ± 0.05 percentage points (sign: positive) | Cross-pairing spread at 300 dpi: +0.117% (0/90), +0.107% (180/270), +0.112% (4-scan), a 0.010 pp spread. ± 0.05 pp comfortably covers it. |
| `skew-XY` | `+0.489°` | ± 0.03 degrees (sign: positive) | Cross-pairing spread at 300 dpi: +0.489° (0/90), +0.495° (180/270), +0.492° (4-scan), a 0.006° spread; the 4-scan run's own 95% confidence half-width is ±0.025°. ± 0.03° covers both with a small margin while still failing on a sign flip (which would read about -0.5°, over 30x outside this band). |
| `more-scans-XY` | `XY plate: Scan this plate 2 more times to get a confidence range, which shows how tightly the value is pinned down.` | exact string | Deterministic UI text for exactly 2 measured scans (`MIN_SCANS_FOR_RANGE` is 4 in `scanCombiner.ts`); no range widget renders yet. |
| `zero-note-*` | not present (no element matches `[data-testid^="zero-note"]`) | exact (absent) | Every figure is well outside its (not-yet-shown) confidence range at zero; no "well calibrated" or "no correction needed" note applies. |

**Firmware commands, per firmware (Klipper hardware-validated; Marlin/RRF owner-reviewed, pending
explicit owner sign-off on the literal strings below):**

| firmware | reset command (step 2, always shown regardless of scan) | `skew-code` (exact text) |
|---|---|---|
| Klipper | `SET_SKEW CLEAR=1` | `Paste into the Klipper console:`<br>`SET_SKEW XY=99.575,100.427,70.713`<br>`SKEW_PROFILE SAVE=ScanNTune`<br>`SAVE_CONFIG` |
| Marlin | `M852 I0 J0 K0`<br>`M500` | `M852 I-0.008528`<br>`M500` |
| RepRapFirmware | `M556 S100 X0 Y0 Z0` | `M556 S100 X0.853` |

`skew-code`'s displayed text includes the caption line ("Paste into the Klipper console:") because
the `data-testid="skew-code"` attribute lands on `CodeBlock`'s outer wrapper div (Vue attribute
fallthrough), which contains both the caption paragraph and the `<pre>` code; Marlin and RRF have no
caption for this correction, so their `skew-code` text is only the command lines. Assert the whole
displayed string exactly, newlines included; there is no partial/regex assertion in this suite.

`size-code` (Format: `Shrinkage %`, same value under all three firmware selections):
**`XY shrinkage: 100.13 %`**

### Case: 150 dpi, quarter-turn pair (`xy_0d_150dpi_black_white.jpg` + `xy_90d_150dpi_black_white.jpg`)

Per-scan: `ring-count` `23 of 23` (both), `scan-angle` `359.5°` and `90.1°`, `scan-flip` `None` (both).
`plane-status-XY`: `Ready to analyze.`

| testid | displayed value | tolerance band | rationale |
|---|---|---|---|
| `scale-X` | `+0.243 %` | ± 0.05 percentage points (sign: positive) | Cross-pairing spread at 150 dpi: +0.243% (0/90), +0.240% (180/270), +0.242% (4-scan), a 0.003 pp spread. Same band as the 300 dpi case for consistency and margin. |
| `scale-Y` | `+0.216 %` | ± 0.05 percentage points (sign: positive) | Cross-pairing spread at 150 dpi: +0.216% (0/90), +0.199% (180/270), +0.208% (4-scan), a 0.017 pp spread. |
| `skew-XY` | `+0.486°` | ± 0.03 degrees (sign: positive) | Cross-pairing spread at 150 dpi: +0.486° (0/90), +0.499° (180/270), +0.493° (4-scan), a 0.013° spread; the 4-scan run's own 95% half-width is ±0.025°. ± 0.03° covers this with a small margin. |
| `more-scans-XY` | `XY plate: Scan this plate 2 more times to get a confidence range, which shows how tightly the value is pinned down.` | exact string | Same rationale as the 300 dpi case. |
| `zero-note-*` | not present | exact (absent) | Same rationale as the 300 dpi case. |

**Firmware commands, per firmware:**

| firmware | reset command | `skew-code` (exact text) |
|---|---|---|
| Klipper | `SET_SKEW CLEAR=1` | `Paste into the Klipper console:`<br>`SET_SKEW XY=99.577,100.425,70.713`<br>`SKEW_PROFILE SAVE=ScanNTune`<br>`SAVE_CONFIG` |
| Marlin | `M852 I0 J0 K0`<br>`M500` | `M852 I-0.008475`<br>`M500` |
| RepRapFirmware | `M556 S100 X0 Y0 Z0` | `M556 S100 X0.848` |

`size-code` (Format: `Shrinkage %`): **`XY shrinkage: 100.23 %`**

## Rotation-robustness finding (not computed, read directly off the app for each pairing)

The app was run three ways per DPI on the same physical plate's four quarter-turn scans: the 0/90
pair, the 180/270 pair, and all four scans together (which also unlocks a 95% confidence range,
`MIN_SCANS_FOR_RANGE` being 4). All three readings agree closely; nothing here was averaged or
computed by hand, each row is a separate, independently-captured app run.

### 300 dpi

| scan set | `scale-X` | `scale-Y` | `skew-XY` | `size-code` |
|---|---|---|---|---|
| 0d + 90d | `+0.144 %` | `+0.117 %` | `+0.489°` | `XY shrinkage: 100.13 %` |
| 180d + 270d | `+0.146 %` | `+0.107 %` | `+0.495°` | `XY shrinkage: 100.13 %` |
| all 4 (0/90/180/270) | `+0.145 %` | `+0.112 %` | `+0.492°` | `XY shrinkage: 100.13 %` |
| all 4, `range-scaleX-XY` | | | | `Likely between +0.128 % and +0.162 % (95% from 4 scans).` |
| all 4, `range-scaleY-XY` | | | | `Likely between +0.095 % and +0.129 % (95% from 4 scans).` |
| all 4, `range-skew-XY` | | | | `Likely between +0.467° and +0.517° (95% from 4 scans).` |

### 150 dpi

| scan set | `scale-X` | `scale-Y` | `skew-XY` |
|---|---|---|---|
| 0d + 90d | `+0.243 %` | `+0.216 %` | `+0.486°` |
| 180d + 270d | `+0.240 %` | `+0.199 %` | `+0.499°` |
| all 4 (0/90/180/270) | `+0.242 %` | `+0.208 %` | `+0.493°` |
| all 4, `range-scaleX-XY` | | | `Likely between +0.226 % and +0.257 % (95% from 4 scans).` |
| all 4, `range-scaleY-XY` | | | `Likely between +0.192 % and +0.223 % (95% from 4 scans).` |
| all 4, `range-skew-XY` | | | `Likely between +0.468° and +0.517° (95% from 4 scans).` |

**Conclusion: the app's readings do NOT depend on which quarter-turn pairing is used.** Every
pairing (0/90, 180/270, all 4) agrees to within about 0.02 percentage points on scale and about
0.013 degrees on skew, at both DPIs. This is well inside the tolerance bands chosen above, and is
the empirical basis for those bands. There is **one shared golden value set per DPI**, not a
separate golden per orientation pairing; the flow spec's mandatory case table uses the 0/90 pairing
(the pairing named in the fixture-naming convention and in the task brief) as the canonical
capture, and the 180/270 and all-4 figures above exist to support the tolerance-band rationale and
as an optional extra case demonstrating the confidence-range feature.

## Rejection cases

### 3.1 Two scans at (nearly) the same angle: hard-blocked before Analyze, no exception thrown

Uploaded `xy_0d_300dpi_black_white.jpg` twice (renamed on upload so the app treats them as two distinct scans;
the underlying image bytes are identical). Calibration seeded at 300 dpi.

Result: both scans individually measure fine (`ring-count` `23 of 23` each, `scan-angle` `359.5°` for
both), but the group is flagged, `analyze-btn` is disabled, and no exception is thrown; this is the
scan-set-level rejection path per rule 2 (a scan that cannot be combined is a normal outcome, not an
exception).

| testid | value |
|---|---|
| `plane-status-XY` | `These two scans are only 0 degrees apart. Turn the plate further, about a quarter turn, and scan it again so the app can separate scale from skew.` |
| `analyze-reason` | `XY plate: These two scans are only 0 degrees apart. Turn the plate further, about a quarter turn, and scan it again so the app can separate scale from skew.` |
| `analyze-btn` (disabled state) | `true` |
| pill text on the second scan's island (no dedicated testid; class `.pill`) | `Nearly same angle` |

The exact wording is generated from the measured spread (`Math.round(spreadDegrees)`), so this
message text is specific to a spread that rounds to 0 degrees; a real near-duplicate at, say, 12
degrees would read a different number in the same template. This capture (spread = 0) is the
canonical, deterministic case for the golden set: two scans of the literal same file.

> **Re-captured against commit 181ba92** ("Unify per-scan resolution validation across all
> calibration flows"). The earlier soft `scale-mismatch-warning` path is gone. Both 3.4 and 3.5 are
> now **pre-analyze hard blocks**: each measured scan gets a per-scan resolution verdict (its
> geometrically measured px/mm judged against the expected resolution, i.e. the seeded card
> calibration's DPI, and against the rest of the set), a failing scan shows a "Wrong resolution"
> badge on its own card, and `analyze-btn` is disabled with a gate message. No result panel ever
> renders. Logic lives in `web/src/engine/resolutionGate.ts` and `web/src/util/scanResolution.ts`,
> wired into `ScanPage.vue`/`ScanIsland.vue`.

### 3.4 Mixed-resolution scan pair (one scan matches the calibration DPI, one does not): hard block, one scan flagged

Uploaded `xy_0d_300dpi_black_white.jpg` (true 300 dpi) + `xy_90d_150dpi_black_white.jpg` (true 150 dpi) together as one
plate's scan set, with the calibration seeded at 300 dpi.

Both scans still measure their rings fine (`23 of 23` each) and the plate's angle spread is fine
(`plane-status-XY` reads `Ready to analyze.`, since that status reflects only the angle-spread and
mirror-flip checks, not resolution). But the 150 dpi scan is flagged on its own card and the analyze
button is disabled. **No result panel renders** (`analyze-btn` disabled, clicking it is a no-op;
`scale-X` is absent, no "Start over" button appears).

Per-scan cards:

| scan | `scan-resolution` row | pill (class `.pill`, no testid) | `failure-reason` explanation |
|---|---|---|---|
| `xy_0d_300dpi_black_white.jpg` (359.5°) | `about 300 dpi` | `XY plane` (ok) | (none) |
| `xy_90d_150dpi_black_white.jpg` (90.1°) | `about 150 dpi` | `Wrong resolution` (err) | `This scan measures about 150 dpi, but the expected resolution is 300 dpi. Rescan at the expected resolution, or recalibrate the scanner at this one.` |

Analyze gate:

| testid | value |
|---|---|
| `analyze-btn` (disabled state) | `true` |
| `analyze-reason` | `One scan measures a wrong resolution; replace it to analyze.` (singular: exactly one scan flagged) |
| `scale-X` (result panel) | absent (no result renders) |

### 3.5 Both scans at a DPI different from the calibration (uniform 2x mismatch): hard block, both scans flagged

Uploaded `xy_0d_150dpi_black_white.jpg` + `xy_90d_150dpi_black_white.jpg` (both native 150 dpi), calibration seeded at
300 dpi.

Both scans measure fine individually (`23 of 23` rings, angle spread fine), but **both** fail the
resolution verdict against the expected 300 dpi, so both cards show the "Wrong resolution" badge and
the analyze button is disabled with the plural gate message. **No result panel renders.**

Per-scan cards (identical on both):

| scan | `scan-resolution` row | pill (class `.pill`, no testid) | `failure-reason` explanation |
|---|---|---|---|
| `xy_0d_150dpi_black_white.jpg` (359.5°) | `about 150 dpi` | `Wrong resolution` (err) | `This scan measures about 150 dpi, but the expected resolution is 300 dpi. Rescan at the expected resolution, or recalibrate the scanner at this one.` |
| `xy_90d_150dpi_black_white.jpg` (90.1°) | `about 150 dpi` | `Wrong resolution` (err) | (same string as above) |

Analyze gate:

| testid | value |
|---|---|
| `analyze-btn` (disabled state) | `true` |
| `analyze-reason` | `2 scans measure a wrong resolution; replace them to analyze.` (plural: both scans flagged) |
| `scale-X` (result panel) | absent (no result renders) |

This is the flow's mandatory "resolution mismatch is refused" rejection case: a genuine pre-analyze
hard block, not a soft warning. It is the closest skew analogue to the card flow's resolution-gate
refusal, and unlike the pre-181ba92 behavior it produces no (wrong) result at all.

### 3.6 Wrong declared coupon geometry: hard refusal, before Analyze

Correct geometry (see "Coupon geometry" above): rings per side `5`, plate baseline `100` mm. Entered
instead: rings per side **`6`**, plate baseline **`150`** mm (larger than the real plate), then
uploaded the valid, matching-calibration `xy_0d_300dpi_black_white.jpg` + `xy_90d_300dpi_black_white.jpg` pair (calibration
seeded at 300 dpi).

Both scans fail individually (the ring detector searches for a 6x6 grid's marker pattern against an
actual 5x5 physical plate):

| testid | value |
|---|---|
| `ring-count` (both scans) | `4 of 34` (34 = 6x6 grid vertices minus the 2 solid marker rings; against the wrong declared geometry the size cluster keeps only 4 candidate rings) |
| `failure-reason` (both scans) | `The coupon pattern was not found: only 4 of its 34 measurement rings were detected. Make sure the whole coupon lies inside the scan area on a plain, single-colour background, then scan again.` |
| pill text on both islands (class `.pill`) | `Not aligned` |
| `analyze-btn` (disabled state) | `true` |
| `analyze-reason` | `Fix 2 scans to analyze.` |

This is a clean, deterministic hard refusal: no plane group even forms (`plane-status-XY` does not
render), because neither scan reached the `Measured` state.

## Open items for the owner

1. **Marlin and RepRapFirmware command strings** (both DPI cases' `skew-code`, plus the static reset
   commands) are recorded above from the running app but need the owner's explicit review sign-off
   per the owner-reviewed tier, since the owner does not run either firmware on physical hardware.
2. **Resolution-mismatch handling is now correct (commit 181ba92); both 3.4 and 3.5 are handled, not
   gaps.** The former soft-warning / silent-accept behavior is gone. A per-scan resolution verdict
   now flags any scan whose measured resolution disagrees with the seeded calibration's DPI (or with
   the rest of the set), and the analyze button is disabled before any result is produced. Both the
   mixed pair (3.4, one scan flagged, singular gate message) and the uniform mismatch (3.5, both
   scans flagged, plural gate message) are pre-analyze hard blocks with no result panel. Regression
   check confirmed: the valid 300 dpi pair still produces the identical frozen values (`scale-X`
   `+0.144 %`, `scale-Y` `+0.117 %`, `skew-XY` `+0.489°`, Klipper `SET_SKEW XY=99.575,100.427,70.713`,
   `size-code` `XY shrinkage: 100.13 %`), so the guard did not move the measurement.
3. **No testid exists yet** on the step 2 reset-command `CodeBlock`, nor on the Klipper skew fix's
   secondary `CodeBlock` (the `SKEW_PROFILE LOAD=ScanNTune` start-gcode line). Both were located and
   read in this capture session via `document.querySelectorAll('pre.code')` / plain DOM traversal,
   not by testid. Per this repo's convention, phase 2 should add real testids (for example
   `reset-skew-code` and `skew-code-secondary`) before writing assertions against them, rather than
   selecting by tag/class.
4. **No testid exists yet** on the "Plate baseline (mm)" and "Rings per side" `NumericField`
   instances on the skew page (mirrors the same gap the card flow already found and fixed for its
   own two numeric fields). Phase 2 needs these to drive the 3.6 rejection case without a label-text
   selector; suggested names `baseline-mm-input` and `grid-n-input`.
5. **The "Wrong resolution" badge has no dedicated testid.** It renders in the scan card's status
   pill (`ScanIsland.vue`, class `.pill` with severity class `err`, no `data-testid`), and its
   explanation reuses the generic `failure-reason` testid shared by every scan-card note. To assert
   the badge specifically (rather than via the `.pill` class or the shared `failure-reason` string),
   phase 2 should add a testid, for example `scan-resolution-badge`, on that pill. The per-scan raw
   resolution row already has a testid (`scan-resolution`, e.g. `about 300 dpi` / `about 150 dpi`),
   and the analyze-gate message already has one (`analyze-reason`), so those two need nothing added.
