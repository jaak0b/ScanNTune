import type { Mat, OpenCv } from './opencv'
import type { DetectedRing } from './types'
import { median } from './math'
import { analyzeBothPolarities } from './cvUtils'
import type { Polarity } from './cvUtils'

// Thresholds the image on the HSV value channel (Otsu), finds the enclosed holes, and keeps the ring
// centres (the binary area centroid, immune to over/under extrusion). Ring holes are separated from
// the much larger square lattice cells by a size cluster (radius-median filter), so circularity is
// only a loose gate to drop slivers (real holes are rough, circularity ~0.2 to 0.8).
//
// Which side of the threshold is the part is NOT guessed here. A border statistic proved unreliable:
// a backing sheet that stops short of the scan bed leaves bright scanner-lid margins on the image
// border, flipping the guess and turning dust specks into the only "holes". Instead detection runs
// under BOTH polarities and the caller validates each candidate set against the coupon's known grid
// and orientation marker (model selection against the coupon model), keeping the one that fits.

/** Whether the part is assumed brighter or darker than what is behind it. */
export type RingPolarity = Polarity

export interface DualDetection {
  bright: DetectedRing[]
  dark: DetectedRing[]
}

// When `masksOut` is passed, the binary mask each polarity ran findContours on (the value channel
// thresholded, oriented part-white, and morphologically closed) is cloned into it so the caller can
// show the user exactly what the detector searched. The caller owns and must delete both masks.
export function detectRingsDual(
  cv: OpenCv,
  image: Mat,
  minHoleAreaPx = 40.0,
  minCircularity = 0.2,
  masksOut?: { bright?: Mat; dark?: Mat },
): DualDetection {
  const wantMasks = masksOut !== undefined
  try {
    return analyzeBothPolarities(cv, image, (partWhite, polarity) => {
      const { rings, mask } = detectOnBinary(cv, partWhite, minHoleAreaPx, minCircularity, wantMasks)
      // Hand each mask over as soon as it exists, so the catch below can free it if the other
      // polarity's pass throws.
      if (masksOut && mask) masksOut[polarity] = mask
      return rings
    })
  } catch (e) {
    masksOut?.bright?.delete()
    masksOut?.dark?.delete()
    if (masksOut) {
      delete masksOut.bright
      delete masksOut.dark
    }
    throw e
  }
}

// Runs the hole search on one part-white binary. Closes small gaps first (on a copy; the input is
// reused for the other polarity), clones the searched mask when asked, then keeps the interior
// contours that pass the area and circularity gates and the radius cluster. The caller owns `mask`.
function detectOnBinary(
  cv: OpenCv,
  partWhite: Mat,
  minHoleAreaPx: number,
  minCircularity: number,
  wantMask: boolean,
): { rings: DetectedRing[]; mask: Mat | null } {
  const closed = new cv.Mat()
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  let mask: Mat | null = null
  try {
    const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3))
    cv.morphologyEx(partWhite, closed, cv.MORPH_CLOSE, kernel)
    kernel.delete()

    // Capture the mask before findContours, which can mutate its input.
    if (wantMask) mask = closed.clone()

    // CHAIN_APPROX_SIMPLE drops only collinear boundary points, so contourArea, arcLength, and the
    // moments (all polygon integrals) are unchanged while large lattice-cell contours shrink a lot.
    cv.findContours(closed, contours, hierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE)

    const candidates: DetectedRing[] = []
    const count = contours.size()
    for (let i = 0; i < count; i++) {
      // hierarchy rows are [next, prev, firstChild, parent]; read data32S per iteration, since a
      // wasm heap growth mid-loop detaches any TypedArray view captured before it.
      if (hierarchy.data32S[i * 4 + 3] < 0) continue // only interior contours (holes) can be ring centres

      const contour = contours.get(i)
      try {
        const area = cv.contourArea(contour, false)
        if (area < minHoleAreaPx) continue

        const perimeter = cv.arcLength(contour, true)
        if (perimeter <= 0) continue

        const circularity = (4.0 * Math.PI * area) / (perimeter * perimeter)
        if (circularity < minCircularity) continue

        const m = cv.moments(contour, false)
        if (m.m00 === 0) continue

        candidates.push({
          centerX: m.m10 / m.m00,
          centerY: m.m01 / m.m00,
          radiusPx: Math.sqrt(area / Math.PI),
          circularity,
        })
      } finally {
        contour.delete()
      }
    }

    return { rings: filterByRadius(candidates), mask }
  } catch (e) {
    mask?.delete() // don't orphan the captured mask when the contour pass throws
    throw e
  } finally {
    closed.delete()
    contours.delete()
    hierarchy.delete()
  }
}

// Drop anything whose radius is far from the population median (stray holes / lattice cells).
function filterByRadius(candidates: DetectedRing[]): DetectedRing[] {
  if (candidates.length === 0) return candidates
  const med = median(candidates.map((c) => c.radiusPx))
  return candidates.filter((c) => c.radiusPx >= med * 0.5 && c.radiusPx <= med * 1.8)
}

