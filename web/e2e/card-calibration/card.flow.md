# Flow spec: scanner (card) calibration

Feature folder: `web/e2e/card-calibration/`. Golden sample set and its provenance:
`web/e2e/card-calibration/golden/PROVENANCE.md`. All literal values in this spec are copied
verbatim from that file; none are computed here.

This flow has no dependency on any other flow's calibration: it is the source of the scale
reference other flows read.

## Case table (boundary-value pair: low DPI, high DPI)

| case | fixture | sensor | measured long side (mm) | scan resolution (dpi) |
|---|---|---|---|---|
| 300 dpi | `golden/card_300dpi.png` | CIS | 85.55 | 300 |
| 600 dpi | `golden/card_600dpi.png` | CIS | 85.55 | 600 |

Both cases share the identical journey below and differ only in the fixture and the DPI entered
and the expected literals in "Assertions per case". Generate one named test per row from a shared
body, per the skill's case-table parametrization; do not duplicate the test body and do not upload
both fixtures inside one test.

## User journey (identical for both cases)

1. Open the app at its entry page.
2. Click the "Calibrate scanner" button (role `button`, name "Calibrate scanner") on the entry
   page's step list to navigate to the scanner calibration page. The page heading reads "Scanner
   calibration".
3. In the "Sensor type" toggle, click `sensor-cis` (`data-testid="sensor-cis"`) to select CIS. (For
   this flow's case table CIS is already the page's default selection, but the journey clicks it
   explicitly so the case is not dependent on the default.)
4. In the "Measured long side (mm)" field, clear any existing value and enter `85.55`. This field
   currently has no `data-testid`; it is the `NumericField` whose Vuetify label text is exactly
   "Measured long side (mm)". Add a `data-testid` (for example `reference-mm-input`) to this field
   before writing the test, per this repo's convention of adding a missing testid rather than
   selecting by label text.
5. In the "Scan resolution (dpi)" field, clear any existing value and enter the case's DPI (`300`
   or `600`). This field also currently has no `data-testid`; it is the `NumericField` whose label
   text is exactly "Scan resolution (dpi)". Add a `data-testid` (for example `dpi-input`) to this
   field before writing the test, for the same reason as step 4.
6. Upload the case's fixture through the real file input `card-input`
   (`data-testid="card-input"`, `<input type="file">`) via `setInputFiles`.
7. Wait for the result panel `calibration-result` (`data-testid="calibration-result"`) to become
   visible. Assert `card-error` (`data-testid="card-error"`) has count 0: the upload must not have
   been rejected.
8. Read the three metric tiles and the optional note off the result panel, per "Assertions per
   case" below.

## Assertions per case

Every value below is copied verbatim from `PROVENANCE.md`; the tolerance bands are the literal
bands recorded there, not computed by the test.

### Case: 300 dpi

| testid | assertion |
|---|---|
| `pxpermm` | `11.796` within ± 0.02 px/mm |
| `effective-dpi` | `300` within ± 1 dpi |
| `vs-nominal` | `-0.131 %` within ± 0.05 percentage points (assert the sign explicitly: negative) |
| `scale-factor-note` | element has count 0 (must not be present) |
| `saved` | visible, exact text `Saved, used for every scan` |

### Case: 600 dpi

| testid | assertion |
|---|---|
| `pxpermm` | `23.584` within ± 0.02 px/mm |
| `effective-dpi` | `599` within ± 1 dpi |
| `vs-nominal` | `-0.161 %` within ± 0.05 percentage points (assert the sign explicitly: negative) |
| `scale-factor-note` | element has count 0 (must not be present) |
| `saved` | visible, exact text `Saved, used for every scan` |

`pxpermm`, `effective-dpi`, and `vs-nominal` are read with `innerText()` on their `data-testid`
element and parsed as shown (`vs-nominal`'s text includes the trailing `%` and its sign, e.g.
`-0.131 %`; parse the leading signed number and assert its sign and magnitude separately, per the
"assert sign and magnitude explicitly" rule).

## Rejection path: resolution mismatch (mandatory, captured empirically, no new fixture)

Every flow's rejection coverage must include a scan the resolution gate refuses. This case reuses
the existing `golden/card_300dpi.png` fixture and enters a DPI that does not match the image, which
is the real-world mistake the gate exists to catch (telling the app the wrong scan resolution). No
new fixture is needed.

Which condition fires, empirically: the card flow rejects a resolution mismatch as a **hard
refusal** through `card-error` (`data-testid="card-error"`), and **no** `calibration-result` panel
renders. It is not the soft `scale-factor-note` warning (that note never appeared in any probed
case; on this fixture the card-box size gate is tighter than the note's 2x/0.5x window, so a
mismatch is rejected before any result is produced). It is also not the engine's "too low for
sub-pixel edge refinement" throw: that throw is gated behind the card-box size check
(`CARD_SIZE_TOLERANCE`, 25%), which rejects the mismatched scale first, so the throw is not reached
on this fixture.

Note for the owner and the phase 2 engineer: the card flow's too-low / mismatched-resolution path
surfaces as a hard `card-error` refusal with no result panel, not as a soft warning.

### Case: resolution mismatch (canonical)

Inputs: sensor `CIS`, measured long side `85.55` mm, scan resolution `150` dpi, fixture
`golden/card_300dpi.png` (a 300 dpi scan told to the app as 150 dpi, a clean 2x mismatch).

Journey: identical steps 1 through 6 as the happy path, entering `150` at step 5 and uploading
`card_300dpi.png` at step 6. Then:

1. Wait for `card-error` (`data-testid="card-error"`) to become visible.
2. Assert `card-error`'s text is exactly:
   `The detected card is about 2.0 times your measured size. The scan resolution likely differs from the 150 dpi you entered.`
3. Assert `calibration-result` (`data-testid="calibration-result"`) has count 0: no result panel
   renders.

Every literal above was captured verbatim from the running app; see `PROVENANCE.md` for the
capture and the other probed DPI values.

This case is a separate named test (for example in `card-rejection.spec.ts` per the feature's
`*-rejection.spec.ts` convention), not folded into either DPI case's test.

## Notes for the phase 2 implementer

- This flow has no upstream calibration dependency, so no `page.addInitScript` localStorage seeding
  applies here; it is the flow other tests seed *from*.
- Do not shrink the wait for `calibration-result`: analysis for these fixtures took over two
  minutes end to end in the capture session on this machine, close to the standard 120 second
  visibility timeout used elsewhere in this suite (see the EM webtest precedent in the skill); size
  the wait timeout generously (for example 180000 ms) rather than tightening it for tidiness.
- `sensor-ccd` and non-CIS behavior are out of scope for this golden set; this sample was only
  captured under CIS. A CCD-scanner golden set would need its own physically-scanned card and its
  own `PROVENANCE.md` entry, since a CCD scale reference is a per-axis pair, not a scalar.
