# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A tool that **auto-calibrates a 3D printer's XY shrinkage and skew from a flatbed scan** of a printed
calibration coupon: no manual caliper measurements. The user prints `calibration_coupon.scad` (an open
lattice of measurement rings), scans it, and the software reads the geometry with OpenCV.js and emits
ready-to-paste firmware/slicer corrections.

The measurement principle: ring **centres** give true X/Y scale and skew (centres are immune to
over/under-extrusion, because extrusion changes a ring's wall width, not its centre). The correction math
mirrors the Vector 3D "Califlower" calculator (Klipper `SET_SKEW`, Marlin `XY_SKEW_FACTOR`/steps-per-mm,
Orca/Super shrinkage %, RRF `M556`).

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
npm run dev       # Vite dev server at http://localhost:5173/
npm run build     # vue-tsc typecheck + production build to web/dist
npm test          # Vitest: engine unit tests + fixture-backed CV tests
npm run e2e       # Playwright end-to-end over the real scans in web/e2e/fixtures
```

Structure:

- **`web/src/engine/`**: the framework-agnostic measurement engine (no Vue, no DOM assumptions beyond what
  OpenCV.js needs). Each function takes the loaded `cv` instance as a parameter, so OpenCV.js stays out of
  the main bundle (it lives in the worker chunk, loaded on first analysis) and tests can inject it. Stages:
  `ringDetector`, `gridMapper`, `affineSolver`, `couponAnalyzer`, `scanCombiner`, `cardEdgeMeasurer`,
  `overlayRenderer`, `correctionFormatter`, plus `types`, `opencv` (loader), `imageData`, and shared
  helpers `math`/`cvUtils`.
- **`web/src/worker/`**: a Comlink Web Worker (`analysis.worker.ts`) exposing `analyzeTwoScans` and
  `measureCardScan`; `decode.ts` decodes image bytes with `createImageBitmap` + `OffscreenCanvas` and
  renders overlays back as `ImageBitmap`. `web/src/workerClient.ts` is the only thing the UI calls for CV.
- **`web/src/components/`**: thin Vue pages (`ScanPage`, `CalibrationPage`, `ResultsPage`) plus the guide
  diagrams and controls, over Pinia stores in `web/src/stores/` (`useApp` for navigation + payload,
  `useCalibration` for the localStorage-backed scanner calibration).
- **Tests**: `web/tests/` (Vitest engine + fixture CV tests, with `tests/helpers/cv.ts` and
  `tests/fixtures/TestData_2solid.png`) and `web/e2e/` (Playwright over the real scans in
  `web/e2e/fixtures/`).

Absolute scale needs a known px/mm (scanner DPI is rarely exact), so the app measures a standard ISO/IEC
7810 plastic card (`cardEdgeMeasurer`) to learn the true px/mm; without it, only anisotropy and skew are
meaningful.

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
to `master`; `.github/workflows/deploy-web.yml` builds `web/dist` and publishes it to GitHub Pages on every
push to `master` (served at `https://scanntune.jaak0b.at/`). Note: push-triggered Pages deploys on this repo
sometimes fail with "Deployment failed, try again later" (a GitHub-side flake, seen on both the old C# and the
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
pressure advance (Klipper `PRESSURE_ADVANCE`, Marlin `M900 K`, RepRapFirmware `M572 S`) from a single
scan of a printed test coupon, instead of the eyeballed "prints" the usual tools produce. The coupon
is a two-layer base (a solid first layer, then a contrasting-color second layer for edge contrast) with
16 straight test lines, each printed at a different stepped PA value and each containing a slow to fast
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
a single scan of a single-color coupon and emits the flow correction (slicer flow % and `M221 S`).
The coupon (generated in-app, `em/gcodeGenerator.ts` over the shared `web/src/engine/gcode/emitter.ts`
extracted from the PA generator) is a frame band with the same 3-hole + solid-origin-corner fiducial
convention, a center rail, and two mirrored rows of 13 blocks of 7 parallel single-bead lines, each
block at a different known pitch (defaults 0.70-1.10 mm, always above the bead width: a flatbed cannot
read a slit much narrower than ~0.25 mm through the part's depth, so every gap must stay open). Lines
are 3 layers tall (1 narrower pedestal layer absorbs z-offset squish, 2 measured layers define the
scanned edge; scan top face down, lid closed) and overrun the band/rail by 1 mm so their tips weld onto
perimeters. Measurement (`em/fiducialAligner`, `em/gapMeasurer`, `em/emAnalyzer`): per gap, the bead
width is the gap complement `w = measured local pitch - measured gap` (line centres are
extrusion-immune, so printer axis stretch and material shrinkage cancel), edges located by a gradient
centroid (center-of-gravity) sub-pixel estimator, samples pooled over both rows, MAD-cleaned, and
summarized by the median. Distances convert to true mm ONLY via the card calibration px/mm
(`useCalibration`, a hard requirement for this flow); the affine is for locating features. The block
separators are NOT a width reference (their air is `2 + nominal - w`, w-dependent); they provide the
`biasMm` cross-check residual. `pitchScale` (measured vs commanded pitch) is a per-axis printer-scale
diagnostic. Validation contract: `web/tests/helpers/emRender.ts` renders coupons from known ground
truth; do not change the EM measurement math without keeping its render-recovery tests
(`emAnalyzer.spec.ts`) green, and `tests/engine/em/realScan.spec.ts` + `e2e/em.spec.ts` pin a real
600 dpi scan end to end (rule 1).

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

5. **Get owner approval before committing or pushing.** Never run `git commit` or `git push` (or open a PR)
   until the owner has approved. Approval can be **per-change** (present the diff summary, ask, proceed only
   after a clear "yes") or a **standing grant for a named branch** (once the owner blanket-approves work on a
   branch, commits to that branch need no further prompt). Pushes, and any commit to `master`, always require
   explicit approval regardless of a branch grant.

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

**Verification bar.** The standard for "verified" is `npm run build` plus `npm test` plus `npm run e2e` all
green (and, for any change to the measurement pipeline, the synthetic-fixture validation of rule 1). That
automated gate is sufficient: do not additionally launch a dev server for manual browser verification unless
the owner asks for it.

**Subagent routing.** When delegating to a subagent, prefer the `cavecrew-*` types wherever the task fits,
because their output is caveman-compressed and keeps the parent context small: use `cavecrew-investigator`
to locate or map code (read-only), `cavecrew-builder` for a surgical one or two file edit (it refuses three
or more files), and `cavecrew-reviewer` to review a diff, branch, or file. Only fall back to a general agent
when no cavecrew type fits, chiefly a multi-file implementation, since there is no cavecrew multi-file
builder.
