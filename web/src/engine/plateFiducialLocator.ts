import type { Mat, OpenCv } from './opencv'
import { majorityFilterBinary, roiAround } from './cvUtils'
import type { Point } from './cornerFiducialSolver'
import { MIN_ALIGN_PX_PER_MM } from './resolutionGate'

// Shared plate-detect preamble for the corner-fiducial coupon flows (EM, PA, IS). On one
// threshold-band binary (coupon plate assumed white) it finds the plate as the largest external
// contour, gates it by aspect ratio against the nominal coupon shape, denoises the cropped plate
// region with a majority filter (a build-plate-backed scan shows the plate's speckle through
// every opening), optionally closes narrow openings with a per-flow kernel, and extracts the
// plate's hole contours (RETR_CCOMP children of the re-located plate) filtered by area band and
// squareness. Each flow's geometry-specific candidate selection and affine solve sit on top.

export interface PlateFiducialParams {
  /** Nominal plate outline in coupon-frame millimetres. */
  plateWidthMm: number
  plateHeightMm: number
  /** Nominal fiducial hole side length in millimetres. */
  fiducialSizeMm: number
  /** Accepted hole area as multiples of the expected fiducial area. */
  holeAreaBand: { min: number; max: number }
  /** Optional morphological close kernel in millimetres, applied before hole extraction, to
   *  erase plate openings narrower than the kernel (test lines, comb slots) while the wider
   *  fiducial holes survive with their centroids unchanged (the closing is symmetric). */
  closeKernelMm?: number
}

export type PlateFiducialResult =
  | { ok: true; holes: Point[]; estimatedPxPerMm: number }
  | { ok: false; reason: string; stage: 0 | 1 }

export function locatePlateFiducialHoles(
  cv: OpenCv,
  objectWhite: Mat,
  params: PlateFiducialParams,
): PlateFiducialResult {
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  try {
    cv.findContours(objectWhite, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

    // The coupon plate: the largest external contour. Holes are read later by a
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
    const nominalAreaMm2 = params.plateWidthMm * params.plateHeightMm
    // Degenerate-alignment floor: a blob smaller than the coupon at MIN_ALIGN_PX_PER_MM
    // cannot be a usable coupon scan (see resolutionGate for the derivation).
    const minBasePx = nominalAreaMm2 * MIN_ALIGN_PX_PER_MM * MIN_ALIGN_PX_PER_MM
    if (baseIndex < 0 || baseArea < minBasePx) {
      return {
        ok: false,
        reason:
          'No coupon was found in the scan. Place the printed coupon flat on the scanner glass so the whole plate is visible.',
        stage: 0,
      }
    }

    // Aspect-ratio gate: the largest blob must be shaped like the coupon plate.
    const baseContour = contours.get(baseIndex)
    let baseLong: number
    let baseShort: number
    let plateRect: { x: number; y: number; width: number; height: number }
    try {
      const rect = cv.minAreaRect(baseContour)
      baseLong = Math.max(rect.size.width, rect.size.height)
      baseShort = Math.min(rect.size.width, rect.size.height)
      plateRect = cv.boundingRect(baseContour)
    } finally {
      baseContour.delete()
    }
    const nominalLong = Math.max(params.plateWidthMm, params.plateHeightMm)
    const nominalShort = Math.min(params.plateWidthMm, params.plateHeightMm)
    if (
      baseShort <= 0 ||
      Math.abs(baseLong / baseShort - nominalLong / nominalShort) / (nominalLong / nominalShort) >
        0.1
    ) {
      return {
        ok: false,
        reason:
          'The largest object in the scan does not match the coupon plate shape. Remove other objects from the glass and rescan.',
        stage: 1,
      }
    }

    // Fiducial holes: children of the plate contour with the expected area and a square shape.
    const estimatedPxPerMm = Math.sqrt(baseArea / nominalAreaMm2)
    const expectedHoleAreaPx = (params.fiducialSizeMm * estimatedPxPerMm) ** 2
    const kernelPx =
      params.closeKernelMm === undefined
        ? 0
        : Math.max(3, Math.round(params.closeKernelMm * estimatedPxPerMm))
    // A coupon scanned on its textured build plate shows the plate's speckle through every
    // opening, littering the binary with noise blobs; a majority filter well under the fiducial
    // size removes them without moving the surviving centroids. The holes lie strictly inside
    // the plate, so the denoise/close/contour stage runs on the plate's bounding rectangle plus
    // a kernel-sized margin instead of the full scan (identical results, a fraction of the
    // cost); the crop origin is added back onto every hole centroid.
    const denoiseKernelPx = (params.fiducialSizeMm / 5) * estimatedPxPerMm
    const cropped = roiAround(cv, objectWhite, plateRect, Math.max(kernelPx, denoiseKernelPx))
    let denoised: Mat
    try {
      denoised = majorityFilterBinary(cv, cropped.roi, denoiseKernelPx)
    } finally {
      cropped.roi.delete()
    }
    let processed: Mat = denoised
    const holeContours = new cv.MatVector()
    const holeHierarchy = new cv.Mat()
    try {
      if (kernelPx > 0) {
        // A rectangular kernel: rectangular morphology runs via the separable van Herk/Gil-Werman
        // algorithm, O(N) regardless of kernel size (an elliptical kernel of this width costs
        // kernel-area per pixel on a large scan). The closing's job is shape-independent for a
        // symmetric kernel.
        processed = new cv.Mat()
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kernelPx, kernelPx))
        cv.morphologyEx(denoised, processed, cv.MORPH_CLOSE, kernel)
        kernel.delete()
      }
      cv.findContours(processed, holeContours, holeHierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE)

      // Re-locate the plate in the processed binary (indices differ from the first pass).
      const holeCount = holeContours.size()
      let processedBaseIndex = -1
      let processedBaseArea = 0
      for (let i = 0; i < holeCount; i++) {
        if (holeHierarchy.data32S[i * 4 + 3] !== -1) continue
        const contour = holeContours.get(i)
        try {
          const area = cv.contourArea(contour)
          if (area > processedBaseArea) {
            processedBaseArea = area
            processedBaseIndex = i
          }
        } finally {
          contour.delete()
        }
      }

      const holes: Point[] = []
      for (let i = 0; i < holeCount; i++) {
        if (holeHierarchy.data32S[i * 4 + 3] !== processedBaseIndex) continue // not a hole in the plate
        const contour = holeContours.get(i)
        try {
          const area = cv.contourArea(contour)
          if (
            area < expectedHoleAreaPx * params.holeAreaBand.min ||
            area > expectedHoleAreaPx * params.holeAreaBand.max
          ) {
            continue
          }
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
      return { ok: true, holes, estimatedPxPerMm }
    } finally {
      denoised.delete()
      if (processed !== denoised) processed.delete()
      holeContours.delete()
      holeHierarchy.delete()
    }
  } finally {
    contours.delete()
    hierarchy.delete()
  }
}
