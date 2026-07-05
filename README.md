# ScanNTune

[![Web CI](https://github.com/jaak0b/ScanNTune/actions/workflows/web-ci.yml/badge.svg)](https://github.com/jaak0b/ScanNTune/actions/workflows/web-ci.yml)
[![License: MIT](https://img.shields.io/github/license/jaak0b/ScanNTune)](LICENSE)

**Calibrate your 3D printer's X, Y and Z scale and skew (the XY, XZ and YZ planes) by scanning printed
coupons on an ordinary office scanner. No calipers, no measuring, no typing numbers into a calculator.**

The result is a ready-to-paste correction for your firmware or slicer, worked out from a flat scan of a
printed coupon.

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
