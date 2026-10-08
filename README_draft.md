<!-- NOTE: this draft contains IMAGE REQUEST placeholders that must be replaced with real screenshots before publishing. -->

# ScanNTune

[![Web CI](https://github.com/jaak0b/ScanNTune/actions/workflows/web-ci.yml/badge.svg)](https://github.com/jaak0b/ScanNTune/actions/workflows/web-ci.yml)
[![License: MIT](https://img.shields.io/github/license/jaak0b/ScanNTune)](LICENSE)

**A caliper-free 3D printer calibration suite, read from a single flatbed scan.**
Print a coupon (a small test part), scan it on a flatbed scanner, and paste the correction into your
firmware or slicer. No calipers, no eyeballing test prints, no typing readings into a calculator.
ScanNTune currently covers four calibrations, skew and shrinkage, pressure advance, input shaper, and
extrusion multiplier / flow ratio, and it is built to grow more over time.

If your parts come out slightly off-size or out of square, if corners blob or round off at speed changes,
if fast moves leave visible ringing on vertical walls, or if walls and top surfaces look over- or
under-extruded, one of these four calibrations fixes it.

<div align="center">

## ▶ [Open ScanNTune in your browser](https://scanntune.jaak0b.at/)

**Free and open source. Runs entirely in your browser: nothing to install, nothing uploaded to a server,
works on desktop or phone. Requires a flatbed scanner.**

</div>

![ScanNTune results](img/ScanNTune_Results.png)

You get the exact snippet your setup expects, ready to paste:

| Target | Skew and shrinkage | Pressure advance | Input shaper | Extrusion multiplier |
| --- | --- | --- | --- | --- |
| Klipper | `SET_SKEW XY=...` | `SET_PRESSURE_ADVANCE ADVANCE=...` | `[input_shaper]` block for `printer.cfg` | `M221 S...` |
| Slicer | shrinkage compensation % | per-filament pressure advance (OrcaSlicer) | not applicable, firmware only | extrusion multiplier / flow ratio |

Shrinkage compensation percentage and extrusion multiplier / flow ratio are plain slicer settings, and
pressure advance can also be entered as a per-filament setting in OrcaSlicer. The generated coupons and
every firmware command, including input shaper, are Klipper G-code.

> [!TIP]
> **A flatbed scanner is required; camera photos and phone scanning apps do not work.** Any regular
> office flatbed qualifies, including the scanner built into an all-in-one printer. Scan at 600 DPI,
> which any normal home or office scanner can do.

<!-- IMAGE REQUEST: a coupon plate lying on an open flatbed scanner, photographed from above, showing how the printed lattice plate is placed on the glass -->

**Start here:** the one-time card calibration (scanning any plastic card so ScanNTune learns your
scanner's true scale) is the shared first step for every flow; after that, pick the calibration matching
your symptom.

## Skew and shrinkage from a scan

Replaces the usual printed coupon and matching calculator, like Vector 3D's "Califlower": print it,
measure it corner to corner with calipers, measure the diagonals for skew, and type all of that into the
calculator without a mistake. The measuring is the annoying part: several caliper readings to keep track
of, and a diagonal for skew that is awkward to measure squarely. ScanNTune lets a scanner do the reading
instead.

1. **Once per scanner:** scan any plastic card (a credit, debit or loyalty card) so ScanNTune learns your
   scanner's true scale.
2. **Print the plate(s):** one plate per plane you want to check. XY prints flat; XZ and YZ print standing
   on-edge (both are experimental, see limitations below). Print only the planes you care about.
3. **Scan each twice:** lay a plate on the scanner and scan it flat, then give it a quarter turn and scan
   it again. Repeat for any other plates.
4. **Drop them all in:** open every scan in ScanNTune at once. It sorts them by plate automatically and
   gives you the firmware or slicer snippet for X/Y/Z scale and skew.

Once the plates are printed, the scanning takes a couple of minutes and the analysis itself runs in
seconds in the browser. Print time depends on your printer. The result is ready to paste: Klipper
`SET_SKEW` or a slicer shrinkage compensation percentage.

### Checked against the caliper workflow

Here is the same printer measured both ways: ScanNTune's result (left) and Califlower's coupon
hand-measured into its calculator (right).

![ScanNTune next to Califlower](img/ScanNTuneComparedToCaliflower.png)

The two come out almost exactly the same, differing by only **0.05% in X, 0.08% in Y, and 0.03° in skew**.
They should match, because both are measuring the same printer. The only difference is that ScanNTune
reads it from a single scan instead of by hand with a caliper. To be clear about the scope: this is one
printer and one coupon, so it shows the two methods agreeing on the skew and shrinkage flow specifically,
not a validation study of the whole suite.

## Pressure advance from a scan

Replaces squinting at a tower or a row of lines and picking the one that "looks best".

1. **Set up a printer profile** in the app (or import your PrusaSlicer or OrcaSlicer config) and download
   the generated G-code.
2. **Print the coupon:** a solid base in one filament, then a pause for a filament swap, then 16 test
   lines in a contrasting color. Any two filaments work as long as they differ in brightness. Each line
   prints at a different pressure advance value and contains slow, fast, slow speed changes, so a wrong PA
   value bulges or starves the line at the transitions.
3. **Scan it once.** ScanNTune measures each line's width along its length and scores how much it deviates
   at the speed transitions. The line that stays most even wins, refined to a continuous value between the
   steps.

The result is ready to paste as Klipper `SET_PRESSURE_ADVANCE`. An optional follow-up coupon sweeps
`smooth_time` the same way.

<!-- IMAGE REQUEST: the pressure advance results page showing the scored 16-line coupon overlay and the refined PA value with its ready-to-paste command -->

## Input shaper from a scan

Replaces running the accelerometer-based resonance test built into Klipper, or eyeballing which shaper
setting reduces ringing on a test print.

1. **Print the coupon:** a small crossing-line coupon, about 115 mm square with the default settings. Sharp
   corners in the toolpath excite each axis, and any resonance shows up as ringing printed into the
   lines.
2. **Scan it twice,** flat and then quarter-turned, the same way as the skew and shrinkage flow.
   ScanNTune reads the printed ringing along each axis and fits its frequency and damping with
   established estimation methods. A scan that cannot be read reliably is refused, with a worded reason,
   instead of a guessed result.
3. **Get the corrections back:** a recommended shaper type, chosen for robustness across a frequency
   tolerance band, and the resulting maximum usable acceleration.

The result is ready to paste: a Klipper `[input_shaper]` block for `printer.cfg`. Like the skew and shrinkage flow, it
requires the one-time card calibration for absolute scale.

<!-- IMAGE REQUEST: the input shaper results page showing the two quarter-turned scans, the fitted per-axis frequency and damping, and the recommended shaper type with its ready-to-paste command -->

## Extrusion multiplier / flow ratio from a scan

Replaces measuring a thin wall with calipers or judging a top surface by feel.

1. **Generate and print the coupon** from your printer profile: a single-color part with rows of parallel
   single-bead lines at precisely known spacings.
2. **Scan it once,** face down. ScanNTune measures the air gap between neighboring lines to sub-pixel
   precision; since the line spacing is known exactly, the deposited bead width falls out of a single
   subtraction, pooled over the 72 gaps of the default coupon.
3. **Enter your current slicer flow** and get the corrected value back in the same format, plus an `M221`
   command for prints that are already sliced.

The result is ready to paste: an extrusion multiplier (PrusaSlicer) or flow ratio (OrcaSlicer) value, plus
a Klipper `M221 S` command. Line centres do not move when beads print fatter or thinner, so
the measurement is immune to printer axis stretch and material shrinkage. Filament that will not come off
the plate (TPU, PETG) can be printed at the bed's front edge and scanned together with the build plate.

<!-- IMAGE REQUEST: the flow coupon scan with the measured gap overlay and the resulting extrusion multiplier / M221 output -->

## How it works

The measurement rests on a few established ideas, not on trusting the scanner:

- **Absolute scale comes from a card's known size, not a measurement.** A scanner's stated DPI is rarely
  exact, so instead of trusting it, ScanNTune reads a standard plastic card's edges: every ISO/IEC 7810
  ID-1 card (credit, debit, loyalty) is manufactured to 85.60 by 53.98 mm, so the standardized size stands
  in for a caliper reading. The ISO manufacturing tolerance on that size is around a tenth of a
  millimetre, which bounds the absolute scale error at roughly 0.1%. All four flows use this same card
  calibration for absolute scale.
- **Edges are read to sub-pixel precision.** The flow measurement locates bead edges with a gradient
  centroid sub-pixel estimator, and pressure advance is refined between the discrete test lines by
  parabolic refinement of the score curve.
- **Extrusion width cannot bias the skew and shrinkage flow.** Its coupon is a lattice of rings, and a
  ring's centre does not move when the walls print fatter or thinner. Ring centres are found by area
  centroid and the plate geometry is recovered with a robust affine fit, so over- or under-extrusion
  cannot shift the scale or skew.
- **Two scans cancel the scanner's distortion, for skew and shrinkage, and for input shaper.** A flatbed
  scanner has its own slight stretch and skew. Scanning the coupon flat, then again quarter-turned, and
  averaging the two cancels the scanner's error and leaves the printer's. The leftover half-difference
  even tells you how far off your scanner is. The input shaper flow reuses the same two-scan approach to
  read printed ringing along each axis cleanly.

The computer vision runs client-side in a Web Worker with [OpenCV.js](https://docs.opencv.org/), so a full
scan is analysed on your own machine in seconds without the page ever freezing, and your scans never
leave it. The measurement engine source lives in [`web/src/engine/`](web/src/engine) and the
fixture-backed tests that pin the math are in [`web/tests/`](web/tests), if you want to inspect either.

## Requirements and limitations

- **You need a flatbed scanner.** Camera photos and phone scanning apps are not supported; perspective
  and lens distortion would defeat the measurement. If you do not own one, a scanner at a library,
  school, or print shop works: the one-time card calibration is per scanner, so use the same machine for
  the card and the coupons.
- **The XY coupon is 100 mm square,** so it fits any A4 or letter flatbed.
- **A one-time card scan is required for absolute scale.** Without it, skew and X-to-Y anisotropy are
  still meaningful, but absolute shrinkage is not, and the flow measurement requires it outright. The
  calibration is per scanner, not per printer, so one calibrated scanner serves any number of printers.
- **XY calibration has been checked against real prints; XZ and YZ are experimental:** the
  standing-plate scans work, but the correction math for those planes has not seen the same real-world
  validation as XY yet. Sanity-check the results before trusting them on your printer.
- **The pressure advance coupon needs two filaments** that differ in brightness, and a printer that can
  pause for a filament swap.
- **Input shaper has no slicer-level output:** the correction is a Klipper `[input_shaper]` block for
  `printer.cfg`.
- **Firmware commands are Klipper only.** Marlin and RepRapFirmware are not supported: the generated
  coupons and every firmware command are Klipper G-code.

## Building from source

The app is a plain [Vue 3](https://vuejs.org/) + TypeScript + [Vite](https://vite.dev/) project under
[`web/`](web). You'll need [Node.js](https://nodejs.org/) 22 or newer.

```bash
cd web
npm install
npm run dev       # dev server at http://localhost:5173/
npm run build     # production build to web/dist
npm test          # Vitest unit + fixture-backed engine tests
npm run e2e       # Playwright end-to-end over real scans
```

Want a different coupon size or grid? Edit [`calibration_coupon.scad`](calibration_coupon.scad) in
OpenSCAD and export your own STL.

## Contributing

Issues and pull requests are welcome. Changes to the measurement pipeline must keep the fixture-backed
engine tests and the Playwright end-to-end tests green (`npm test` and `npm run e2e` in `web/`).

## License

[MIT](LICENSE) © 2026 Jakob Eichberger
