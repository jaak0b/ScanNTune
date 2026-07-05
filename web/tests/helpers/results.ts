import type { AlignedResult } from '../../src/engine/types'

// A full AlignedResult for the pure combine/formatter tests that build results by hand. Pure (no
// OpenCV), so happy-dom unit tests can import it without pulling in the wasm loader.
export function alignedResult(over: Partial<AlignedResult> = {}): AlignedResult {
  return {
    rings: [],
    ringsDetected: 23,
    ringsExpected: 23,
    clippedSides: [],
    aligned: true,
    failureReason: null,
    orientation: { flipped: false, originX: 0, originY: 0, xAxisX: 1, xAxisY: 0 },
    plane: null,
    measuredPxPerMmX: 1,
    measuredPxPerMmY: 1,
    skewDegrees: 0,
    rmsResidualPx: 0,
    xScalePercent: 0,
    yScalePercent: 0,
    ...over,
  }
}
