# Flow spec: XY skew/shrinkage calibration

Feature folder: `web/e2e/skew-shrinkage/`. Golden sample set and its provenance:
`web/e2e/skew-shrinkage/golden/PROVENANCE.md`. All literal values in this spec are copied verbatim
from that file; none are computed here. This is a phase 1 spec only: no `.spec.ts` exists yet and
none should be written from this document without the owner's review of `PROVENANCE.md`'s open
items (Marlin/RRF sign-off, the 3.4 gap).

This spec covers the `XY` plane only. `XZ` and `YZ` (the standing plates) need their own golden
sample sets and their own flow specs; they are out of scope here.

## Dependency: scanner calibration (seed-state carve-out)

This flow needs a stored card calibration. Per the skill's carve-out, seed it directly via
`page.addInitScript` into `localStorage['scanntune.calibration']` using the exact shape
`useCalibration.ts` persists (`ScannerCalibration` in `web/src/engine/types.ts`), rather than
re-running the card UI inside every skew test. The dedicated webtest that covers the seeded step
itself is `web/e2e/card-calibration/card.spec.ts`. The two seed objects (one per DPI case below) are
recorded verbatim in `PROVENANCE.md` under "Seed calibration"; copy them exactly, do not
regenerate or recompute them.

## Case 1: step-3 plate picker and download note (owner-confirmed)

The step-3 "Print the plate(s)" section shows a plate-specific note only when a standing plate (XZ
or YZ) is selected: the flat XY plate needs no brim, the standing plates do. The owner confirmed
this behavior from the running app with screenshots. There is no XY-specific note; the always-present
base guidance ("Print it exactly as downloaded. Do not rotate or mirror it..." and "Let the bed cool
before removing the plate.") shows regardless of selection. This case needs no scan, no seed
calibration, and no analysis: it drives the plate picker only.

The download button carries `data-testid="plate-download-button"` (ScanPage.vue). The brim note
carries `data-testid="plate-brim-tip"` (ScanPage.vue). The plate cards carry
`data-testid="plate-select-{xy,xz,yz}"`. No new testid is required.

Journey and assertions (every literal below copied verbatim from the running app / the owner's
screenshots, none invented):

1. Open the app at its entry page (`page.goto('/')`); the default screen is the skew/shrinkage page.
2. Default state (only the XY plate card selected, the app's default):
   - `plate-brim-tip` (`data-testid="plate-brim-tip"`): element count `0` (absent).
   - `plate-download-button` (`data-testid="plate-download-button"`): exact text `Download XY plate`.
   - The always-present base note is shown: the text `Print it exactly as downloaded.` is present
     (count `1`), and the text `Let the bed cool before removing the plate.` is present (count `1`).
3. Click the XZ (standing) plate card (`data-testid="plate-select-xz"`) so XY and XZ are both
   selected.
4. XY + XZ state:
   - `plate-brim-tip` is now present, with exact text:
     `Add an 8 mm brim to the outer side; peel it off and file the edge smooth before scanning. Thin-edge plates lift at the corners without one.`
   - `plate-download-button`: exact text `Download XY + XZ plates`.

Note on the brim-tip text: the source renders `8&nbsp;mm` (a non-breaking space) and splits the
sentence across the `<strong>` boundary, but the DOM `innerText` (and Playwright's whitespace-
normalized `toHaveText`) reads it as the single-spaced string above; assert that string exactly.

## Case table (boundary-value pair: low DPI, high DPI)

| case | fixtures | seed calibration | expected `scale-X` | expected `scale-Y` | expected `skew-XY` |
|---|---|---|---|---|---|
| 300 dpi | `golden/xy_0d_300dpi_black_white.jpg` + `golden/xy_90d_300dpi_black_white.jpg` | 300 dpi seed (below) | `+0.144 %` | `+0.117 %` | `+0.489°` |
| 150 dpi | `golden/xy_0d_150dpi_black_white.jpg` + `golden/xy_90d_150dpi_black_white.jpg` | 150 dpi seed (below) | `+0.243 %` | `+0.216 %` | `+0.486°` |

Both cases share the identical journey below and differ only in the fixtures, the seed calibration,
and the expected literals in "Assertions per case". Generate one named test per row from a shared
body, per the skill's case-table parametrization; do not duplicate the test body and do not upload
both cases' fixtures inside one test. Tolerance bands (± 0.05 percentage points for scale, ± 0.03
degrees for skew) are stated once in "Assertions per case" and apply to both rows identically; see
`PROVENANCE.md` for the observed-spread rationale behind each band.

## User journey (identical for both cases)

1. Before navigation, call `page.addInitScript` to write the case's seed calibration object (copied
   verbatim from `PROVENANCE.md`) as a JSON string into `localStorage['scanntune.calibration']`.
2. Open the app at its entry page (`page.goto('/')`). The default screen is already the
   skew/shrinkage page (no navigation click is needed, unlike the card flow, which requires clicking
   into a separate screen).
3. Assert the seeded calibration took effect: `calibration-status-line`
   (`data-testid="calibration-status-line"`) reads exactly `${dpi} dpi` (`300 dpi` or `150 dpi`).
4. Assert the step 4 scan-DPI hint tracks the seeded DPI: locate the `<p class="tip">` element whose
   text starts with `Scan every plate at`; it reads exactly
   `Scan every plate at ${dpi} dpi, the DPI the scanner was calibrated at.` (`300` or `150`). This
   element has no testid today; add one (for example `scan-dpi-hint`) rather than selecting by
   partial text, per this repo's testid convention.
5. Upload both of the case's fixtures at once through the real file input `scans-input`
   (`data-testid="scans-input"`, `<input type="file" multiple>`) via `setInputFiles` with both paths
   in one call (uploading both together mirrors how a real user drops multiple scans at once, and is
   how the golden values were captured).
6. Wait for both scans' `ring-count` (`data-testid="ring-count"`, one per scan island) to become
   visible and read `23 of 23`.
7. Assert both scans' `scan-flip` (`data-testid="scan-flip"`) read `None`.
8. Wait for `plane-status-XY` (`data-testid="plane-status-XY"`) to read exactly `Ready to analyze.`.
9. Assert `analyze-btn` (`data-testid="analyze-btn"`) is enabled and click it.
10. Wait for the results section to appear: `scale-X` (`data-testid="scale-X"`) becoming visible is
    a sufficient signal (it renders together with the rest of the results panel).
11. Read every field in "Assertions per case" below off the results panel.
12. Switch the "Firmware" select (no testid today; it is the `v-select` inside `.firmware-select`,
    labelled "Firmware" — add a testid, for example `firmware-select`, before writing the test) to
    each of `Klipper`, `Marlin`, and `RepRapFirmware` in turn. Switching firmware does not require
    re-uploading or re-analyzing: the skew fix re-renders immediately from the already-computed
    result. For each firmware, read the step 2 reset command and the "Fix skew" tab's `skew-code`
    (`data-testid="skew-code"`) and compare against "Firmware commands" below. The step 2 reset
    command has no testid today; add one (for example `reset-skew-code`) before writing the test.
13. Click the "Fix size" tab (no testid today on the tab buttons themselves; they are
    `button.fix-tab` elements with the visible text `Fix skew` / `Fix size` — add testids, for
    example `fix-tab-skew` / `fix-tab-size`, before writing the test) and read `size-code`
    (`data-testid="size-code"`) once, with the Format selector left at its default, `Shrinkage %`.
    `size-code` does not depend on which firmware was selected in step 12; see `PROVENANCE.md`'s
    "Firmware vs. Format are independent controls" for the empirical confirmation. Assert it once
    per case, not once per firmware.

## Assertions per case

Every value below is copied verbatim from `PROVENANCE.md`; the tolerance bands are the literal bands
recorded there, not computed by the test. Assert sign and magnitude explicitly (both golden values
in this set are positive).

### Case: 300 dpi

| testid | assertion |
|---|---|
| `scale-X` | `+0.144 %` within ± 0.05 percentage points (sign: positive) |
| `scale-Y` | `+0.117 %` within ± 0.05 percentage points (sign: positive) |
| `skew-XY` | `+0.489°` within ± 0.03 degrees (sign: positive) |
| `more-scans-XY` | exact text `XY plate: Scan this plate 2 more times to get a confidence range, which shows how tightly the value is pinned down.` |
| any `[data-testid^="zero-note"]` | element count 0 |

Firmware commands (assert the exact displayed string, newlines included; see `PROVENANCE.md` for why
Klipper's includes a caption line and Marlin/RRF's do not):

| firmware | reset command | `skew-code` |
|---|---|---|
| Klipper | `SET_SKEW CLEAR=1` | `Paste into the Klipper console:\nSET_SKEW XY=99.575,100.427,70.713\nSKEW_PROFILE SAVE=ScanNTune\nSAVE_CONFIG` |
| Marlin | `M852 I0 J0 K0\nM500` | `M852 I-0.008528\nM500` |
| RepRapFirmware | `M556 S100 X0 Y0 Z0` | `M556 S100 X0.853` |

`size-code`: exact text `XY shrinkage: 100.13 %`.

### Case: 150 dpi

| testid | assertion |
|---|---|
| `scale-X` | `+0.243 %` within ± 0.05 percentage points (sign: positive) |
| `scale-Y` | `+0.216 %` within ± 0.05 percentage points (sign: positive) |
| `skew-XY` | `+0.486°` within ± 0.03 degrees (sign: positive) |
| `more-scans-XY` | exact text `XY plate: Scan this plate 2 more times to get a confidence range, which shows how tightly the value is pinned down.` |
| any `[data-testid^="zero-note"]` | element count 0 |

Firmware commands:

| firmware | reset command | `skew-code` |
|---|---|---|
| Klipper | `SET_SKEW CLEAR=1` | `Paste into the Klipper console:\nSET_SKEW XY=99.577,100.425,70.713\nSKEW_PROFILE SAVE=ScanNTune\nSAVE_CONFIG` |
| Marlin | `M852 I0 J0 K0\nM500` | `M852 I-0.008475\nM500` |
| RepRapFirmware | `M556 S100 X0 Y0 Z0` | `M556 S100 X0.848` |

`size-code`: exact text `XY shrinkage: 100.23 %`.

## Optional case: four scans, one plate, confidence range (300 dpi and 150 dpi)

Beyond the mandatory 2-scan boundary-value pair above, `PROVENANCE.md` also captured all four
quarter-turn scans of the same plate uploaded together, at each DPI, which is the minimum scan
count (`MIN_SCANS_FOR_RANGE`, 4) that unlocks a 95% confidence range widget per figure. This is not
part of the mandatory case table, but is valuable coverage of a distinct code path (the range
widget) and is included as an additional named case per DPI, following the same journey as above
except step 5 uploads all four of that DPI's fixtures in one `setInputFiles` call
(`xy_0d`, `xy_90d`, `xy_180d`, `xy_270d`, matching DPI) and step 9's `analyze-btn` text reads
`Analyze 4 scans` before the click.

Additional assertions for this case (four fixtures uploaded together):

### 300 dpi, 4 scans

| testid | assertion |
|---|---|
| `scale-X` | `+0.145 %` within ± 0.05 percentage points (sign: positive) |
| `scale-Y` | `+0.112 %` within ± 0.05 percentage points (sign: positive) |
| `skew-XY` | `+0.492°` within ± 0.03 degrees (sign: positive) |
| `range-scaleX-XY` | exact text `Likely between +0.128 % and +0.162 % (95% from 4 scans).` |
| `range-scaleY-XY` | exact text `Likely between +0.095 % and +0.129 % (95% from 4 scans).` |
| `range-skew-XY` | exact text `Likely between +0.467° and +0.517° (95% from 4 scans).` |
| `size-code` | exact text `XY shrinkage: 100.13 %` |

### 150 dpi, 4 scans

| testid | assertion |
|---|---|
| `scale-X` | `+0.242 %` within ± 0.05 percentage points (sign: positive) |
| `scale-Y` | `+0.208 %` within ± 0.05 percentage points (sign: positive) |
| `skew-XY` | `+0.493°` within ± 0.03 degrees (sign: positive) |
| `range-scaleX-XY` | exact text `Likely between +0.226 % and +0.257 % (95% from 4 scans).` |
| `range-scaleY-XY` | exact text `Likely between +0.192 % and +0.223 % (95% from 4 scans).` |
| `range-skew-XY` | exact text `Likely between +0.468° and +0.517° (95% from 4 scans).` |

## Rejection paths (mandatory)

Every rejection case below is its own separate named test (for example in
`xy-rejection.spec.ts`, per the feature's `*-rejection.spec.ts` convention), not folded into either
DPI case's test. See `PROVENANCE.md`'s "Rejection cases" for the full narrative behind each; the
literals below are the assertion contract only.

### 3.1 Two scans of (nearly) the same angle

Seed the 300 dpi calibration. Upload `golden/xy_0d_300dpi_black_white.jpg` twice in one `setInputFiles` call
(the same file both times; the two uploaded `File` objects should be given distinct names, for
example by wrapping the fixture bytes in two differently-named `File`s, since the app keys scans
by upload identity, not by file name, but distinct names make the test's intent clear).

Journey: identical steps 1 through 6 above (skip the calibration/DPI-hint assertions, they are not
this case's concern), then:

1. Wait for `plane-status-XY` to become visible.
2. Assert `plane-status-XY`'s exact text:
   `These two scans are only 0 degrees apart. Turn the plate further, about a quarter turn, and scan it again so the app can separate scale from skew.`
3. Assert `analyze-reason` (`data-testid="analyze-reason"`) has the same exact text, prefixed with
   `XY plate: `.
4. Assert `analyze-btn` is disabled.

### 3.4 Mixed-resolution pair: one scan matches the calibration DPI, one does not (per-scan hard block, one scan flagged)

Captured against commit 181ba92 (per-scan resolution validation). Seed the 300 dpi calibration.
Upload `golden/xy_0d_300dpi_black_white.jpg` (matches the seed) + `golden/xy_90d_150dpi_black_white.jpg` (does not) in one
`setInputFiles` call.

Journey: identical steps 1 through 6 above (the calibration/DPI-hint assertions of steps 3-4 may be
kept or skipped; they are not this case's concern), then:

1. Wait for both scans' `ring-count` to become visible; assert both read `23 of 23` (ring detection
   still succeeds; this is purely a resolution rejection, not a detection failure).
2. Assert the two scans' `scan-resolution` rows (`data-testid="scan-resolution"`) read
   `about 300 dpi` and `about 150 dpi` respectively.
3. On the 150 dpi scan's card, assert the "Wrong resolution" badge and its explanation. The badge
   currently has no dedicated testid (it is the `.pill` element; add `scan-resolution-badge` per
   `PROVENANCE.md` open item 5). Its explanation renders in that card's `failure-reason`
   (`data-testid="failure-reason"`) and reads exactly:
   `This scan measures about 150 dpi, but the expected resolution is 300 dpi. Rescan at the expected resolution, or recalibrate the scanner at this one.`
4. Assert `analyze-btn` is disabled and `analyze-reason` reads exactly:
   `One scan measures a wrong resolution; replace it to analyze.` (singular).
5. Assert no result panel renders: `scale-X` has element count 0.

Note: `plane-status-XY` still reads `Ready to analyze.` in this case, because that status reflects
only the angle-spread and mirror-flip checks, not resolution. Do not assert on `plane-status-XY`
here; the resolution block is expressed through `analyze-reason` and the disabled `analyze-btn`.

### 3.5 Uniform resolution mismatch: both scans at a DPI different from the seeded calibration (mandatory rejection; per-scan hard block, both scans flagged)

Captured against commit 181ba92. Seed the 300 dpi calibration. Upload `golden/xy_0d_150dpi_black_white.jpg` +
`golden/xy_90d_150dpi_black_white.jpg` (both native 150 dpi, mutually consistent, both differing from the seeded
300 dpi by a clean 2x factor).

Journey: identical steps 1 through 6 above, then:

1. Wait for both scans' `ring-count` to become visible; assert both read `23 of 23`.
2. Assert both scans' `scan-resolution` rows read `about 150 dpi`.
3. On BOTH scan cards, assert the "Wrong resolution" badge (`.pill`; add `scan-resolution-badge`)
   and its `failure-reason` explanation, each reading exactly:
   `This scan measures about 150 dpi, but the expected resolution is 300 dpi. Rescan at the expected resolution, or recalibrate the scanner at this one.`
4. Assert `analyze-btn` is disabled and `analyze-reason` reads exactly:
   `2 scans measure a wrong resolution; replace them to analyze.` (plural).
5. Assert no result panel renders: `scale-X` has element count 0.

This is the flow's mandatory "resolution mismatch is refused" rejection case (a genuine pre-analyze
hard block; the app produces no result at all).

### 3.6 Wrong declared coupon geometry

Correct geometry: rings per side `5`, plate baseline `100` mm (see `PROVENANCE.md`). This case
enters wrong values for both, then uploads an otherwise-valid, matching-calibration scan pair.

Seed the 300 dpi calibration. Before uploading, set "Rings per side" to `6` and "Plate baseline
(mm)" to `150` (both fields need testids added first, per `PROVENANCE.md`'s open items; suggested
`grid-n-input` and `baseline-mm-input`). Then upload `golden/xy_0d_300dpi_black_white.jpg` +
`golden/xy_90d_300dpi_black_white.jpg` (the real, correct-geometry plate's scans).

1. Wait for both scans' `ring-count` to become visible.
2. Assert both read exactly `4 of 34`.
3. Assert both scans' `failure-reason` (`data-testid="failure-reason"`) read exactly:
   `The coupon pattern was not found: only 4 of its 34 measurement rings were detected. Make sure the whole coupon lies inside the scan area on a plain, single-colour background, then scan again.`
4. Assert `analyze-btn` is disabled and its companion `analyze-reason` reads exactly
   `Fix 2 scans to analyze.`.
5. Assert no `plane-status-XY` element renders (no plane group forms, since neither scan reached the
   measured state).

### 3.7 Mirrored flat-plate scan (per-scan hard block, one scan flagged)

The flat XY plate's hole rims are countersunk, so only the first-layer face is a valid scan face;
a mirrored XY read means the countersunk face was on the glass or the plate was printed mirrored.
The app rejects such a scan on its own card, the same hard-block pattern as the resolution
verdicts of 3.4/3.5.

Fixture: the untouched `golden/xy_0d_150dpi_black_white.jpg` serves as the valid input (the 2026-07-14 goldens
were scanned first-layer side on the glass, so the raw golden reads unmirrored under the
face-on-glass flip convention), plus a horizontally flipped copy of `golden/xy_90d_150dpi_black_white.jpg`
produced by the test itself as the mirrored input (flipping the pixel rows of the fixture in the
test helper is display-independent preprocessing of the test input, not a measurement-path
resample; no derived file is committed). Seed the 150 dpi calibration. Upload both in one
`setInputFiles` call.

Journey: identical steps 1 through 6 above, then:

1. Wait for both scans' `ring-count` to become visible; assert both read `23 of 23` (detection and
   alignment still succeed; this is purely an orientation rejection).
2. Exactly one card's `scan-flip` row reads `Mirrored`; the other reads `None`.
3. On the mirrored card, assert the rejection badge (`data-testid="scan-mirrored-badge"`) reads
   `Mirrored scan`, and its `failure-reason` reads exactly:
   `The scan is mirrored. Scan the plate with its first-layer side on the glass. If it still reads mirrored, the plate was printed mirrored and cannot be measured.`
4. Assert `plane-status-XY` reads `Ready to analyze.`: the per-scan rejection replaces the old
   relative flip-consistency group message for the XY plane, so the group status stays clean while
   the card and the Analyze gate carry the block.
5. Assert `analyze-btn` is disabled and `analyze-reason` reads exactly:
   `One scan is mirrored; rescan or replace it to analyze.` (singular).
6. Assert no result panel renders: `scale-X` has element count 0.

## Notes for the phase 2 implementer

- **Testid gaps to close before implementation** (see `PROVENANCE.md`'s "Open items for the owner"
  #3, #4, and #5 for the full list): the step 2 reset-command `CodeBlock`, the Klipper skew fix's
  secondary `CodeBlock` line (`SKEW_PROFILE LOAD=ScanNTune`, not asserted by this spec but worth a
  testid for future coverage), the Firmware `v-select`, the two `fix-tab` buttons, the "Plate
  baseline (mm)" / "Rings per side" `NumericField` inputs, and the "Wrong resolution" badge pill
  (suggested `scan-resolution-badge`, needed by 3.4 and 3.5). The per-scan `scan-resolution` row and
  the `analyze-reason` gate message already have testids. Add real `data-testid` attributes rather
  than selecting by text, class, or label, per this repo's convention; per the owner's standing
  grant, phase 2 may add these testids.
- **Resolution mismatch is a pre-analyze hard block (commit 181ba92), not a soft warning.** Both 3.4
  (one scan flagged, singular `analyze-reason`) and 3.5 (both flagged, plural `analyze-reason`)
  disable Analyze and render no result; the old `scale-mismatch-warning` element no longer exists.
  Do not write any assertion against `scale-mismatch-warning`.
- **`skew-code`'s displayed text includes a caption line for Klipper only.** Do not write a
  selector or regex that strips the caption; transcribe the full displayed string as given in
  "Assertions per case" above, exactly as `PROVENANCE.md` recorded it.
- Analysis on a 35 MP-class scan (the 300 dpi fixtures here) can take on the order of a minute in the
  Web Worker; size the visibility timeouts generously (for example 120000 ms, matching the skill's
  EM precedent), never shrink them for tidiness.
- Firmware switching (step 12) is synchronous, client-side reactive state; it needs no explicit wait
  beyond Playwright's normal auto-retrying assertions, since no new analysis or network activity
  occurs.
- The XZ and YZ planes, and multi-plane scan sets (a plate combining more than one plane), are out
  of scope for this spec and need their own golden sample sets before a webtest can cover them.
