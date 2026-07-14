import type { Mat, OpenCv } from './opencv'
import type { AlignedResult, AnalysisOptions, CalibrationResult, DetectedRing } from './types'
import { detectRingsOnBands } from './ringDetector'
import { GridMapError, mapGrid } from './gridMapper'
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
// Which binarisation shows the part is resolved by hypothesis testing: detection runs on every
// threshold-band hypothesis (value and, for color input, saturation bands) and each candidate ring
// set is validated against the coupon's grid and orientation marker. The first band whose rings
// map onto the grid wins; when none does, the result is unaligned and its failureReason says why.
//
// A scan that cannot be aligned (marker not found, too few rings) is NOT an error: it returns a result
// with the detection fields set and the measurement fields null, so the UI can show what was found and
// gate the Analyze button on it. Only a genuinely unreadable image throws (from the band sweep).

interface BandHypothesis {
  rings: DetectedRing[]
  /** The searched binary of this band (part white, morphologically closed). */
  mask: Mat
  mapping: GridMapping | null
  mapError: string | null
  /** How far the grid fit got: a GridMapError stage, or Infinity for a successful fit. */
  mapStage: number
}

export function analyzeCoupon(
  cv: OpenCv,
  image: Mat,
  options: AnalysisOptions,
  solverOptions?: AffineSolverOptions,
  maskOut?: { mask?: Mat },
): CalibrationResult {
  const gridN = options.coupon.gridN
  const ringsExpected = gridN * gridN - 2 // two vertices are the solid orientation markers, no hole

  // Every threshold band is a hypothesis; mapping its rings onto the coupon grid is the
  // validation. The sweep stops at the first band whose grid fit succeeds. Only the best attempt
  // so far keeps its full-frame mask (a beaten band's mask is freed the moment it is beaten, so a
  // 35 MP scan never holds one mask per band): the winner beats everything. Among failed bands,
  // model selection against the declared geometry ranks the report: the coupon cannot produce
  // more holes than it has ring vertices, so a hypothesis detecting more than ringsExpected is
  // known to contain noise and ranks below every physically consistent one (a noisy band can
  // shatter into hundreds of blob "rings" that would otherwise win any progress comparison).
  // Within the same consistency class the grid fit that progressed furthest (the deepest
  // GridMapError stage) wins, the same deepest-failure model the other flows apply to their band
  // sweeps; earlier bands win ties, preserving band order.
  let best: BandHypothesis | null = null
  let bandCount = 0
  try {
    detectRingsOnBands(
      cv,
      image,
      ({ rings, mask }) => {
        bandCount++
        let mapping: GridMapping | null = null
        let mapError: string | null = null
        let mapStage = Infinity // a successful fit outranks every failure stage
        try {
          mapping = mapGrid(rings, options.coupon)
        } catch (e) {
          mapError = e instanceof Error ? e.message : String(e)
          mapStage = e instanceof GridMapError ? e.stage : -1
        }
        const consistent = rings.length <= ringsExpected
        const bestConsistent = best !== null && best.rings.length <= ringsExpected
        const better =
          best === null ||
          mapping !== null ||
          (consistent !== bestConsistent ? consistent : mapStage > best.mapStage)
        if (better) {
          best?.mask.delete()
          best = { rings, mask, mapping, mapError, mapStage }
        } else {
          mask.delete()
        }
        return mapping !== null
      },
      (mapped) => mapped,
    )
  } catch (e) {
    const kept = best as BandHypothesis | null
    kept?.mask.delete()
    throw e
  }

  // Control-flow analysis does not track assignments made inside the sweep callback, so the
  // declared type is restated here.
  const chosen = best as BandHypothesis | null
  if (chosen === null || chosen.mapping === null) {
    // No band produced the coupon: a normal "couldn't align" outcome carrying the reason, not an
    // error. The hypothesis whose grid fit got furthest is shown so the overlay reflects the
    // best interpretation of the scan.
    const shownRings = chosen?.rings ?? []
    // Worded for a non-technical user; the per-band detail goes to the debug log below.
    const failureReason = alignmentFailureReason(shownRings.length, ringsExpected)
    console.debug(
      'coupon did not align:',
      failureReason,
      `best of ${bandCount} threshold-band hypotheses: ` +
        (chosen ? describe(chosen) : 'no band hypothesis was produced'),
    )
    handMask(maskOut, chosen?.mask)
    return {
      rings: shownRings,
      ringsDetected: shownRings.length,
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

  const mapping = chosen.mapping

  // The winning mask is still owned here until it is handed off, so a throw from the affine fit
  // or the plane-ID read must free it.
  let affine: ReturnType<typeof solveAffine>
  let plane: ReturnType<typeof readPlaneId>
  try {
    affine = solveAffine(mapping.points, solverOptions)
    // Read the plane-ID diagonals in the bottom-row cells from the winning band's binary (the
    // single binarisation the grid already validated). Non-fatal: a plate without them (the
    // original XY-only coupon) simply leaves the plane null.
    plane = readPlaneId(chosen.mask, options.coupon, affine)
  } catch (e) {
    chosen.mask.delete()
    throw e
  }
  handMask(maskOut, chosen.mask)

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

// The user-facing explanation for a scan whose best hypothesis did not fit the declared grid.
// Under-detection means the coupon's rings were not all seen; over-detection means the shown
// hypothesis contains more ring-like shapes than the declared coupon can produce, so the scan
// could not be told apart from its background. Exported so tests can pin both wordings.
export function alignmentFailureReason(ringsDetected: number, ringsExpected: number): string {
  if (ringsDetected > ringsExpected) {
    return (
      `The coupon could not be told apart from the background: ${ringsDetected} ring-like ` +
      `shapes were detected where the coupon has only ${ringsExpected} measurement rings. ` +
      'Scan it again on a plain, single-colour background.'
    )
  }
  return (
    `The coupon pattern was not found: only ${ringsDetected} of its ${ringsExpected} ` +
    'measurement rings were detected. Make sure the whole coupon lies inside the scan area ' +
    'on a plain, single-colour background, then scan again.'
  )
}

// One line of "what this hypothesis saw" for the debug log behind a failed alignment.
function describe(h: BandHypothesis): string {
  return `${h.rings.length} ring candidates; ${h.mapError ?? 'grid fit succeeded'}`
}

// Hand the reported hypothesis's searched mask to the caller (who then owns it), or free it when
// the caller did not ask for the mask.
function handMask(maskOut: { mask?: Mat } | undefined, mask: Mat | undefined): void {
  if (maskOut && mask) maskOut.mask = mask
  else mask?.delete()
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
