// Stryker mutation testing configuration.
//   npm run mutation       mutates only engine files changed relative to master (local use)
//   npm run mutation:full  mutates the full core scope below (CI only, workflow_dispatch)
// Mutation runs execute the trimmed suite in vitest.stryker.config.ts: the pure TypeScript
// engine and store tests, without the OpenCV.js-backed specs. The mutate list therefore
// excludes, with reasons:
//   - loader/IO glue (opencv.ts, imageData.ts, cvUtils.ts): thin OpenCV.js plumbing,
//   - type-only modules: nothing behavioral to mutate,
//   - overlay renderers: display-only output, not measurement,
//   - the OpenCV.js-dependent measurement stages (ring/edge/line/gap detection, fiducial
//     aligners, analyzers over cv mats): their covering specs need the wasm module, measured
//     at about 14 minutes for the dry run alone and a projected 2.5 hours to mutate one such
//     module, so mutants there would only report "no coverage" noise. Deliberately widening
//     onto one of these modules is documented in the skill reference below.
// See .claude/skills/writing-unittests/references/mutation-testing.md for the workflow.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.stryker.config.ts' },
  coverageAnalysis: 'perTest',
  incremental: true,
  // Generous headroom for the initial test run on slower CI machines (the default is 5 minutes).
  dryRunTimeoutMinutes: 20,
  mutate: [
    'src/engine/**/*.ts',
    '!src/engine/opencv.ts',
    '!src/engine/imageData.ts',
    '!src/engine/cvUtils.ts',
    '!src/engine/types.ts',
    '!src/engine/**/types.ts',
    '!src/engine/is/resultTypes.ts',
    '!src/engine/overlayRenderer.ts',
    '!src/engine/**/*OverlayRenderer.ts',
    '!src/engine/ringDetector.ts',
    '!src/engine/cardEdgeMeasurer.ts',
    '!src/engine/couponAnalyzer.ts',
    '!src/engine/planeIdReader.ts',
    '!src/engine/subpixelEdge.ts',
    '!src/engine/em/emAnalyzer.ts',
    '!src/engine/em/fiducialAligner.ts',
    '!src/engine/em/gapMeasurer.ts',
    '!src/engine/pa/fiducialAligner.ts',
    '!src/engine/pa/lineMeasurer.ts',
    '!src/engine/pa/paAnalyzer.ts',
    '!src/engine/is/isAnalyzer.ts',
    '!src/engine/is/isFiducialAligner.ts',
    '!src/engine/is/lineTracer.ts',
  ],
  reporters: ['html', 'clear-text', 'progress'],
  thresholds: { high: 80, low: 60, break: null },
  tempDirName: '.stryker-tmp',
}
export default config
