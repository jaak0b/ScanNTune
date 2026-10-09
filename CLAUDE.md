# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A tool that **auto-calibrates a 3D printer's XY shrinkage and skew from a flatbed scan** of a printed
calibration coupon: no manual caliper measurements. The user prints `calibration_coupon.scad` (an open
lattice of measurement rings), scans it, and the software reads the geometry with OpenCV.js and emits
ready-to-paste firmware/slicer corrections.

The same print, scan and measure approach covers four calibration flows, named as the UI names them:
skew/shrinkage (the ring coupon described here, also on the XZ and YZ planes), pressure advance,
extrusion multiplier / flow ratio, and input shaper. The last three print a G-code coupon generated in-app
instead of an STL; each has its own section below.

The app supports **Klipper only** (owner decision, 2026-10-08): every generated coupon and every firmware
command it emits is Klipper G-code, and the firmware dropdowns list Klipper as their only option. Printer
profiles stored with the retired Marlin or RepRapFirmware value load as Klipper, and slicer presets import
as Klipper whatever G-code flavor they name. The slicer outputs (shrinkage compensation %, extrusion
multiplier / flow ratio) are plain slicer settings.

The measurement principle: ring **centres** give true X/Y scale and skew (centres are immune to
over/under-extrusion, because extrusion changes a ring's wall width, not its centre). The correction math
mirrors the Vector 3D "Califlower" calculator (Klipper `SET_SKEW`, rotation distance, Orca/Super
shrinkage %).

Orientation is automatic. The coupon's origin-corner ring **and its +X neighbour** are printed SOLID (no
hole): a two-ring marker the software reads. `origin → neighbour` is the coupon's +X, which resolves
rotation AND mirror-flip with no manual input (see "Coupon & orientation" below).

## The app: a Vue 3 web app

The app is a plain web app under `web/` (Vue 3 + TypeScript + Vite + Vuetify). **Web is the only target.**
The CV measurement pipeline is ported to TypeScript and runs in a **Web Worker** using **OpenCV.js**, so
analysis is off the main thread (the page never freezes), needs no cross-origin-isolation headers (works on
GitHub Pages), and is fast (V8 JIT + an optimized OpenCV.js build). Native `<input type=file>` and
`<input type=number>` mean there is no soft-keyboard, touch-stepper, or iOS file-input workaround to carry.

Commands (run inside `web/`):

```bash
npm install
npm run dev          # Vite dev server at http://localhost:5173/
npm run build        # vue-tsc typecheck + production build to web/dist
npm test             # Vitest: engine unit tests + fixture-backed CV tests (whole suite: CI only)
npm run test:stats   # Vitest: the input shaper statistics suite (web/tests/stats), not part of npm test (CI only)
npm run e2e          # Playwright end-to-end over the real scans in web/e2e/fixtures (CI only)
npx vitest run FILE  # the only test command for the owner's machine: at most about three affected spec files
```

Structure:

- **`web/src/engine/`**: the framework-agnostic measurement engine (no Vue, no DOM assumptions beyond what
  OpenCV.js needs). Each function takes the loaded `cv` instance as a parameter, so OpenCV.js stays out of
  the main bundle (it lives in the worker chunk, loaded on first analysis) and tests can inject it. Stages:
  `ringDetector`, `gridMapper`, `affineSolver`, `couponAnalyzer`, `scanCombiner`, `cardEdgeMeasurer`,
  `overlayRenderer`, `correctionFormatter`, plus `types`, `opencv` (loader), `imageData`, and shared
  helpers `math`/`cvUtils`. The other flows live in their own subfolders: `pa/` (pressure advance),
  `em/` (extrusion multiplier / flow ratio) and `is/` (input shaper), whose coupon generators share
  the G-code emitter and coupon shell in `gcode/`. Concerns shared across flows are top-level modules,
  among them `scannerCalibration`, `resolutionGate`, `measurementBackdrop`, `cornerFiducialSolver`,
  `plateFiducialLocator` and `correlatedNoise`.
- **`web/src/worker/`**: a Comlink Web Worker (`analysis.worker.ts`) exposing `analyzeScan` (one
  skew/shrinkage scan; `SkewPage` combines the scans on the main thread through
  `multiPlaneCombiner.reconcileScans`), `analyzePaScan` (one scan), `analyzeEmScans` (one or two scans),
  `analyzeIsScans` (two scans) and `measureCardScan`; `decode.ts` decodes image bytes with
  `createImageBitmap` + `OffscreenCanvas` and renders overlays back as `ImageBitmap`.
  `web/src/workerClient.ts` is the only thing the UI calls for CV.
- **`web/src/components/`**: thin Vue pages, one per flow (`SkewPage`, `PaPage`, `EmPage`, `IsPage`),
  plus `CalibrationPage` (the scanner card calibration) and `ProfilePage` (the printer profile editor),
  the guide diagrams and controls, over Pinia stores in `web/src/stores/` (`useApp` for navigation +
  payload, `useCalibration` for the localStorage-backed scanner calibration, `usePrinterProfiles`, and
  one settings store per flow).
- **Tests**: `web/tests/` (Vitest engine + fixture CV tests, with `tests/helpers/cv.ts` and
  `tests/fixtures/TestData_2solid.png`) and `web/e2e/` (Playwright over the real scans in
  `web/e2e/fixtures/`).

Absolute scale needs a known px/mm (scanner DPI is rarely exact), so the app measures a standard ISO/IEC
7810 plastic card (`cardEdgeMeasurer`) to learn the true px/mm; without it, only anisotropy and skew are
meaningful. The card is measured along its LONG side only: the short side reads through the lid-shadow
zone and is banned as a reference. The scanner's transport axis also carries low-frequency mechanical
waviness (about 0.1 mm on real units), so fine lateral measurements (ringing wiggles) are only read along
the sensor-row axis; flows that need both directions scan the part twice, a quarter turn apart.

A scanner's scale error can be per-axis: a CCD scanner is mis-scaled along its sensor axis but accurate
along the carriage axis, so a calibration is a `ScaleReference` (a scalar px/mm, or a per-axis pair for
CCD), never a bare number. Every flow that converts scan pixels to millimetres must take the
`ScaleReference` from `scaleReferenceAtDpi` (the only exported way to price a stored calibration) and
convert along its actual measurement direction via `referenceAlongDirection`; a new flow that pockets a
scalar px/mm reintroduces the wrong-axis bug on CCD scanners. Each flow's render-recovery tests should
include one case with a deliberately wrong figure on the unused axis to prove it cannot leak in (see the
quarter-turned coupon case in `emAnalyzer.spec.ts`).

Two durable gotchas:
- **OpenCV.js loads via a default import** (`import cvReady from '@techstark/opencv-js'`), NOT a namespace or
  dynamic `import()`. Its `module.exports` is a Promise, which a namespace/dynamic import turns into a broken
  thenable ("Promise.prototype.then called on incompatible receiver") in both Vitest and the browser build; a
  bundler default import returns `module.exports` (the real Promise) directly. In Vitest the engine CV tests
  load it with a native `require` instead (see `web/tests/helpers/cv.ts`), because even the default import is
  re-wrapped by Vitest's module runner.
- **Vite `base` is `/`**: the site is served at the root of the custom domain (`https://scanntune.jaak0b.at/`),
  so assets live at the root, not under a project sub-path. (GitHub Pages 301-redirects
  `https://jaak0b.github.io/ScanNTune/` to the custom domain root.) Asset URLs and the STL download go through
  `import.meta.env.BASE_URL`. The app version shown in the brand bar is injected from `package.json` at build
  time via the Vite `define` `__APP_VERSION__`.

CI: `.github/workflows/web-ci.yml` builds, unit-tests, and e2e-tests the app on pull requests and on pushes
to `master`, and runs the input shaper statistics suite (two files: no false detection on pure noise, honest
frequency interval) as its own `stats` job (`npm run test:stats`), only when the input shaper analysis or the
suite's own files change
(the path list lives in the `changes` job of `web-ci.yml`); `.github/workflows/deploy-web.yml` builds `web/dist` and
publishes it to GitHub Pages on every push to `master` (served at `https://scanntune.jaak0b.at/`).
Note: push-triggered Pages deploys on this repo sometimes fail with "Deployment failed, try again later" (a GitHub-side flake, seen on both the old C# and the
Vue deploy at the same commit); re-running the deploy via `workflow_dispatch` at the same commit succeeds.

The measurement engine was ported 1:1 from a retired C# implementation and validated against the same
`TestData_2solid.png` fixture at the same tolerances (23 rings, ~0 skew, isotropy), plus Playwright over the
real scans (the card recovers ~23.6 px/mm; the two-scan flow completes on 35 MP scans without freezing).
Do not change the ported math without re-validating those fixtures (rule 1).

The coupon model source (`calibration_coupon.scad`) lives at the repo root. It is one parametric design
with a `plane` parameter that renders three pre-oriented plates: `XY` (flat), `XZ` and `YZ` (thick,
standing on-edge, funnel-holed, with a solid base). Each is exported and copied into `web/public/` for the
in-app download, lowercase-named: `calibration_coupon_{xy,xz,yz}.stl`. Re-render one with
`openscad -D 'plane="XZ"' -o web/public/calibration_coupon_xz.stl calibration_coupon.scad` (~90s CGAL).
Note: PowerShell variable names are case-insensitive, so do NOT drive the output filename from a
`$P = $p.ToUpper()` variable in a loop; it aliases `$p` and uppercases the filename (Pages is
case-sensitive). Preview a plate with `--projection=ortho --camera=0,0,0,0,0,0,180 --viewall --autocenter`.

The engine test fixtures (`web/tests/fixtures/render_{xy,xz,yz}.png` and the six
`web/e2e/fixtures/plate_{xy,xz,yz}_{0,90}.png`) are rendered from the same model with
`-D scan_view=true -D '$fn=200'` (and `-D scan_rotate=90` for the quarter-turn pair): a flat 2D projection
of the scanned face, dark on light. The high `$fn` is REQUIRED for the projection (at 96 the rib/ring
union leaves hairline slivers that drop a ring); it must be a CLI flag, not a conditional in the .scad,
because OpenSCAD resolves `$fn` before the `scan_view` override. Because the ring/hole/dot centres are
exactly the model's, these verify ring detection on the new geometry AND the plane-ID read against known
geometry. Filenames must be lowercase (Pages/CI are case-sensitive; PowerShell's case-insensitive
variables make `$P = $p.ToUpper()` silently uppercase a filename). Re-render if the measured geometry
changes.

## Coupon & orientation

The coupon is an open lattice of `grid_n` × `grid_n` rings joined by ribs (default 5×5, 100 mm baseline).
Two rings are printed SOLID (no hole) as the **orientation marker**: the origin corner and its +X neighbour.
`gridMapper` finds the unique "corner + edge-neighbour" pair of missing (holeless) grid vertices;
`origin → neighbour` is the coupon's +X. Because that gives the true physical axes, X/Y labels **and** the
skew sign come out correct at any rotation or mirror-flip: **no manual flip flag**. The marker is
**required**: if it can't be located `mapGrid` throws (it tolerates at most one stray missed hole, but a
stray adjacent to a corner makes the marker ambiguous and is rejected too, and an absent marker is rejected:
there is deliberately no rotation-only fallback).

`ringDetector` gotcha: the circularity gate is **loose (0.20)** because real printed/scanned holes are rough
(~0.2 to 0.8 circularity). Rings are separated from the much larger square lattice cells by a **size
cluster** (radius-median filter), NOT by circularity: a strict threshold silently drops nearly every ring on
a real scan.

## Pressure advance calibration

A second, independent calibration flow lives under `web/src/engine/pa/`: it estimates linear
pressure advance (Klipper `PRESSURE_ADVANCE`) from a single scan of a printed test coupon, instead of
the eyeballed "prints" the usual tools produce. The coupon is a two-layer base (a solid first layer,
then a contrasting-color second layer for edge contrast) with 16 straight test lines, each printed at a different stepped PA value and each containing a slow to fast
to slow speed change so a PA mismatch bulges or starves the line at the two speed transitions. Three
corner holes are fiducials; the fourth corner is left solid, so the missing hole marks the origin the
same way the XYZ coupon's marker does. Measurement: `fiducialAligner` solves the affine from the three
holes, `lineMeasurer` profiles each line's width to sub-pixel precision perpendicular to the line (any
base/line filament colors work as long as they differ in brightness: the profile extremum is the point
deviating most from the base tone, so lines darker or brighter than the base measure identically), and
`paAnalyzer` scores each line by the RMS width deviation inside a window around each speed transition,
then refines the discrete best line to a continuous PA value by parabolic minimum of the score curve.
The G-code for the coupon is generated in-app per printer profile (firmware, speeds, temperatures,
filament swap pause), stored in the localStorage-backed `usePrinterProfiles` Pinia store, mirroring
`useCalibration`'s pattern. Validation contract: `web/tests/helpers/paRender.ts` is a synthetic renderer
that draws a coupon image from known ground-truth PA and geometry; it is the ground-truth fixture for
this pipeline the same way `TestData_2solid.png` is for the XY/XZ/YZ engine. Do not change the PA
measurement math (alignment, width profiling, transition scoring, parabolic refinement) without keeping
the render-recovery tests green (rule 1).

## Extrusion multiplier (flow) calibration

A third calibration flow lives under `web/src/engine/em/`: it measures the deposited bead width from
one scan of a single-color coupon (a second scan of the same coupon rotated 180 degrees on the glass is
optional) and emits the flow correction (slicer flow % and `M221 S`).
The coupon (generated in-app, `em/gcodeGenerator.ts` over the shared `web/src/engine/gcode/emitter.ts`
extracted from the PA generator) is a frame band with the same 3-hole + solid-origin-corner fiducial
convention, a center rail, and two mirrored rows of 9 blocks of 5 parallel single-bead lines, each
block at a different known pitch. The pitch range is derived from the nozzle (`defaultEmTestSpec`): the
nominal bead width is 1.05 times the nozzle diameter, the tightest pitch keeps a 0.65 mm open gap even
for beads 15% wider than nominal, and the sweep spans half a nominal width, so a 0.4 mm nozzle gets
1.14 to 1.35 mm. The 0.65 mm floor (`MIN_OPEN_GAP_MM`) is the narrowest gap a flatbed reads without bias
through the coupon's depth: diagnostic 600 dpi scans of dark and light coupons show the through-depth
slit shadow inflating the measured bead width below it. It is scanner physics in absolute millimetres,
so it does not scale with the nozzle. Lines are 3 layers tall (1 pedestal layer at 0.72 times the
nominal width absorbs z-offset squish, 2 measured layers define the scanned edge; scan top face down,
lines parallel to the lamp's travel) and overrun the band/rail by 2.5 mm (`ANCHOR_OVERLAP_MM`), long
enough that the wall crossing sits past the acceleration ramp and the nozzle pressure lag after the
travel, so each tip welds onto the perimeter at full bead width (a starved tip snaps off).
Measurement (`em/fiducialAligner`, `em/gapMeasurer`, `em/emAnalyzer`): per gap, the bead
width is the gap complement `w = measured local pitch - measured gap` (line centres are
extrusion-immune, so printer axis stretch and material shrinkage cancel), edges located by a gradient
centroid (center-of-gravity) sub-pixel estimator, samples pooled over both rows and all blocks of a
scan, MAD-cleaned, and summarized by the median. With two scans the per-scan medians are combined by
their equal-weight mean, which cancels the lamp's one-sided shading. The flow output is expressed in
the slicers' rounded bead model: the cross-section the coupon commanded over PrusaSlicer's
`Flow::mm3_per_mm` (a rectangle with
semicircular ends) at the measured width. Distances convert to true mm ONLY via the card calibration px/mm
(`useCalibration`, a hard requirement for this flow); the affine is for locating features. The block
separators are NOT a width reference (their air is `2 + nominal - w`, w-dependent); they provide the
`biasMm` cross-check residual. `pitchScale` (measured vs commanded pitch) is a per-axis printer-scale
diagnostic. Validation contract: `web/tests/helpers/emRender.ts` renders coupons from known ground
truth; do not change the EM measurement math without keeping its render-recovery tests
(`emAnalyzer.spec.ts`) green, and `tests/engine/em/realScan.spec.ts` + `e2e/em.spec.ts` pin a real
600 dpi scan end to end (rule 1).

## Input shaper calibration

A fourth calibration flow lives under `web/src/engine/is/`: it measures each axis's resonance frequency
and damping ratio from two scans of one coupon (face down, then a quarter turn on the glass; each axis is
read from the scan whose sensor rows run along its measured lines) and recommends a shaper (a Klipper
`[input_shaper]` block). The coupon (generated in-app,
`is/gcodeGenerator.ts` and `is/couponGeometry.ts`) is a frame band with the same 3-hole +
solid-origin-corner fiducial convention around an open window. Single test lines run in, turn a sharp
90 degree corner, and cross the window as their measured segment, so the corner's velocity step leaves a
decaying ring in the bead. The measurable band is 20 to 200 Hz. Each axis prints two interleaved speed
tiers, the line speed and a slower tier whose ratio is derived from the two-sided detection level, the
speed check's power and the confidence gate (`speedTiersFor`, ratio 1.6547; 90 and 150 mm/s by default;
both tiers need a line speed of at least 34 mm/s). Each tier has a bottom-dense corner-speed ladder, one
rung per line, with the fastest corners printed last in every layer: three rungs spaced geometrically from
20 mm/s up to the fastest corner whose bead still follows a ring at every 1 Hz grid frequency of the band
(`fastestFollowableCornerMmS`, 25.5 mm/s by default, carried on the fitted spec as `followableCornerMmS`),
then an upper ladder spaced in three geometric steps from there towards the corner speed (100 mm/s by
default), of which only the rungs whose bead follows a ring at one band frequency at least are printed.
Followability is judged from the first traced millimetre, at every grid frequency, at the damping ratio
the request carries as `followabilityDampingRatio` (`FOLLOWABILITY_DAMPING_RATIO`, 0.03: a well-built
CoreXY X axis measured 0.033 by accelerometer, and a lighter damping is the safe side). At a low
acceleration the 20 mm/s bottom rung itself folds inside the band; the ladder is then designed up to the
highest frequency that rung still follows (47 Hz at 1000 mm/s^2, 64 Hz at 1200, 97 Hz at 1500 with a
0.4 mm nozzle), and `bandTopWarning` names that reduced band top and the acceleration. When even that rung
folds at 20 Hz (below 567 mm/s^2 for a 0.4 mm nozzle at the default speeds, and for a
line speed of 60 mm/s or less at 1500 to 20000 mm/s^2), `fitSpecToPrinter` refuses the coupon, so no G-code is offered. The line
count per speed is derived (`ladderLinesPerSpeed`), 4 by default: three followable rungs plus the one
upper rung that follows at the low end of the band; the bed fit removes only upper rungs and never goes
below the followable floor of 3, so a smaller bed never lowers the band top. Each line
raises the firmware's corner limit to its own rung only for its run-up, measured segment, tail and coast,
then sets the profile's own value back (`junctionLimitCommands`), with planner stops (`G4 P0`) between
lines. The test runs at the profile's print acceleration and resets the speed factor with `M220 S100`,
because a leftover speed factor would scale the frequency on both tiers alike. The default coupon is
104.283 mm square (about 13.1 minutes of motion) and fits a 120 mm bed unchanged. Measurement (`lineTracer`, `ringAnalyzer`, `ringGls`, `ringLikelihood`,
`artifactSearch`, `cornerTransient`, `alongTrackLag`): each line's centre is traced to sub-pixel
precision and its lateral deviation converts to true mm through the card `ScaleReference`. The time base
is the deliberate exception: a sample's time since the corner comes from its commanded coupon-frame
distance (the sample mapped back through the fiducial affine) and the commanded speed profile, so printer
axis scale and plastic shrinkage cannot bias the frequency. Per axis, the lines share one damped ring
(frequency and damping) over AR noise whitened exactly, fitted by generalized least squares variable
projection. Detection is the generalized likelihood ratio with the noise model refitted under each
hypothesis, summed over the lines, with the look-elsewhere effect over the 2,353-point frequency and
damping grid paid by a Bonferroni bound at a 0.1% false-alarm level; the frequency interval is the
profile-likelihood interval. With two tiers, the speed check is a nested likelihood ratio test inside
the joint fit: one extra parameter, the log ratio of the slower tier's frequency to the faster tier's,
tested against zero at the 0.1% level (a machine resonance keeps its frequency at both tiers, a print
or scan pattern scales with the speed); only a frequency that demonstrably changes with the speed
refuses the axis; a coupon left with one tier (a small bed, or a line speed below 34 mm/s) gets a
leave-one-line-out influence check instead. The response must also be shown to be the corner's
transient, which rejects forced tones such as a fan: locked to the corner (a seeded Monte Carlo
randomization test of the lines' phases) or decaying (the boundary test of zero damping), each at half
the 0.1% level; the artifact search labels a pattern only when it is not shown locked to the corner.
The replicate check and the confidence gate must not fail. A damping ratio fitted at its 0.4 bound does not refuse the axis: the shaper is then designed at
Klipper's default damping ratio 0.1, which the configuration snippet writes. The two axes are then estimated jointly: the axis along one group's lines is the other group's
measured axis and rings after its corner too, so each axis's ring is refitted on deposit times
corrected by the other axis's fitted ring at the same corner
speed (the along-track lag), kept only when the other axis is accepted. Validation contract:
`web/tests/helpers/isTraceSim.ts` (seeded trace simulator) and `web/tests/helpers/isRender.ts` (coupon
renderer) are the synthetic ground truth; `web/tests/helpers/plannerReplay.ts` is the planner oracle,
replaying the generated G-code through a planner ported from the Klipper sources without importing
production code; the `web/tests/stats/` suite (`npm run test:stats`) holds the
statistical calibration criteria; `web/tests/fixtures/is_default.gcode` pins the default coupon's G-code
byte for byte. The design, its figures and its open items are in
`docs/superpowers/specs/2026-10-08-is-ladder-two-tier-detection-design.md`. Do not change the IS
measurement math (tracing, time base, noise model, detection, estimation, checks, along-track lag)
without keeping the render-recovery tests (`isAnalyzer.spec.ts`) and the stats suite green (rule 1); a
stats criterion already red (the design doc lists it) stays red until it is fixed honestly and is never
loosened to pass.

## Conventions

The coding rules are strict; each is numbered for unambiguous reference. Do not cite these rule numbers in
shipped source, comments, or UI text: they are guidance for how to work, not documentation of the code.

1. **Measurement integrity: established methods only, never a fudge.** Every change to the measurement
   pipeline (ring detection, centre estimation, affine/robust fitting, correction math) must be an
   established, published algorithm or a standard library primitive (OpenCV.js, ml-matrix), chosen because
   it is the correct model for the problem, and named as such (e.g. "Taubin circle fit", "Huber
   M-estimator", "Circle Hough Transform"). NEVER introduce a hand-tuned constant, empirical offset, axis
   "nudge", or bias correction fitted to make one particular scan's numbers look right: that overfits the
   sample and lies on the next one. Before trusting a pipeline change, validate it against the synthetic
   `TestData_2solid.png` fixture: it must not regress there, and only then judge it on real scans.

2. **No silently swallowed errors.** A `catch` must do something meaningful: surface the error to the user,
   rethrow, or return a value the caller can act on. Never leave an empty `catch`. A scan that cannot be
   aligned is a normal outcome, not an exception: `analyzeCoupon` returns a `CalibrationResult` with
   `aligned: false`, the detected rings, and a user-worded `failureReason` so the UI can explain the failed
   scan; keep that contract. Only a genuinely unreadable image throws.

3. **Keep the engine framework-agnostic and modular.** Code in `web/src/engine/` must not import Vue, Pinia,
   or touch the DOM beyond what OpenCV.js needs; the UI, the worker, and the tests all import it directly. A
   new CV stage, output flavour, or scanner source should be added as its own module, not by editing
   unrelated ones.

4. **Limited AI attribution in git/GitHub.** A `Co-Authored-By: Claude <...>` trailer IS allowed on commits.
   Beyond that trailer, no AI attribution anywhere: no "Generated with Claude Code" (or any similar
   "made/assisted by AI") line, and no AI tool name in the commit subject or body, PR titles or descriptions,
   issue/PR comments, tags, or release notes. Keep commit messages to a single short sentence (a concise
   subject line, no body).

5. **Standing commit grant; pushes and master need approval.** Commit at will on any branch other than
   `master`, without asking first: one commit per coherent piece of work, so each stays reviewable. Pushing
   (to any branch), opening or merging a PR, and any commit on `master` always require the owner's explicit
   approval each time.

6. **Never use the em-dash character `—`, and never use a hyphen `-` as a substitute for it.** The em-dash
   is banned everywhere you write: source, comments, docs, UI text, commit messages, PR titles and bodies,
   issue/PR comments, and chat replies. Do not swap in a hyphen `-` to get the same dash-like pause either.
   Rewrite the sentence: use a colon, parentheses, a comma, or two separate sentences. A hyphen is allowed
   ONLY where grammar genuinely requires one, such as a compound modifier ("sub-pixel", "user-facing") or a
   hyphenated name.

7. **UI text is plain technical prose; terminology is the community's, everywhere.** Helper texts, hints,
   notes, and warnings are complete, grammatical sentences in a neutral register, written the way a good
   manual states facts. Short but never telegraphic: no clipped fragments, no dropped articles. Brevity
   comes from cutting information, never from cutting grammar; two to three short sentences is the normal
   size. Content stays factual: what the option does and what it requires, no persuasion ("pick this
   when"), no restating the control's label, no setup-specific claims where a general one is true (say
   "the backing, either the lid or a sheet of paper", not "the scanner lid").
   Terminology: use the words the 3D printing community already uses, and use them consistently, in UI
   text AND internally (identifiers, comments, docs), so no one has to translate between code vocabulary
   and printing vocabulary. Settings are named as the slicers and firmwares name them (extrusion
   multiplier, flow ratio, pressure advance, z-offset, e-steps, rotation distance); hardware and process
   terms are the accepted ones (nozzle, bed, build plate, first layer, perimeter, brim, filament swap).
   Never invent a synonym for an established term; keep one term per concept ("bed" is the printer's
   surface, "build plate" the removable sheet). Where ecosystems differ, use the term matching the user's
   selected firmware or slicer, or name both once ("extrusion multiplier / flow ratio"). Existing internal
   names are renamed opportunistically when the code is touched, not in bulk churn.

8. **Diagnostic readouts show raw values.** Detection and per-scan facts in the UI present each underlying
   field as its own labeled row with the exact value: booleans as yes/no, quantities as the number with its
   unit ("Rotation: 90 degrees"). Never fold several facts into a prose sentence ("mirrored, rotated a
   quarter turn"); prose is for guidance text only.

9. **Never store a printer setting solely to restore it after a test print.** A generated test may override
   firmware limits, but the restore is a firmware restart, stated only as an end-of-print G-code comment
   (no note in the UI), never a numeric restore block from stored profile values. A value may live in the
   printer profile only when it actively configures generated prints.

10. **Never downscale or resample a scan image anywhere in a measurement path.** Analysis always runs on
    the original pixels; scaling is allowed only for display (overlay thumbnails, previews).

11. **Coupon geometry derives its minimum size.** A coupon is as small as its measurement constraints
    allow and no bigger: the interior is computed from the constraints with no padding. Fitting a
    120 x 120 mm bed is an ideal worth designing toward, never a reason to sacrifice measurement validity;
    the bed-fit machinery shrinks the spec for small beds. Printed paths must form continuous beads (no
    zero-flow gap inside a path) and nothing may extend outside the coupon outline.

12. **Extend the concept's existing home; never bolt a duplicate beside a symptom.** Before adding or
    fixing logic, find the module that already owns the concept (search for the concept, not just the
    symptom site) and extend it. Never compute a value the codebase already derives elsewhere: if a
    figure (resolution, px/mm, scale reference, fiducial, orientation) is produced in two places, unify
    on the single source. A concern shared across flows lives in a shared engine module wired into all
    consumers, never patched into one flow; always ask whether every other scan flow would want the
    same. A minimal local guard that duplicates existing logic is a defect, not a small change. Any
    non-trivial engine or cross-cutting change gets a short written design first (its canonical home,
    what it extends, what it must not duplicate) for owner approval before implementation.

13. **A change to a shared concern MUST land in every flow that has the concern; partial application is a
    defect.** Any change that fixes, hardens, or improves something existing in more than one calibration
    flow (measurement statistics, uncertainty reporting, scan handling, coupon design constraints,
    diagnostics, UI conventions) is INCOMPLETE until every affected flow consumes it, in the same change
    or an immediately following one on the same branch. A flow may be exempted ONLY by a written
    technical-mismatch statement in the design or PR: the concern demonstrably does not exist there
    (different physics, different measurement model). "That flow already works", "its tests are green",
    "out of scope", and "porting requires a refactor" are NEVER acceptable; if sharing requires a
    refactor, the refactor is part of the change, not a reason to skip it. The shared implementation
    lives in exactly one engine module consumed by all flows; a per-flow copy of shared logic is a defect
    to be fixed on sight, and a change that adds one must not pass review.

14. **Always use superpowers' `subagent-driven-development` for implementation work; give every subagent a
    correct, specific title; never run more than 1 Fable agent at a time.** Never spawn a second Fable
    agent while one is still running, no matter how urgent the remaining work feels or how much faster
    finishing a batch would go: Fable is the most expensive tier, and an uncontrolled fan-out there can
    exhaust the owner's usage budget in one shot. This is a hard limit, not a target to approach. Every
    subagent's title must specifically name what it's doing, not a generic label: a reader should be able
    to tell subagents apart from their titles alone.

**Verification bar.** The standard for "verified" is `npm run build` plus `npm test` plus `npm run e2e` all
green (and, for any change to the measurement pipeline, the synthetic-fixture validation of rule 1). That
automated gate is sufficient: do not additionally launch a dev server for manual browser verification unless
the owner asks for it. On the owner's machine, never run a full suite: not `npm test` without file
filters, not `npm run e2e`, and not `npm run test:stats` (the whole statistics suite). The full gate and the
statistics suite run on CI only. A change runs only the tests it actually affects, at most a very small
handful of spec files (about three, e.g. `npx vitest run tests/engine/em/emAnalyzer.spec.ts`), plus the
type check (`npx vue-tsc --noEmit`). Any bigger set of tests, and every full suite, runs on GitHub CI after
a push. Make all the code changes first, then run the affected tests once at the end, plus at most once at the
start when a baseline is needed; do not re-run tests repeatedly while working. The exception is a bug fix,
which is test-driven: write the failing test first, run it to see it fail, fix the code, run it to see it
pass. A single statistics file (`tests/stats`) may be run locally only when the change adds or edits that
exact file (`npx vitest run --config vitest.stats.config.ts tests/stats/NAME.stats.spec.ts`); otherwise
statistics results come from CI. The full gate still defines "verified", but CI runs it, not the local
machine. Work fast: tests may break while a feature is in progress. Do not trigger CI, or re-run another
agent's tests, after every change; batch the work and run CI once at the end of a batch. Before a feature is
handed to the owner to test, the CI gate must be green apart from failures that already existed before the
work started, so fix the remaining reds in one round before the handover.

**Subagent routing.** When delegating to a subagent, prefer the `cavecrew-*` types wherever the task fits,
because their output is caveman-compressed and keeps the parent context small: use `cavecrew-investigator`
to locate or map code (read-only), `cavecrew-builder` for a surgical one or two file edit (it refuses three
or more files), and `cavecrew-reviewer` to review a diff, branch, or file. Only fall back to a general agent
when no cavecrew type fits, chiefly a multi-file implementation, since there is no cavecrew multi-file
builder.

**Review subagents never extend the benefit of the doubt.** Any subagent dispatched to review code
(`cavecrew-reviewer` or otherwise) must treat every existing assumption or invariant in the code under
review (input already validated, edge case already handled, branch unreachable, and so on) as unverified
until it actually checks, never as true just because the code is already there and presumably works.
This is not a demand to always find a bug: "I checked this specific assumption and it holds" is a
legitimate, complete answer, and an empty findings list is a valid outcome, not a failure to look hard
enough. The point is to remove unearned trust in existing code, not to manufacture findings to avoid
reporting zero.
