# ScanNTune

[![Web CI](https://github.com/jaak0b/ScanNTune/actions/workflows/web-ci.yml/badge.svg)](https://github.com/jaak0b/ScanNTune/actions/workflows/web-ci.yml)
[![License: MIT](https://img.shields.io/github/license/jaak0b/ScanNTune)](LICENSE)

**Caliper-free 3D printer calibration from a flatbed scanner: skew, shrinkage, pressure advance, and
extrusion multiplier.**
Print a coupon, scan it on an ordinary office scanner, and get ready-to-paste firmware or slicer
corrections. No calipers, no measuring, no eyeballing test prints, no typing numbers into a calculator.

<div align="center">

## ▶ [Open ScanNTune in your browser](https://scanntune.jaak0b.at/)

**Runs entirely in your browser. Nothing to install, nothing uploaded to a server, on desktop or phone.**

</div>

![ScanNTune results](img/ScanNTune_Results.png)

> [!TIP]
> **A regular office flatbed scanner is all you need.** The same kind you'd use to copy a document,
> including the scanner built into an all-in-one printer. No camera photos, no special hardware, and no high
> end machine required. Scan at 600 DPI, which any normal home or office scanner can do.

> [!WARNING]
> **XY calibration is solid. XZ and YZ are experimental**: the standing-plate scans work, but the
> correction math for those planes hasn't seen the same real-world validation as XY yet. Sanity-check the
> results before trusting them on your printer.

## How you use it

1. **Once per scanner:** scan any plastic card (a credit, debit or loyalty card) so ScanNTune learns your
   scanner's true scale.
2. **Print the plate(s):** one plate per plane you want to check. XY prints flat; XZ and YZ print standing
   on-edge. Print only the planes you care about.
3. **Scan each twice:** lay a plate on the scanner and scan it flat, then give it a quarter turn and scan it
   again. Repeat for any other plates.
4. **Drop them all in:** open every scan in ScanNTune at once. It sorts them by plate automatically and gives
   you the firmware or slicer snippet for X/Y/Z scale and skew.

That's it. The whole thing takes a couple of minutes once the plates are printed.

## Pressure advance

ScanNTune also calibrates pressure advance from a scan, instead of you squinting at a tower or a row of
lines and picking the one that "looks best".

1. **Set up a printer profile** in the app (or import your PrusaSlicer or OrcaSlicer config) and download
   the generated G-code.
2. **Print the coupon:** a solid base in one filament, then a pause for a filament swap, then 16 test lines
   in a contrasting color. Any two filaments work as long as they differ in brightness. Each line prints at
   a different pressure advance value and contains slow, fast, slow speed changes, so a wrong PA value
   bulges or starves the line at the transitions.
3. **Scan it once.** ScanNTune measures each line's width along its length and scores how much it deviates
   at the speed transitions. The line that stays most even wins, refined to a continuous value between the
   steps.

The result is ready to paste: Klipper `SET_PRESSURE_ADVANCE`, Marlin `M900`, or RepRapFirmware `M572`.
On Klipper there's an optional follow-up coupon that sweeps `smooth_time` the same way.

## Extrusion multiplier / flow

ScanNTune also calibrates the extrusion multiplier (PrusaSlicer) / flow ratio (OrcaSlicer) from a scan,
instead of you measuring a thin wall with calipers or judging a top surface by feel.

1. **Generate and print the coupon** from your printer profile: a single-color part with rows of parallel
   single-bead lines at precisely known spacings.
2. **Scan it once,** face down. ScanNTune measures the air gap between neighboring lines to sub-pixel
   precision; since the line spacing is known exactly, the deposited bead width falls out of a single
   subtraction, averaged over more than a hundred gaps.
3. **Enter your current slicer flow** and get the corrected value back in the same format, plus an `M221`
   command for prints that are already sliced.

Line centres don't move when beads print fatter or thinner, so the measurement is immune to printer axis
stretch and material shrinkage. Filament that won't come off the plate (TPU, PETG) can be printed at the
bed's front edge and scanned together with the build plate.

---

## Just as good as measuring it by hand

I built this because I got tired of dimensional calibration. The usual routine is a printed coupon and a
matching calculator, like Vector 3D's "Califlower": print it, measure it corner to corner with calipers,
measure the diagonals for skew, type all of that into the calculator, and paste the result into your
firmware. The measuring is the annoying part: several caliper readings to take and keep track of, a diagonal
for skew that's awkward to measure squarely, and then all of it typed into the calculator without a mistake.
So I let a scanner do the reading instead.

Here's the same printer measured both ways: ScanNTune's result (left) and Califlower's coupon hand-measured
into its calculator (right).

![ScanNTune next to Califlower](img/ScanNTuneComparedToCaliflower.png)

The two come out almost exactly the same, differing by only 0.05% in X, 0.08% in Y, and 0.03° in skew. They
should match, because both are measuring the same printer. The only difference is that ScanNTune reads it
from a single scan instead of by hand with a caliper.

## How it works

- **Extrusion width doesn't affect it.** The coupon is a lattice of rings, and a ring's centre doesn't move
  when the walls print fatter or thinner. Over- or under-extrusion can't shift the scale or skew.
- **Two scans remove the scanner's distortion.** A flatbed scanner has its own slight stretch and skew.
  Scanning the coupon flat, then again quarter-turned, and averaging the two cancels the scanner's error and
  leaves the printer's. The leftover half-difference even tells you how far off your scanner is.
- **It calibrates scale off a plastic card.** A scanner's stated DPI is rarely exact, so ScanNTune measures a
  standard plastic card instead (all cards are ISO/IEC 7810 ID-1, 85.60 by 53.98 mm) and reads the true
  pixels-per-millimetre from its edges.

The computer vision runs client-side in a Web Worker with [OpenCV.js](https://docs.opencv.org/), so a full
scan is analysed on your own machine without the page ever freezing.

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

Want a different coupon size or grid? Edit [`calibration_coupon.scad`](calibration_coupon.scad) in OpenSCAD
and export your own STL.

## License

[MIT](LICENSE) © 2026 Jakob Eichberger
