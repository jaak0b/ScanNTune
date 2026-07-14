import type { Mat, OpenCv } from '../opencv'
import type { PaTestSpec } from './types'
import { couponGeometry } from './types'
import { analyzeThresholdBands, deepestFailure } from '../cvUtils'
import { selectCornerHoles, solveFromCornerHoles } from '../cornerFiducialSolver'
import { locatePlateFiducialHoles } from '../plateFiducialLocator'

// Locates the PA coupon's three square corner-hole fiducials in a scan and solves the
// exactly-determined affine mapping coupon-frame millimetres to scan pixels. The coupon base is
// found as the largest external contour of an Otsu binary (both polarities are tried and validated
// against the known geometry); the fiducials are its hole contours (RETR_CCOMP children) of the
// expected size and square shape. The hole layout deliberately leaves the origin corner empty, so
// the corner-adjacent hole (the one seeing the other two at a right angle) anchors the
// correspondence, and the cross-product sign of its two neighbour vectors, compared with the
// nominal layout's sign, resolves a mirror flip with no manual input.

export interface PaAlignment {
  success: boolean
  failureReason: string | null
  /** Maps coupon-frame mm to scan px: px = A * mm + t. */
  a: number
  b: number
  c: number
  d: number
  tx: number
  ty: number
  flipped: boolean
  rotationQuarterTurns: number
  /** Signed rotation of the coupon +X axis in scan space, in degrees, normalized to
   *  (-180, 180]; includes the quarter-turn part. 0 when alignment failed. */
  rotationDegrees: number
}

interface Point {
  x: number
  y: number
}

export function alignPaCoupon(cv: OpenCv, image: Mat, spec: PaTestSpec): PaAlignment {
  if (!image || image.empty()) throw new Error('Image is null or empty.')
  const geometry = couponGeometry(spec)

  // A coupon scan is a three-population scene (dark test lines, mid-tone scanner background
  // showing through the holes, light base), so no single threshold isolates the base. Every
  // threshold-band hypothesis is tried and validated against the known geometry; the first that
  // yields the three-hole corner pattern wins.
  const attempts = analyzeThresholdBands(
    cv,
    image,
    (objectWhite) => tryAlign(cv, objectWhite, geometry),
    (r) => r.success,
  )
  const aligned = attempts.find((r) => r.success)
  if (aligned) return stripStage(aligned)
  // No hypothesis fits; report the failure from the band hypothesis that got furthest through
  // the pipeline, as its reason is the more actionable one for the user.
  const best = deepestFailure(attempts, (r) => r.stage)
  return stripStage(best ?? fail('No coupon was found in the scan.', 0))
}

/** PaAlignment plus how far through the alignment pipeline the attempt progressed (higher
 *  means further: base found, shape ok, holes selected, affine solved). */
type AlignAttempt = PaAlignment & { stage: number }

function stripStage(attempt: AlignAttempt): PaAlignment {
  const { stage: _stage, ...alignment } = attempt
  return alignment
}

export function mmToPx(al: PaAlignment, xMm: number, yMm: number): { x: number; y: number } {
  return { x: al.a * xMm + al.b * yMm + al.tx, y: al.c * xMm + al.d * yMm + al.ty }
}

// A failed attempt records how far it got, so the deepest failure across all band hypotheses
// can be picked for reporting.
function fail(reason: string, stage: number): AlignAttempt {
  return {
    success: false,
    failureReason: reason,
    stage,
    a: 0,
    b: 0,
    c: 0,
    d: 0,
    tx: 0,
    ty: 0,
    flipped: false,
    rotationQuarterTurns: 0,
    rotationDegrees: 0,
  }
}

// One alignment attempt on one polarity's binary (coupon base assumed white).
function tryAlign(
  cv: OpenCv,
  objectWhite: Mat,
  g: ReturnType<typeof couponGeometry>,
): AlignAttempt {
  // The printed test lines are also dark regions in this binary and can touch a hole, merging
  // the two into one contour, so the locator morphologically closes it with a kernel wider than
  // any test line but half the hole size: the lines vanish, the holes survive (their centroids
  // are unchanged by the symmetric erosion of the closing).
  const located = locatePlateFiducialHoles(cv, objectWhite, {
    plateWidthMm: g.baseWidthMm,
    plateHeightMm: g.baseHeightMm,
    fiducialSizeMm: g.fiducialSizeMm,
    holeAreaBand: { min: 1 / 3, max: 3 },
    closeKernelMm: g.fiducialSizeMm / 2,
  })
  if (!located.ok) return fail(located.reason, located.stage)

  // A plate-backed scan shows the plate's speckle through the openings, so hole-like blobs
  // beyond the three fiducials survive the per-hole gates; the fiducial triple is selected
  // by its mutual geometry.
  const selected = selectCornerHoles(located.holes, g.fiducials, located.estimatedPxPerMm)
  if (!selected.ok) return fail(selected.reason, 2)

  return solveFromHoles(selected.holes, g)
}

// Solves orientation and the exact 3-point affine from the detected holes via the shared
// corner-fiducial solver; the PA layout puts the corner-adjacent hole at fiducials[1] with
// fiducials[0] and fiducials[2] as its neighbours (derived from couponGeometry, not assumed).
function solveFromHoles(holes: Point[], g: ReturnType<typeof couponGeometry>): AlignAttempt {
  const solved = solveFromCornerHoles(holes, g.fiducials)
  if (!solved.ok) return fail(solved.reason, 3)
  return {
    success: true,
    failureReason: null,
    ...solved.affine,
    flipped: solved.flipped,
    rotationQuarterTurns: solved.rotationQuarterTurns,
    rotationDegrees: solved.rotationDegrees,
    stage: 4,
  }
}
