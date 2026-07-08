# Extrusion Multiplier (Flow) Calibration: Coupon + G-code Generator Design

Date: 2026-07-08
Status: approved (owner), stage 1 of the EM feature
Scope of this spec: coupon geometry, G-code generator, UI. The vision pipeline is
explicitly out of scope and gated on a successful real-world test print.

## Goal

Calibrate the slicer extrusion multiplier / flow (and runtime `M221 S`) from a single
flatbed scan of one printed coupon, in one color, with no calipers. This is distinct
from extruder calibration (rotation_distance / e-steps), which is a mark-and-extrude
procedure that needs no printed part and is out of scope.

## Measurement principle (pitch-block vernier)

The whole coupon prints at the printer's current flow. Each block of parallel single
lines is commanded at a different, exactly known line PITCH (spacing). The printer's
unknown deposited line width `w` decides each block's fate:

- pitch < w: adjacent beads fuse, block scans as solid plastic.
- pitch > w: a groove of bare bed opens between beads, gap = pitch - w.

Measuring the gap per block and regressing gap against pitch (ordinary least squares
over open blocks) gives `w` as the x-intercept. The fit slope must be ~1, a free
sanity check on scan scale. Two mirrored block rows give two independent crossovers;
their midpoint cancels direction-dependent bias. Correction is a ratio:

    new_flow = current_flow * (nominal_width / w)

so it is valid regardless of whether the error originates from flow setting, filament
diameter, or extruder steps. Resolution comes from averaging many identical gaps per
block and interpolating between pitch steps via the intercept; the practical floor is
filament diameter variation (~1% volumetric on standard spools), which the UI must
state honestly.

Rule 1 compliance: plain means, ordinary least squares, ratio correction. No tuned
constants in the math path.

## Coupon geometry

One printed part, one color, no pause, no mid-print M221.

- Rectangular frame (~4 mm wide walls, full 4-layer height) carrying:
  - 3 fiducial holes + 1 solid origin corner, same convention and dimensions as the
    PA coupon so fiducial detection code is shared later.
  - A central structural rail between the two comb rows.
- 2 mirrored rows x `blockCount` blocks (default 13). Top row pitch ascends
  left-to-right, bottom row descends (mirror). Each block: `linesPerBlock` (default
  ~10) straight single-bead lines at that block's fixed pitch, anchored to frame and
  rail at both ends (no free-standing ends).
- Line cross-section, 4 layers tall (side view):
  - Layers 1-2: pedestal, commanded width ~0.72 x nominal (inset). Absorbs
    first-layer squish so z-offset error cannot reach the measured edge.
  - Layers 3-4: measured layers at nominal width. These define the scanned edge.
  - The part is scanned TOP-FACE DOWN on the glass, so the scanner focuses on the
    measured layers and the pedestal hides behind them.
- All widths derive from `nozzleDiameterMm`: nominal width = 1.05 x nozzle
  (0.42 mm at 0.4). Default pitch range 0.34-0.58 mm at 0.4 nozzle, step 0.02 mm,
  scaled proportionally for other nozzles.
- Spec fields (`EmTestSpec`): `pitchMinMm`, `pitchMaxMm`, `blockCount`,
  `linesPerBlock`, `printSpeedMmS`, all defaulted from the profile and
  user-editable. Coupon size is
  computed and `fitsA4()` (reused) drives the same paper-size warning as PA.
- Print speed: `printSpeedMmS` is a spec field. Default derives from the profile,
  capped so volumetric flow stays conservative (<= 8 mm^3/s), but the user can raise
  it freely (high-flow hotends calibrate at their real speeds, e.g. several hundred
  mm/s). The UI shows the resulting volumetric flow live and warns (never blocks)
  above a typical-hotend threshold. Flow calibration is only valid near its tested
  speed, so the UI states the speed used; users may generate separate coupons per
  speed regime.
- Acceleration handling: line ends have a speed ramp of v^2/(2*accel) each side; the
  generator warns when the ramp consumes so much of the line that its middle never
  reaches the commanded speed. The later vision stage measures gaps in the line
  middles only.

## Architecture: shared G-code engine (Option A)

Extract the currently private helpers in `web/src/engine/pa/gcodeGenerator.ts` into a
framework-agnostic shared module `web/src/engine/gcode/`:

- Movers/emitters: `travel`, `extrude`, `retract`, `rectLoop`, `basePerimeters`,
  `rasterBase`, `motionLimitCommands`, plus the emitter state type.
- Already-public pieces move or re-export as appropriate: `extrusionMm`,
  `substituteSlicerVariables` (with `orcaTemplate`), start-gcode validation helper.
- `pa/gcodeGenerator.ts` becomes a consumer of the shared module. Pure move: PA
  output must be byte-identical; existing PA generator tests staying green is the
  no-regression proof.

Printer/material management is NOT duplicated: `usePrinterProfiles` (profiles,
filaments, selection, localStorage persistence) and the `PrinterProfile` /
`FilamentProfile` types are reused untouched. Any type that must be shared moves to a
shared location rather than being copied.

New EM module `web/src/engine/em/`:

- `types.ts`: `EmTestSpec`, defaults-from-profile, coupon layout function (block
  origins, pitch sequence, mirror layout, fiducial positions), size + `fitsA4`.
- `gcodeGenerator.ts`: `generateEmGcode(profile, filament, spec)` and
  `generateEmGcodeWithReport()` returning `{gcode, unknownVariables, warnings}`,
  mirroring the PA contract. Uses the shared emitter exclusively. `pauseGcode` is
  unused (no filament swap).
- `emCorrectionFormatter.ts`: deferred to the vision stage.

## UI

New page mirroring `PaPage.vue` (marked beta):

- Printer/filament selection via `usePrinterProfiles` (unchanged store).
- Spec controls: pitch range, block count, lines per block, with live coupon size
  readout and the paper-size warning.
- Generate + download G-code (synchronous, main thread, no worker), reporting
  `unknownVariables` and `warnings` exactly like PA.
- Navigation entry via the `useApp` store.
- Honest-limits note: filament diameter variation floor (~1%), speed validity note.

## Error handling

- Generator throws only on genuinely impossible input (coupon larger than bed,
  non-positive counts); everything else surfaces as `warnings` /
  `unknownVariables` in the report, shown in the UI (rule 2).
- Start-gcode temperature validation reused from PA.

## Testing / verification (this stage)

- Vitest:
  - Shared-emitter extraction: existing PA generator tests stay green with
    byte-identical output.
  - EM geometry: block positions, pitch sequence exactness, mirror symmetry,
    fiducial placement, size math, fits-A4 logic.
  - EM G-code: E values consistent with `extrusionMm` for commanded widths,
    pedestal vs measured widths per layer, header/footer/temps present, no pause,
    single-color.
- Gate: `npm run build` + `npm test` + `npm run e2e` all green.
- Then STOP: owner prints the G-code and scans the part. The vision pipeline
  (emAnalyzer, synthetic emRender.ts ground-truth renderer, results UI, correction
  formatter) is designed and built only after the physical print is confirmed
  workable.

## Out of scope (deferred to stage 2)

- Vision pipeline: fiducial alignment reuse, per-block gap measurement, OLS fit,
  mirrored-row null, `emRender.ts` render-recovery validation contract (rule 1).
- Correction formatter and results page.
- Stepped-flow (M221) validation coupon: possible v2 debug tool, not v1.

## Key risks and mitigations

- Fine-pitch blocks may fuse from bead swell rather than true width (surface
  tension pulls near-touching beads together): mitigated by treating merged blocks
  as clamped (excluded from the fit) and fitting only clearly open blocks.
- Free-standing 4-layer walls could wobble: mitigated by anchoring both line ends;
  if the test print still shows wobble, drop to 3 layers (constant change).
- Z-offset squish leaking past the pedestal inset: if visible in the test print,
  widen the inset (constant change).
- First print is the validation instrument: the real-world print/scan decides
  whether stage 2 proceeds unchanged.
