# Card calibration golden sample: provenance

## The physical sample

A standard ISO/IEC 7810 ID-1 plastic card (a bank-card-sized card), the reference object the
scanner calibration flow measures to learn the scanner's true pixels-per-mm.

The card's long side was measured by the owner with a caliper: **85.55 mm**. This is the figure
entered into the app's "Measured long side (mm)" field for every capture below. It is deliberately
NOT the ISO nominal long side (85.60 mm): the app calibrates against the owner's own card, and a
real card's actual size differs slightly from the nominal figure printed in the standard. The app
measures the card's **long side only**; the short side is banned as a reference because it reads
through the flatbed's lid-shadow zone at the card's ends.

Scanner sensor type: **CIS** (contact image sensor). On a CIS scanner the scale reference is a
single scalar px/mm applied to both scan axes (see `ScaleReference` and `sensor-toggle` in
`CalibrationPage.vue`); this sample was captured with `sensor-cis` selected for every case.

## The two scans

Two scans of the same physical card, taken in the same session at two representative resolutions
(the flow's mandatory low/high boundary-value pair):

- `card_300dpi.png`, scanned at 300 dpi
- `card_600dpi.png`, scanned at 600 dpi

## Approval tier: owner-validated

The owner has already exercised the scan-upload and card-detection feature directly and confirmed
it works as intended (correct card localization, plausible edge straightness/parallelism, a
detected size in the expected range of the caliper measurement). This prior validation is the
approval that authorizes freezing the app's currently displayed output for these two scans as the
webtest's golden values, per the owner-reviewed tier: there is no printed correction to apply for a
scanner-calibration reading (nothing is printed by this flow), so the relevant tier is "the owner
inspected the app's output and judged it correct from domain knowledge" applied to the scan capture
and detection itself, together with the owner's own caliper measurement as the external ground
truth for the entered reference length.

## Frozen displayed values

Captured by driving the real running app (Vite dev server, the same bundle Playwright drives)
through the actual UI: opened the scanner calibration page, selected `sensor-cis`, entered
`85.55` into "Measured long side (mm)", entered the resolution below into "Scan resolution (dpi)",
uploaded the scan through the real `card-input` file input, and read the `calibration-result` panel
verbatim. No value below was computed, derived, or read from engine source; every literal is what
the app showed on screen.

### 300 dpi capture (`card_300dpi.png`)

Inputs: sensor `CIS`, measured long side `85.55` mm, scan resolution `300` dpi.

| testid | displayed value | proposed tolerance band | rationale |
|---|---|---|---|
| `pxpermm` | `11.796` | ± 0.02 px/mm | The two DPI captures' `vs-nominal` readings differ by only 0.03 percentage points from each other (see below), showing the measurement is stable to well under a tenth of a percent run to run; ± 0.02 px/mm is about 0.17% of this value, comfortably above that noise floor while still tight enough to fail on a sign flip, a swapped axis, or a gross scale error. |
| `effective-dpi` | `300` | ± 1 dpi | The 300 dpi capture reads back its own entered DPI exactly; the 600 dpi capture (below) reads back 1 dpi low. ± 1 dpi covers that same observed rounding/measurement spread. |
| `vs-nominal` | `-0.131 %` | ± 0.05 percentage points | The two captures' `vs-nominal` values are -0.131% and -0.161%, a 0.03 percentage-point spread between two independent scans of the same physical card. ± 0.05 percentage points comfortably covers that spread with margin while still catching a sign flip or an order-of-magnitude error. |
| `scale-factor-note` | not present (element absent) | exact (element must not render) | No geometric resolution mismatch is present at this entered DPI, so the note must not appear; its presence would itself indicate a regression. |

Supporting diagnostic text read from the same result panel (not asserted by testid today, no
`data-testid` exists on these fields; see "Gaps" below): edges straight to 0.89 px, parallel to
0.037°, detected size 85.44 mm (matches the entered 85.55 mm), and the panel's `saved` element read
exactly `Saved, used for every scan`.

### 600 dpi capture (`card_600dpi.png`)

Inputs: sensor `CIS`, measured long side `85.55` mm, scan resolution `600` dpi.

| testid | displayed value | proposed tolerance band | rationale |
|---|---|---|---|
| `pxpermm` | `23.584` | ± 0.02 px/mm | Same rationale as the 300 dpi row: the observed cross-capture spread in `vs-nominal` is 0.03 percentage points, and ± 0.02 px/mm here is about 0.08% of this larger value, well above that noise floor and still tight. |
| `effective-dpi` | `599` | ± 1 dpi | Matches the entered 600 dpi within 1 dpi; see the 300 dpi row for the shared rationale for the band width. |
| `vs-nominal` | `-0.161 %` | ± 0.05 percentage points | See the 300 dpi row; same band, same rationale, sized from the 0.03 percentage-point cross-capture spread. |
| `scale-factor-note` | not present (element absent) | exact (element must not render) | Same rationale as the 300 dpi row. |

Supporting diagnostic text read from the same result panel: edges straight to 16.52 px, parallel to
0.137°, detected size 85.41 mm (matches the entered 85.55 mm), and the panel's `saved` element read
exactly `Saved, used for every scan`.

## Rejection case: resolution mismatch (captured empirically, no new fixture)

The mandatory rejection case reuses the existing `card_300dpi.png` fixture and enters a DPI that
does not match the image, tripping the resolution/size gate. Captured by driving the running app
(sensor `CIS`, measured long side `85.55` mm, fixture `card_300dpi.png`) at several entered DPI
values:

| entered dpi | outcome | `card-error` text (verbatim) | `calibration-result` |
|---|---|---|---|
| 150 | hard refusal | `The detected card is about 2.0 times your measured size. The scan resolution likely differs from the 150 dpi you entered.` | not rendered (count 0) |
| 600 | hard refusal | `The detected card is about 0.5 times your measured size. The scan resolution likely differs from the 600 dpi you entered.` | not rendered (count 0) |
| 60 | hard refusal | `No card-shaped object was found. Place the card flat on the glass; a pale card needs a dark sheet behind it.` | not rendered (count 0) |
| 1200 | hard refusal | `No card-shaped object was found. Place the card flat on the glass; a pale card needs a dark sheet behind it.` | not rendered (count 0) |

Findings:

- The gate keys on the **entered DPI** (the app compares the image's detected card size in pixels
  against the size the entered DPI predicts), not on the image's own pixel resolution. Entering a
  DPI that mismatches the true 300 dpi scale trips it.
- Every probed mismatch is a **hard refusal** via `card-error` with **no** result panel. No probed
  value produced the soft `scale-factor-note` warning while still showing a result: on this fixture
  the card-box size gate (`CARD_SIZE_TOLERANCE`, 25% in `cardEdgeMeasurer.ts`) is tighter than the
  note's clean-2x/0.5x detection window, so a mismatch is rejected before a result is produced.
- The engine's "too low for sub-pixel edge refinement" throw (`cardEdgeMeasurer.ts`, at roughly 73
  dpi and below) is not reached on this fixture: the card-box size check rejects the mismatched
  scale first, so a too-low entered DPI surfaces as the size-mismatch message above, not that throw.
- A clean 2x or 0.5x mismatch (150 or 600 dpi here) yields the specific resolution-mismatch wording;
  a far-off mismatch (60 or 1200 dpi) that is not near a clean multiple yields the generic
  "No card-shaped object was found" wording.

The flow spec's canonical rejection case uses **150 dpi** (the clean 2x mismatch), whose message is
deterministic for this frozen fixture and reads as an exact string. Its message is asserted exactly;
no tolerance band applies to a string assertion.

## Gaps for the phase 2 implementer

- The "Measured long side (mm)" and "Scan resolution (dpi)" fields (`NumericField.vue` instances in
  `CalibrationPage.vue`) carry no `data-testid` today; they were located in the running app by their
  Vuetify label text (`Measured long side (mm)`, `Scan resolution (dpi)`). Per this repo's webtest
  convention, add real testids to these two inputs rather than writing a label-text selector into
  the test.
- The straightness/parallelism/detected-mm sentence in the result panel also carries no
  `data-testid`; it is recorded above for context but is not part of the mandatory assertion set
  (`pxpermm`, `effective-dpi`, `vs-nominal`, `scale-factor-note`) captured for this golden set.
- The mandatory rejection case needs no separate reject fixture: it reuses `card_300dpi.png` with a
  mismatched entered DPI (150), captured empirically above, and its exact `card-error` message is
  frozen. No pending fixture remains for this flow.
