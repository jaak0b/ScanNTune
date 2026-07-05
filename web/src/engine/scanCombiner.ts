import type { AlignedResult, TwoScanResult } from './types'
import { xAxisAngleDegrees } from './types'

// Cancels the scanner's fixed geometric error by averaging two scans taken a quarter-turn apart.
// Both scans are reported in the coupon's own frame (the marker resolves the axes), so writing each
// measurement as printer + scanner:
//   A.X = pX + sX,  A.Y = pY + sY,   A.skew = pSkew + sSkew
//   B.X = pX + sY,  B.Y = pY + sX,   B.skew = pSkew - sSkew
// the average recovers the printer term (scanner cancels) and the half-difference recovers the
// scanner term. Only anisotropy and skew separate this way; the common isotropic scale still needs
// the DPI reference.

// How far from an exact 90 the turn may drift before the pair is flagged; at a turn error D the
// un-cancelled scanner fraction grows as sin(D), so 5 degrees bounds the leak below 9%.
export const QUARTER_TURN_TOLERANCE_DEGREES = 5.0

export function combineScans(scanA: AlignedResult, scanB: AlignedResult): TwoScanResult {
  const printerX = 0.5 * (scanA.xScalePercent + scanB.xScalePercent)
  const printerY = 0.5 * (scanA.yScalePercent + scanB.yScalePercent)
  const printerSkew = 0.5 * (scanA.skewDegrees + scanB.skewDegrees)

  // Two independent estimates of the scanner's X-vs-Y bias (from the X pair and the Y pair).
  const scannerAniso =
    0.5 * (scanA.xScalePercent - scanB.xScalePercent + (scanB.yScalePercent - scanA.yScalePercent))
  const scannerSkew = 0.5 * (scanA.skewDegrees - scanB.skewDegrees)

  const turned = turnBetween(
    xAxisAngleDegrees(scanA.orientation),
    xAxisAngleDegrees(scanB.orientation),
  )
  // The A/B skew algebra assumes both scans have the same handedness. If exactly one is mirror-
  // flipped, the scanner's skew ADDS instead of cancelling while the diagnostic reads ~0.
  const flipMismatch = scanA.orientation.flipped !== scanB.orientation.flipped
  const rotationValid = !flipMismatch && quarterTurnError(turned) <= QUARTER_TURN_TOLERANCE_DEGREES

  // Carry the detection of the weaker scan of the pair, so ringsDetected (the pair's worst tally)
  // always agrees with the rings array it travels with.
  const weaker = scanA.ringsDetected <= scanB.ringsDetected ? scanA : scanB
  const combined: AlignedResult = {
    rings: weaker.rings,
    ringsDetected: weaker.ringsDetected,
    ringsExpected: scanA.ringsExpected,
    clippedSides: [],
    aligned: true,
    failureReason: null,
    orientation: scanA.orientation,
    plane: scanA.plane,
    measuredPxPerMmX: 0.5 * (scanA.measuredPxPerMmX + scanB.measuredPxPerMmX),
    measuredPxPerMmY: 0.5 * (scanA.measuredPxPerMmY + scanB.measuredPxPerMmY),
    skewDegrees: printerSkew,
    rmsResidualPx: Math.max(scanA.rmsResidualPx, scanB.rmsResidualPx),
    xScalePercent: printerX,
    yScalePercent: printerY,
  }

  return {
    combined,
    scanner: { anisotropyPercent: scannerAniso, skewDegrees: scannerSkew },
    scanA,
    scanB,
    relativeRotationDegrees: turned,
    rotationLooksValid: rotationValid,
    flipMismatch,
  }
}

// Signed-free turn from A's +X to B's +X, folded into [0, 360).
export function turnBetween(angleADegrees: number, angleBDegrees: number): number {
  const diff = (angleBDegrees - angleADegrees) % 360.0
  return diff < 0 ? diff + 360.0 : diff
}

// Distance (degrees) from a turn to the nearest quarter-turn (90 or 270).
function quarterTurnError(turnedDegrees: number): number {
  return Math.min(Math.abs(turnedDegrees - 90.0), Math.abs(turnedDegrees - 270.0))
}
