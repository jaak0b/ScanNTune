import { configDefaults, defineConfig } from 'vitest/config'

// Vitest configuration used only by Stryker mutation runs (see stryker.config.mjs).
// It restricts the suite to the pure TypeScript engine and store tests. Every spec that loads
// OpenCV.js through tests/helpers/cv is excluded, for two measured reasons: with the wasm-backed
// specs included the initial dry run alone takes about 14 minutes and mutating a single CV
// module projects to roughly 2.5 hours, and several of those specs additionally depend on
// untracked real-scan fixtures that are absent locally and would fail Stryker's dry run
// outright. Component and composable tests are excluded because they exercise the Vue layer,
// not the mutated engine modules.
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['tests/engine/**/*.spec.ts', 'tests/stores/**/*.spec.ts'],
    exclude: [
      ...configDefaults.exclude,
      // OpenCV.js-backed specs (import tests/helpers/cv).
      'tests/engine/applyReference.spec.ts',
      'tests/engine/backgroundPolarity.spec.ts',
      'tests/engine/cardEdgeEsf.spec.ts',
      'tests/engine/cardEdgeMeasurer.spec.ts',
      'tests/engine/cardGoldenScale.spec.ts',
      'tests/engine/cardProportionality.spec.ts',
      'tests/engine/couponAnalyzerEndToEnd.spec.ts',
      'tests/engine/cvUtils.spec.ts',
      'tests/engine/diagnosticFailure.spec.ts',
      'tests/engine/flipInvariance.spec.ts',
      'tests/engine/maskCapture.spec.ts',
      'tests/engine/overlayRenderer.spec.ts',
      'tests/engine/planeId.spec.ts',
      'tests/engine/rotationInvariance.spec.ts',
      'tests/engine/scanCombinerFixture.spec.ts',
      'tests/engine/skewSignFixture.spec.ts',
      'tests/engine/em/emAnalyzer.spec.ts',
      'tests/engine/em/emOverlayRenderer.spec.ts',
      'tests/engine/em/fiducialAligner.spec.ts',
      'tests/engine/em/gapMeasurer.spec.ts',
      'tests/engine/em/realScan.spec.ts',
      'tests/engine/is/isAnalyzer.spec.ts',
      'tests/engine/is/isOverlayRenderer.spec.ts',
      'tests/engine/pa/fiducialAligner.spec.ts',
      'tests/engine/pa/lineMeasurer.spec.ts',
      'tests/engine/pa/paAnalyzer.spec.ts',
      'tests/engine/pa/paOverlayRenderer.spec.ts',
      'tests/engine/pa/realScan.spec.ts',
      'tests/engine/pa/smoothTime.spec.ts',
    ],
    testTimeout: 30000,
  },
})
