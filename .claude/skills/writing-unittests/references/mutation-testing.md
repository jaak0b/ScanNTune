# Mutation testing with Stryker

StrykerJS (`@stryker-mutator/core` + `@stryker-mutator/vitest-runner`) plants small bugs
(mutants: flipped operators, deleted statements, changed constants) in the engine source and
reruns the covering tests; a mutant that survives on covered core code names a weak test
directly. The HTML report lands at `web/reports/mutation/mutation.html` (gitignored).

## The three ways to run it

- **Local, changed files (the default): `npm run mutation`** from `web/`. A script
  (`web/scripts/mutation-changed.mjs`) computes the engine source files changed relative to
  master (branch commits plus staged, unstaged, and untracked work), filters them to the mutate
  scope, and runs Stryker on exactly those. With nothing in-scope changed it exits 0 with a
  message; `--list` prints the selection without running. `incremental: true` keeps repeat runs
  cheap by reusing prior results.
- **Local, one module (when reviewing a specific suite's strength):**
  `npx stryker run --mutate src/engine/<module>.ts`.
- **Full scope: CI only.** `npm run mutation:full` mutates the whole core scope and is run by
  the manual `Mutation Testing` workflow (`.github/workflows/mutation.yml`, `workflow_dispatch`
  trigger, report uploaded as an artifact). Never run `mutation:full` on a dev machine.

## How it is wired

- **`web/stryker.config.mjs`**: the Stryker config. `coverageAnalysis: 'perTest'` so each mutant
  only reruns the tests that cover it; `incremental: true`; `thresholds.break` is null so the
  run reports scores but never fails the command (a diagnostic, not a gate).
- **`web/vitest.stryker.config.ts`**: a trimmed Vitest config used only for mutation runs:
  `tests/engine/**` and `tests/stores/**` minus every spec that loads OpenCV.js through
  `tests/helpers/cv`.
- **`web/scripts/mutation-changed.mjs`**: the changed-files driver behind `npm run mutation`.
  It mirrors the mutate exclusions of `stryker.config.mjs`; keep the two lists in step.

## Scope and exclusions

`mutate` covers `src/engine/**/*.ts` minus, with reasons:

- `opencv.ts`, `imageData.ts`, `cvUtils.ts`: loader and IO glue around OpenCV.js, nothing
  measurement-shaped to mutate.
- `types.ts`, `**/types.ts`, `is/resultTypes.ts`: type-only modules.
- `overlayRenderer.ts`, `**/*OverlayRenderer.ts`: display-only output, not a measurement path.
- The OpenCV.js-dependent measurement stages (`ringDetector`, `cardEdgeMeasurer`,
  `couponAnalyzer`, `planeIdReader`, `subpixelEdge`, the `em`/`pa`/`is` fiducial aligners,
  `gapMeasurer`, `lineMeasurer`, `lineTracer`, `emAnalyzer`, `paAnalyzer`, `isAnalyzer`): their
  covering specs need the wasm module and are excluded from the mutation suite, so mutants
  there would only report "no coverage" noise.

Everything else in the engine (affine solving, grid mapping, robust statistics, scan combiners,
scale references, correction formatters, gcode generation, coupon geometry, resolution gate) is
mutated by default.

## Why the OpenCV.js specs are out (measured, not assumed)

The widened configuration was tried and measured on a fast dev machine: with the wasm-backed
specs included, Stryker's initial dry run alone took 13 minutes 48 seconds, and mutating the
single module `em/gapMeasurer.ts` (383 mutants, perTest coverage) projected to roughly 2.5
hours. Extrapolated over all CV stages, a full run would take days, which no timeout budget
accommodates. The pure suite by contrast runs 535 tests in under a minute, so full-scope runs
finish on CI and changed-files runs finish locally. The CV measurement math keeps its own
correctness gate outside Stryker: the render-recovery and fixture tests of CLAUDE.md rule 1.

To interrogate one CV module deliberately anyway (an overnight run): remove it from the
`mutate` exclusions in `stryker.config.mjs`, remove its covering specs from the `exclude` list
in `vitest.stryker.config.ts`, narrow with `--mutate` to that one module, and expect hours.
The real-scan fixture specs (`cardGoldenScale`, `pa/realScan`, `em/realScan`,
`backgroundPolarity`, `cardEdgeMeasurer`, `cardProportionality`) must stay excluded regardless:
their untracked fixtures are absent on most machines and Stryker's dry run fails without them.

## Reading the results

Read the survivors, not just the score: each surviving mutant is a concrete bug the suite would
miss. Kill it by strengthening an assertion (per the no-math rule: with an independent literal),
or accept it with a reason (an equivalent mutant, or a numeric-tolerance boundary the method's
noise floor genuinely cannot distinguish). Run a targeted pass on the touched module whenever a
review doubts a test's strength.
