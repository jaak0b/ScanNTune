import type { Mat, OpenCv } from '../opencv'
import type { EmTestSpec } from './types'
import { emCouponGeometry, pitchForBlock } from './types'
import { analyzeThresholdBands, majorityFilterBinary } from '../cvUtils'
import { selectCornerHoles, solveFromCornerHoles } from '../cornerFiducialSolver'
import type { Point } from '../cornerFiducialSolver'
import { MIN_ALIGN_PX_PER_MM } from '../resolutionGate'

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
  if (aligned) return aligned
  // No hypothesis fits; report the attempt that got past plate detection if any did, as its
  // hole-level reason is the more actionable one for the user.
  const informative = attempts.find(
    (r) => r.failureReason !== null && !r.failureReason.startsWith('No coupon'),
  )
  return informative ?? attempts[0] ?? fail('No coupon was found in the scan.')
}

export function mmToPx(alignment: EmAlignment, xMm: number, yMm: number): { x: number; y: number } {
  const A = alignment.affine
  if (!A) throw new Error('The alignment did not succeed, so there is no coupon-to-scan mapping.')
  return { x: A.a * xMm + A.b * yMm + A.tx, y: A.c * xMm + A.d * yMm + A.ty }
}

function fail(reason: string): EmAlignment {
  return {
    success: false,
    failureReason: reason,
    affine: null,
    flipped: false,
    rotationQuarterTurns: 0,
  }
}

// One alignment attempt on one threshold band's binary (coupon plate assumed white).
function tryAlign(
  cv: OpenCv,
  objectWhite: Mat,
  spec: EmTestSpec,
  g: ReturnType<typeof emCouponGeometry>,
): EmAlignment {
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  try {
    cv.findContours(objectWhite, contours, hierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE)

    // The coupon plate: the largest top-level contour.
    const count = contours.size()
    let baseIndex = -1
    let baseArea = 0
    for (let i = 0; i < count; i++) {
      if (hierarchy.data32S[i * 4 + 3] !== -1) continue // not top-level
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
    const nominalAreaMm2 = g.couponWidthMm * g.couponHeightMm
    // Sanity floor, not a tuned constant: any scanner above ~26 dpi (1 px/mm) exceeds this.
    const minBasePx = nominalAreaMm2 * MIN_ALIGN_PX_PER_MM * MIN_ALIGN_PX_PER_MM
    if (baseIndex < 0 || baseArea < minBasePx) {
      return fail(
        'No coupon was found in the scan. Place the printed coupon flat on the scanner glass so the whole plate is visible.',
      )
    }

    // Aspect-ratio gate: the largest blob must be shaped like the coupon plate.
    const baseContour = contours.get(baseIndex)
    let baseLong: number
    let baseShort: number
    try {
      const rect = cv.minAreaRect(baseContour)
      baseLong = Math.max(rect.size.width, rect.size.height)
      baseShort = Math.min(rect.size.width, rect.size.height)
    } finally {
      baseContour.delete()
    }
    const nominalLong = Math.max(g.couponWidthMm, g.couponHeightMm)
    const nominalShort = Math.min(g.couponWidthMm, g.couponHeightMm)
    if (
      baseShort <= 0 ||
      Math.abs(baseLong / baseShort - nominalLong / nominalShort) / (nominalLong / nominalShort) >
        0.1
    ) {
      return fail(
        'The largest object in the scan does not match the coupon plate shape. Remove other objects from the glass and rescan.',
      )
    }

    // Fiducial holes: children of the plate contour with the expected area and a square shape.
    // The comb slots and block separators are also background-toned openings in this binary, so
    // it is first morphologically closed with a kernel wider than the coupon's widest comb gap
    // (the widest pitch minus half a nominal bead on each side) but well under the fiducial hole
    // size: the slots vanish, the 5 mm holes survive with their centroids unchanged (the closing
    // is symmetric).
    const estimatedPxPerMm = Math.sqrt(baseArea / nominalAreaMm2)
    const expectedHoleAreaPx = (g.fiducialSizeMm * estimatedPxPerMm) ** 2
    const maxGapMm = pitchForBlock(spec, spec.blockCount - 1) - 0.5 * spec.nominalLineWidthMm
    const kernelPx = Math.max(3, Math.round(maxGapMm * estimatedPxPerMm))
    // A coupon scanned on its textured build plate shows the plate's speckle through every
    // opening, littering the binary with noise blobs; a majority filter well under the fiducial
    // size removes them without moving the surviving centroids.
    const denoised = majorityFilterBinary(
      cv,
      objectWhite,
      (g.fiducialSizeMm / 5) * estimatedPxPerMm,
    )
    const closed = new cv.Mat()
    const holeContours = new cv.MatVector()
    const holeHierarchy = new cv.Mat()
    try {
      // A rectangular kernel: rectangular morphology runs via the separable van Herk/Gil-Werman
      // algorithm, O(N) regardless of kernel size (an elliptical kernel of this width costs
      // kernel-area per pixel on a large scan). The closing's job is shape-independent for a
      // symmetric kernel.
      const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kernelPx, kernelPx))
      cv.morphologyEx(denoised, closed, cv.MORPH_CLOSE, kernel)
      kernel.delete()
      cv.findContours(closed, holeContours, holeHierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE)

      // Re-locate the plate in the closed binary (indices differ from the first pass).
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
        if (holeHierarchy.data32S[i * 4 + 3] !== closedBaseIndex) continue // not a hole in the plate
        const contour = holeContours.get(i)
        try {
          const area = cv.contourArea(contour)
          if (area < expectedHoleAreaPx * 0.4 || area > expectedHoleAreaPx * 2.5) continue
          // A fiducial is square, so its minimum-area rectangle is not elongated.
          const rect = cv.minAreaRect(contour)
          const long = Math.max(rect.size.width, rect.size.height)
          const short = Math.min(rect.size.width, rect.size.height)
          if (short <= 0 || long / short > 2) continue
          const m = cv.moments(contour)
          if (m.m00 <= 0) continue
          holes.push({ x: m.m10 / m.m00, y: m.m01 / m.m00 })
        } finally {
          contour.delete()
        }
      }
      // A plate-backed scan shows the plate's speckle through the comb gaps, so hole-like blobs
      // beyond the three fiducials survive the per-hole gates; the fiducial triple is selected
      // by its mutual geometry.
      const selected = selectCornerHoles(holes, g.fiducials, estimatedPxPerMm)
      if (!selected.ok) return fail(selected.reason)

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
// and solves the exact 3-point affine. The math lives in the shared corner-fiducial solver;
// the nominal layout order (fiducials[1] corner-adjacent, [0] and [2] its neighbours) is derived
// from emCouponGeometry, not assumed.
function solveFromHoles(holes: Point[], g: ReturnType<typeof emCouponGeometry>): EmAlignment {
  const solved = solveFromCornerHoles(holes, g.fiducials)
  if (!solved.ok) return fail(solved.reason)
  return {
    success: true,
    failureReason: null,
    affine: solved.affine,
    flipped: solved.flipped,
    rotationQuarterTurns: solved.rotationQuarterTurns,
  }
}
