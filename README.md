# ScanNTune

[![Build](https://github.com/jaak0b/ScanNTune/actions/workflows/build.yml/badge.svg)](https://github.com/jaak0b/ScanNTune/actions/workflows/build.yml)
[![Latest release](https://img.shields.io/github/v/release/jaak0b/ScanNTune?display_name=tag)](https://github.com/jaak0b/ScanNTune/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/jaak0b/ScanNTune/total)](https://github.com/jaak0b/ScanNTune/releases)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-blue)
[![License: MIT](https://img.shields.io/github/license/jaak0b/ScanNTune)](LICENSE)

**Calibrate your 3D printer's XY scale and skew by scanning a printed coupon on an ordinary office scanner.
No calipers, no measuring, no typing numbers into a calculator.**

The result is a ready-to-paste correction for your firmware or slicer, worked out from a flat scan of a
printed coupon.

![ScanNTune results](img/ScanNTune_Results.png)

> [!TIP]
> **A regular office flatbed scanner is all you need.** The same kind you'd use to copy a document,
> including the scanner built into an all-in-one printer. No camera photos, no special hardware, and no high
> end machine required. Scan at 600 DPI, which any normal home or office scanner can do.

## How you use it

1. **Once per scanner:** scan any plastic card (a credit, debit or loyalty card) so ScanNTune learns your
   scanner's true scale. You only redo this if you change scanners.
2. **Print the coupon:** print [`calibration_coupon.stl`](calibration_coupon.stl) flat on your bed.
3. **Scan it twice:** lay it on the scanner and scan it flat, then give it a quarter turn and scan it again.
4. **Load and paste:** open both scans in ScanNTune, then copy the snippet for your firmware or slicer.

That's it. The whole thing takes a couple of minutes once the coupon is printed.

## Installation

ScanNTune runs on Windows. Grab the latest version from the
[**Releases page**](https://github.com/jaak0b/ScanNTune/releases). It keeps itself up to date after that,
applying new versions quietly the next time you open it.

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

- **It measures ring centres, not walls.** The coupon is a lattice of rings, and a ring's centre doesn't
  move when the walls print fatter or thinner. So over- or under-extrusion can't shift the scale or skew it
  reports.
- **It cancels the scanner's own distortion.** A flatbed scanner has a small stretch and skew of its own. If
  you scanned once, you'd bake that into the printer's numbers. Scanning flat and quarter-turned and
  averaging the two makes the scanner's error cancel and leaves the printer's. The leftover half-difference
  even tells you how far off your scanner is, as a free diagnostic.
- **Absolute scale is anchored to a real object.** A scanner's stated DPI is rarely exactly true, so to
  report shrinkage as a real percentage ScanNTune reads a standard plastic card instead (they're all the
  same ISO/IEC 7810 ID-1 size, 85.60 by 53.98 mm, held to a tight tolerance) and works out the true
  pixels-per-millimetre from its edges.
- **It reports an honest result.** The fit is robust and it shows you its residual, so a genuinely warped
  part shows up in the number instead of being quietly smoothed over.

## Building from source

If you'd rather build it yourself, you'll need the .NET 10 SDK on Windows.

```powershell
dotnet build src\ScanNTune.slnx
dotnet run --project src\ScanNTune.App
```

Want a different coupon size or grid? Edit [`calibration_coupon.scad`](calibration_coupon.scad) in OpenSCAD
and export your own STL.

## License

[MIT](LICENSE) © 2026 Jakob Eichberger
