import type { Mat, OpenCv } from './opencv'
import type { AlignedResult, AnalysisOptions, CalibrationResult, DetectedRing } from './types'
import { detectRingsDual } from './ringDetector'
import type { RingPolarity } from './ringDetector'
import { mapGrid } from './gridMapper'
import type { GridMapping } from './types'
import { solveAffine } from './affineSolver'
import type { AffineSolverOptions } from './affineSolver'
import { readPlaneId } from './planeIdReader'
import { clippedSides } from './scanDiagnostics'
import { isUsableReference, referenceAlongDirection } from './scannerCalibration'
import type { ScaleReference } from './scannerCalibration'

// Orchestrates the pipeline: detect ring centres -> locate the orientation fiducial and map rings to
// the nominal grid -> fit the affine -> convert scale/skew into a calibration result. Orientation
// (rotation AND flip) is fully resolved from the two-solid marker, so the X/Y labels and the skew
// sign are already correct.
//
// The threshold polarity (part brighter or darker than what's behind it) is resolved by hypothesis
// testing: detection runs under both polarities and each candidate set is validated against the
// coupon's grid and orientation marker. Exactly one fitting is the normal case; none (or both, which
// no physical scan produces) yields an unaligned result whose failureReason says why.
//
// A scan that cannot be aligned (marker not found, too few rings) is NOT an error: it returns a result
// with the detection fields set and the measurement fields null, so the UI can show what was found and
// gate the Analyze button on it. Only a genuinely unreadable image throws (from detectRingsDual).

interface PolarityHypothesis {
  polarity: RingPolarity
  rings: DetectedRing[]
  mapping: GridMapping | null
  mapError: string | null
}

export function analyzeCoupon(
  cv: OpenCv,
  image: Mat,
  options: AnalysisOptions,
  solverOptions?: AffineSolverOptions,
  maskOut?: { mask?: Mat },
): CalibrationResult {
  const masks: { bright?: Mat; dark?: Mat } | undefined = maskOut ? {} : undefined
  const detected = detectRingsDual(cv, image, undefined, undefined, masks)
  const gridN = options.coupon.gridN
  const ringsExpected = gridN * gridN - 2 // two vertices are the solid orientation markers, no hole

  const hypotheses: PolarityHypothesis[] = (['bright', 'dark'] as const).map((polarity) => {
    const rings = detected[polarity]
    try {
      return { polarity, rings, mapping: mapGrid(rings, options.coupon), mapError: null }
    } catch (e) {
      return { polarity, rings, mapping: null, mapError: e instanceof Error ? e.message : String(e) }
    }
  })
  const fitting = hypotheses.filter(
    (h): h is PolarityHypothesis & { mapping: GridMapping } => h.mapping !== null,
  )

  if (fitting.length !== 1) {
    // Neither polarity produced the coupon (or, physically implausibly, both did): a normal
    // "couldn't align" outcome carrying the reason, not an error. Show the hypothesis that found
    // more rings so the overlay reflects the best interpretation of the scan.
    const shown = hypotheses.reduce((a, b) => (b.rings.length > a.rings.length ? b : a))
    // Worded for a non-technical user; the per-polarity detail goes to the debug log below.
    const failureReason =
      fitting.length === 0
        ? `The coupon pattern was not found: only ${shown.rings.length} of its ${ringsExpected} ` +
          'measurement rings were detected. Make sure the whole coupon lies inside the scan area ' +
          'on a plain, single-colour background, then scan again.'
        : 'The coupon could not be told apart from the background. Scan it again on a plain, ' +
          'single-colour background.'
    console.debug(
      'coupon did not align:',
      failureReason,
      `bright hypothesis: ${describe(hypotheses[0])}`,
      `dark hypothesis: ${describe(hypotheses[1])}`,
    )
    keepMask(maskOut, masks, shown.polarity)
    return {
      rings: shown.rings,
      ringsDetected: shown.rings.length,
      ringsExpected,
      // Without a fitted grid there is no model to project missing holes through, so no clipping
      // claim is made; the failureReason already tells the user to check the coupon placement.
      clippedSides: [],
      aligned: false,
      failureReason,
      orientation: null,
      plane: null,
      measuredPxPerMmX: null,
      measuredPxPerMmY: null,
      skewDegrees: null,
      rmsResidualPx: null,
      xScalePercent: null,
      yScalePercent: null,
    }
  }

  const chosen = fitting[0]
  const mapping = chosen.mapping
  keepMask(maskOut, masks, chosen.polarity)

  const affine = solveAffine(mapping.points, solverOptions)

  // Read the plane-ID diagonals in the bottom-row cells. Non-fatal: a plate without them (the
  // original XY-only coupon) simply leaves the plane null.
  const plane = readPlaneId(cv, image, options.coupon, affine, chosen.polarity === 'bright')

  const base: UnpricedResult = {
    rings: chosen.rings,
    ringsDetected: chosen.rings.length,
    ringsExpected,
    // mapGrid tolerates one stray missed hole, so an aligned scan can still be missing a ring; the
    // fitted grid says exactly where it should have been, so clipping is diagnosed from the model.
    clippedSides: clippedSides(options.coupon, mapping.points, affine, image.cols, image.rows),
    aligned: true,
    failureReason: null,
    orientation: {
      flipped: mapping.flipped,
      originX: mapping.originX,
      originY: mapping.originY,
      xAxisX: mapping.xAxisX,
      xAxisY: mapping.xAxisY,
    },
    plane,
    measuredPxPerMmX: affine.scaleXPxPerMm,
    measuredPxPerMmY: affine.scaleYPxPerMm,
    skewDegrees: affine.skewDegrees,
    rmsResidualPx: affine.rmsResidualPx,
  }
  return applyReference(base, options.pxPerMm ?? null)
}

// One line of "what this hypothesis saw" for the failure reason shown to the user.
function describe(h: PolarityHypothesis): string {
  return `${h.rings.length} ring candidates; ${h.mapError ?? 'grid fit succeeded'}`
}

// Hand the searched mask of the reported polarity to the caller (who owns it) and free the other.
function keepMask(
  maskOut: { mask?: Mat } | undefined,
  masks: { bright?: Mat; dark?: Mat } | undefined,
  polarity: RingPolarity,
): void {
  if (!maskOut || !masks) return
  const keep = masks[polarity]
  const drop = masks[polarity === 'bright' ? 'dark' : 'bright']
  drop?.delete()
  if (keep) maskOut.mask = keep
}

/** An aligned measurement before the reference prices its scale percentages. */
export type UnpricedResult = Omit<AlignedResult, 'xScalePercent' | 'yScalePercent'>

// Converts the measured px/mm along each axis into a percentage scale error against a reference.
// With a known reference (scanner DPI or a card measurement) the errors are absolute; without one,
// the geometric mean of the two axes is the reference, so only anisotropy survives. A per-axis
// (CCD) reference is fixed to the glass while the coupon lies at an arbitrary angle, so each coupon
// axis is priced against the reference's effective px/mm along that axis's image direction. Kept
// separate so the per-scan pass can defer it: detection and the affine are reference-independent,
// so changing the DPI reprices the result without re-running any CV.
export function applyReference(result: UnpricedResult, reference: ScaleReference | null): AlignedResult {
  if (reference !== null && !isUsableReference(reference))
    throw new Error(`The px/mm reference must be positive, got ${JSON.stringify(reference)}.`)
  let referenceX: number
  let referenceY: number
  if (reference === null) {
    referenceX = referenceY = Math.sqrt(result.measuredPxPerMmX * result.measuredPxPerMmY)
  } else {
    const o = result.orientation
    // The coupon's +Y image direction is the perpendicular of +X; the sign (flip) does not change
    // the effective px/mm along the axis, so no flip handling is needed here.
    referenceX = referenceAlongDirection(reference, o.xAxisX, o.xAxisY)
    referenceY = referenceAlongDirection(reference, -o.xAxisY, o.xAxisX)
  }
  return {
    ...result,
    xScalePercent: (result.measuredPxPerMmX / referenceX - 1.0) * 100.0,
    yScalePercent: (result.measuredPxPerMmY / referenceY - 1.0) * 100.0,
  }
}
