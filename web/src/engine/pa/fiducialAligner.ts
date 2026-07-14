import type { Mat, OpenCv } from '../opencv'
import type { PaTestSpec } from './types'
import { couponGeometry } from './types'
import { analyzeThresholdBands, deepestFailure, majorityFilterBinary, roiAround } from '../cvUtils'
import { rotationDegreesFromAffine, selectCornerHoles } from '../cornerFiducialSolver'
import { MIN_ALIGN_PX_PER_MM } from '../resolutionGate'

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
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  try {
    cv.findContours(objectWhite, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

    // The base plate: the largest external contour. Holes are read later by a
    // separate CCOMP pass on the cropped plate region.
    const count = contours.size()
    let baseIndex = -1
    let baseArea = 0
    for (let i = 0; i < count; i++) {
      const contour = contours.get(i)
      try {
        const area = cv.contourArea(contour)
        if (area > baseArea) {
          baseArea = area
          baseIndex = i
        }
      } finally {
        contour.delete()
      }
    }
    const nominalBaseAreaMm2 = g.baseWidthMm * g.baseHeightMm
    // Sanity floor, not a tuned constant: any scanner above ~26 dpi (1 px/mm) exceeds this.
    const minBasePx = nominalBaseAreaMm2 * MIN_ALIGN_PX_PER_MM * MIN_ALIGN_PX_PER_MM
    if (baseIndex < 0 || baseArea < minBasePx) {
      return fail(
        'No coupon was found in the scan. Place the printed coupon flat on the scanner glass so the whole plate is visible.',
        0,
      )
    }

    // Aspect-ratio gate: the largest blob must be shaped like the coupon base.
    const baseContour = contours.get(baseIndex)
    let baseLong: number
    let baseShort: number
    let baseRect: { x: number; y: number; width: number; height: number }
    try {
      const rect = cv.minAreaRect(baseContour)
      baseLong = Math.max(rect.size.width, rect.size.height)
      baseShort = Math.min(rect.size.width, rect.size.height)
      baseRect = cv.boundingRect(baseContour)
    } finally {
      baseContour.delete()
    }
    const nominalLong = Math.max(g.baseWidthMm, g.baseHeightMm)
    const nominalShort = Math.min(g.baseWidthMm, g.baseHeightMm)
    if (
      baseShort <= 0 ||
      Math.abs(baseLong / baseShort - nominalLong / nominalShort) / (nominalLong / nominalShort) >
        0.1
    ) {
      return fail(
        'The largest object in the scan does not match the coupon plate shape. Remove other objects from the glass and rescan.',
        1,
      )
    }

    // Fiducial holes: children of the base contour with the expected area and a square shape.
    // The printed test lines are also dark regions in this binary and can touch a hole, merging
    // the two into one contour, so the binary is first morphologically closed with a kernel wider
    // than any test line but half the hole size: the lines vanish, the holes survive (their
    // centroids are unchanged by the symmetric erosion of the closing).
    const estimatedPxPerMm = Math.sqrt(baseArea / nominalBaseAreaMm2)
    const expectedHoleAreaPx = (g.fiducialSizeMm * estimatedPxPerMm) ** 2
    const kernelPx = Math.max(3, Math.round((g.fiducialSizeMm / 2) * estimatedPxPerMm))
    // A coupon scanned on its textured build plate shows the plate's speckle through every
    // opening, littering the binary with noise blobs; a majority filter well under the fiducial
    // size removes them without moving the surviving centroids. The holes lie strictly inside
    // the base, so the denoise/close/contour stage runs on the base's bounding rectangle plus
    // a kernel-sized margin instead of the full scan (identical results, a fraction of the
    // cost); the crop origin is added back onto every hole centroid.
    const denoiseKernelPx = (g.fiducialSizeMm / 5) * estimatedPxPerMm
    const cropped = roiAround(cv, objectWhite, baseRect, Math.max(kernelPx, denoiseKernelPx))
    let denoised: Mat
    try {
      denoised = majorityFilterBinary(cv, cropped.roi, denoiseKernelPx)
    } finally {
      cropped.roi.delete()
    }
    const closed = new cv.Mat()
    const holeContours = new cv.MatVector()
    const holeHierarchy = new cv.Mat()
    try {
      // A rectangular kernel: rectangular morphology runs via the separable van Herk/Gil-Werman
      // algorithm, O(N) regardless of kernel size (an elliptical kernel of this width costs
      // kernel-area per pixel and takes minutes on a 35 MP scan). The closing's job, erasing test
      // lines narrower than the kernel while preserving the fiducial holes and their centroids, is
      // shape-independent for a symmetric kernel.
      const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kernelPx, kernelPx))
      cv.morphologyEx(denoised, closed, cv.MORPH_CLOSE, kernel)
      kernel.delete()
      cv.findContours(closed, holeContours, holeHierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE)

      // Re-locate the base in the closed binary (indices differ from the first pass).
      const holeCount = holeContours.size()
      let closedBaseIndex = -1
      let closedBaseArea = 0
      for (let i = 0; i < holeCount; i++) {
        if (holeHierarchy.data32S[i * 4 + 3] !== -1) continue
        const contour = holeContours.get(i)
        try {
          const area = cv.contourArea(contour)
          if (area > closedBaseArea) {
            closedBaseArea = area
            closedBaseIndex = i
          }
        } finally {
          contour.delete()
        }
      }

      const holes: Point[] = []
      for (let i = 0; i < holeCount; i++) {
        if (holeHierarchy.data32S[i * 4 + 3] !== closedBaseIndex) continue // not a hole in the base
        const contour = holeContours.get(i)
        try {
          const area = cv.contourArea(contour)
          if (area < expectedHoleAreaPx / 3 || area > expectedHoleAreaPx * 3) continue
          // A fiducial is square, so its minimum-area rectangle is not elongated.
          const rect = cv.minAreaRect(contour)
          const long = Math.max(rect.size.width, rect.size.height)
          const short = Math.min(rect.size.width, rect.size.height)
          if (short <= 0 || long / short > 2) continue
          const m = cv.moments(contour)
          if (m.m00 <= 0) continue
          holes.push({ x: m.m10 / m.m00 + cropped.x, y: m.m01 / m.m00 + cropped.y })
        } finally {
          contour.delete()
        }
      }
      // A plate-backed scan shows the plate's speckle through the openings, so hole-like blobs
      // beyond the three fiducials survive the per-hole gates; the fiducial triple is selected
      // by its mutual geometry.
      const selected = selectCornerHoles(holes, g.fiducials, estimatedPxPerMm)
      if (!selected.ok) return fail(selected.reason, 2)

      return solveFromHoles(selected.holes, g)
    } finally {
      denoised.delete()
      closed.delete()
      holeContours.delete()
      holeHierarchy.delete()
    }
  } finally {
    contours.delete()
    hierarchy.delete()
  }
}

// Identifies the corner-adjacent hole, resolves the mirror flip and the neighbour correspondence,
// and solves the exact 3-point affine.
function solveFromHoles(holes: Point[], g: ReturnType<typeof couponGeometry>): AlignAttempt {
  // The corner-adjacent hole sees the other two at a right angle: pick the hole whose neighbour
  // vectors have the cosine closest to zero.
  let cornerIdx = -1
  let bestCos = Infinity
  for (let i = 0; i < 3; i++) {
    const u = sub(holes[(i + 1) % 3], holes[i])
    const v = sub(holes[(i + 2) % 3], holes[i])
    const lu = Math.hypot(u.x, u.y)
    const lv = Math.hypot(v.x, v.y)
    if (lu < 1 || lv < 1) return fail('The detected coupon holes overlap; the scan is unreadable. Rescan at a higher resolution.', 3)
    const cos = Math.abs((u.x * v.x + u.y * v.y) / (lu * lv))
    if (cos < bestCos) {
      bestCos = cos
      cornerIdx = i
    }
  }
  if (bestCos > 0.2) {
    return fail(
      'The three detected holes do not form the coupon corner pattern. Check for debris or reflections on the scan and try again.',
      3,
    )
  }

  // Nominal layout: fiducials[1] is the corner-adjacent hole, with fiducials[0] and fiducials[2]
  // as its neighbours (derived from couponGeometry, not assumed).
  const nCorner = g.fiducials[1]
  const nA = g.fiducials[0]
  const nB = g.fiducials[2]
  const lenNA = Math.hypot(nA.xMm - nCorner.xMm, nA.yMm - nCorner.yMm)
  const lenNB = Math.hypot(nB.xMm - nCorner.xMm, nB.yMm - nCorner.yMm)

  const corner = holes[cornerIdx]
  const p = holes[(cornerIdx + 1) % 3]
  const q = holes[(cornerIdx + 2) % 3]
  const lenP = Math.hypot(p.x - corner.x, p.y - corner.y)
  const lenQ = Math.hypot(q.x - corner.x, q.y - corner.y)

  // Ambiguity gate: the two candidate correspondences are only distinguishable at all because
  // the nominal arm lengths differ (the assignment is chosen by comparing per-arm px/mm scales
  // against lenNA and lenNB). If the coupon spec makes the nominal arms nearly equal, both
  // candidates fit any scan almost equally well, so the choice is a coin flip baked into the
  // coupon's geometry, not something a better scan could resolve: refuse rather than silently
  // guess. The threshold is derived purely from the nominal geometry (never a magic constant
  // fitted to a scan): a quarter of the observed measurement-noise floor implied by the fiducial
  // detection tolerance used elsewhere (the anisotropy gate's 10%) is used as the minimum
  // separation the nominal arm-length ratio must clear.
  const nominalArmRatioDiff = Math.abs(lenNA - lenNB) / Math.max(lenNA, lenNB)
  if (nominalArmRatioDiff < 0.25 * 0.1) {
    return fail(
      "The coupon's two fiducial arms are too similar in length to orient the scan reliably. Use a coupon spec with distinct fiducial arm lengths.",
      3,
    )
  }

  // Correspondence: assign the detected neighbours so the per-arm px/mm scales agree best.
  const mismatch = (l1: number, l2: number) => Math.abs(l1 / lenNA - l2 / lenNB)
  const [dA, dB] = mismatch(lenP, lenQ) <= mismatch(lenQ, lenP) ? [p, q] : [q, p]

  // Anisotropy gate: the two arms must imply consistent scales.
  const sA = Math.hypot(dA.x - corner.x, dA.y - corner.y) / lenNA
  const sB = Math.hypot(dB.x - corner.x, dB.y - corner.y) / lenNB
  if (Math.abs(sA / sB - 1) > 0.1) {
    return fail(
      'The detected holes do not match the coupon proportions. The scan may show a different object or a distorted coupon.',
      3,
    )
  }

  // Mirror flip: the cross-product sign of the corner's neighbour vectors, compared between the
  // nominal layout and the detection. A rotation preserves the sign; a flip inverts it.
  const nominalCross =
    (nA.xMm - nCorner.xMm) * (nB.yMm - nCorner.yMm) - (nA.yMm - nCorner.yMm) * (nB.xMm - nCorner.xMm)
  const detectedCross = (dA.x - corner.x) * (dB.y - corner.y) - (dA.y - corner.y) * (dB.x - corner.x)
  if (nominalCross === 0 || detectedCross === 0) {
    return fail('The detected coupon holes are collinear, so the coupon orientation could not be determined.', 3)
  }
  const flipped = Math.sign(detectedCross) !== Math.sign(nominalCross)

  const affine = solveAffine(
    [nCorner, nA, nB].map((f) => ({ x: f.xMm, y: f.yMm })),
    [corner, dA, dB],
  )
  if (!affine) {
    return fail('The detected coupon holes are collinear, so the coupon orientation could not be determined.', 3)
  }

  // Diagnostic rotation of the coupon's +X axis: the exact angle and its quarter-turn estimate.
  const angle = Math.atan2(affine.c, affine.a)
  const rotationQuarterTurns = ((Math.round(angle / (Math.PI / 2)) % 4) + 4) % 4

  return {
    success: true,
    failureReason: null,
    ...affine,
    flipped,
    rotationQuarterTurns,
    rotationDegrees: rotationDegreesFromAffine(affine),
    stage: 4,
  }
}

function sub(p: Point, q: Point): Point {
  return { x: p.x - q.x, y: p.y - q.y }
}

// The exactly-determined affine from 3 point correspondences (mm -> px), via Cramer's rule on the
// 3x3 system with rows (x_i, y_i, 1); one solve each for the x' and y' components. Returns null
// when the source points are collinear (zero determinant).
function solveAffine(
  src: Point[],
  dst: Point[],
): { a: number; b: number; c: number; d: number; tx: number; ty: number } | null {
  const [p0, p1, p2] = src
  const det =
    p0.x * (p1.y - p2.y) - p0.y * (p1.x - p2.x) + (p1.x * p2.y - p2.x * p1.y)
  if (Math.abs(det) < 1e-9) return null

  const cramer = (r0: number, r1: number, r2: number) => {
    // System: [x_i y_i 1] * [u v w]^T = r_i
    const d1 = r0 * (p1.y - p2.y) - p0.y * (r1 - r2) + (r1 * p2.y - r2 * p1.y)
    const d2 = p0.x * (r1 - r2) - r0 * (p1.x - p2.x) + (p1.x * r2 - p2.x * r1)
    const d3 =
      p0.x * (p1.y * r2 - r1 * p2.y) -
      p0.y * (p1.x * r2 - r1 * p2.x) +
      r0 * (p1.x * p2.y - p2.x * p1.y)
    return [d1 / det, d2 / det, d3 / det]
  }

  const [a, b, tx] = cramer(dst[0].x, dst[1].x, dst[2].x)
  const [c, d, ty] = cramer(dst[0].y, dst[1].y, dst[2].y)
  return { a, b, c, d, tx, ty }
}
