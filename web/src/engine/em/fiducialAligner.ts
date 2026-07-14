import type { Mat, OpenCv } from '../opencv'
import type { EmTestSpec } from './types'
import { emCouponGeometry, pitchForBlock } from './types'
import { analyzeThresholdBands, deepestFailure } from '../cvUtils'
import { selectCornerHoles, solveFromCornerHoles } from '../cornerFiducialSolver'
import type { Point } from '../cornerFiducialSolver'
import { locatePlateFiducialHoles } from '../plateFiducialLocator'

// Locates the EM coupon's three square fiducial holes in a scan and solves the exactly-determined
// affine mapping coupon-frame millimetres to scan pixels, mirroring the PA fiducial aligner. The
// coupon plate is found as the largest external contour of an Otsu threshold-band binary (every
// band hypothesis is tried and validated against the known geometry); the fiducials are its hole
// contours (RETR_CCOMP children) of the expected size and square shape. The hole layout leaves the
// origin corner empty, so the corner-adjacent hole (the one seeing the other two at a right angle)
// anchors the correspondence, and the cross-product sign of its two neighbour vectors, compared
// with the nominal layout's sign, resolves a mirror flip with no manual input.

export interface EmAlignment {
  success: boolean
  failureReason: string | null
  /** Maps coupon-frame mm to scan px: px = A * mm + t. Null when alignment failed. */
  affine: { a: number; b: number; c: number; d: number; tx: number; ty: number } | null
  flipped: boolean
  rotationQuarterTurns: number
  /** Signed rotation of the coupon +X axis in scan space, in degrees, normalized to
   *  (-180, 180]; includes the quarter-turn part. 0 when alignment failed. */
  rotationDegrees: number
}

export function alignEmCoupon(cv: OpenCv, imageBgr: Mat, spec: EmTestSpec): EmAlignment {
  if (!imageBgr || imageBgr.empty()) throw new Error('Image is null or empty.')
  const geometry = emCouponGeometry(spec)

  // The scan is a multi-population scene (dark plastic, mid-tone scanner background showing
  // through the comb slots and holes, a possibly bright lid margin), so no single threshold is
  // guaranteed to isolate the plate. Every threshold-band hypothesis is tried and validated
  // against the known geometry; the first that yields the three-hole corner pattern wins.
  const attempts = analyzeThresholdBands(
    cv,
    imageBgr,
    (objectWhite) => tryAlign(cv, objectWhite, spec, geometry),
    (r) => r.success,
  )
  const aligned = attempts.find((r) => r.success)
  if (aligned) return stripStage(aligned)
  // No hypothesis fits; report the failure from the band hypothesis that got furthest through
  // the pipeline, as its reason is the more actionable one for the user.
  const best = deepestFailure(attempts, (r) => r.stage)
  return stripStage(best ?? fail('No coupon was found in the scan.', 0))
}

/** EmAlignment plus how far through the alignment pipeline the attempt progressed (higher
 *  means further: plate found, shape ok, holes selected, affine solved). */
type AlignAttempt = EmAlignment & { stage: number }

function stripStage(attempt: AlignAttempt): EmAlignment {
  const { stage: _stage, ...alignment } = attempt
  return alignment
}

export function mmToPx(alignment: EmAlignment, xMm: number, yMm: number): { x: number; y: number } {
  const A = alignment.affine
  if (!A) throw new Error('The alignment did not succeed, so there is no coupon-to-scan mapping.')
  return { x: A.a * xMm + A.b * yMm + A.tx, y: A.c * xMm + A.d * yMm + A.ty }
}

// A failed attempt records how far it got, so the deepest failure across all band hypotheses
// can be picked for reporting.
function fail(reason: string, stage: number): AlignAttempt {
  return {
    success: false,
    failureReason: reason,
    affine: null,
    flipped: false,
    rotationQuarterTurns: 0,
    rotationDegrees: 0,
    stage,
  }
}

// One alignment attempt on one threshold band's binary (coupon plate assumed white).
function tryAlign(
  cv: OpenCv,
  objectWhite: Mat,
  spec: EmTestSpec,
  g: ReturnType<typeof emCouponGeometry>,
): AlignAttempt {
  // The comb slots and block separators are also background-toned openings in this binary, so
  // the locator morphologically closes it with a kernel wider than the coupon's widest comb gap
  // (the widest pitch minus half a nominal bead on each side) but well under the fiducial hole
  // size: the slots vanish, the 5 mm holes survive with their centroids unchanged.
  const maxGapMm = pitchForBlock(spec, spec.blockCount - 1) - 0.5 * spec.nominalLineWidthMm
  const located = locatePlateFiducialHoles(cv, objectWhite, {
    plateWidthMm: g.couponWidthMm,
    plateHeightMm: g.couponHeightMm,
    fiducialSizeMm: g.fiducialSizeMm,
    holeAreaBand: { min: 0.4, max: 2.5 },
    closeKernelMm: maxGapMm,
  })
  if (!located.ok) return fail(located.reason, located.stage)

  // A plate-backed scan shows the plate's speckle through the comb gaps, so hole-like blobs
  // beyond the three fiducials survive the per-hole gates; the fiducial triple is selected
  // by its mutual geometry.
  const selected = selectCornerHoles(located.holes, g.fiducials, located.estimatedPxPerMm)
  if (!selected.ok) return fail(selected.reason, 2)

  return solveFromHoles(selected.holes, g)
}

// Identifies the corner-adjacent hole, resolves the mirror flip and the neighbour correspondence,
// and solves the exact 3-point affine. The math lives in the shared corner-fiducial solver;
// the nominal layout order (fiducials[1] corner-adjacent, [0] and [2] its neighbours) is derived
// from emCouponGeometry, not assumed.
function solveFromHoles(holes: Point[], g: ReturnType<typeof emCouponGeometry>): AlignAttempt {
  const solved = solveFromCornerHoles(holes, g.fiducials)
  if (!solved.ok) return fail(solved.reason, 3)
  return {
    success: true,
    failureReason: null,
    affine: solved.affine,
    flipped: solved.flipped,
    rotationQuarterTurns: solved.rotationQuarterTurns,
    rotationDegrees: solved.rotationDegrees,
    stage: 4,
  }
}
