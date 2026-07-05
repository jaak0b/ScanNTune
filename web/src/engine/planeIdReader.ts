import type { Mat, OpenCv } from './opencv'
import type { AffineModel, CouponSpec, Plane } from './types'
import { couponPitchMm, projectMmToPx } from './types'
import { valueChannel } from './cvUtils'

// Reads the plane-ID code: 1/2/3 solid diagonal ribs across the bottom-row lattice cells,
// starting at the origin marker (XY=1, XZ=2, YZ=3). Cell k's diagonal runs from ring (k,0) to
// ring (k+1,1) in grid coordinates. A diagonal is additive dark geometry the full width of a rib,
// so stringing, scanner shadow and over-extrusion (which only ADD dark to a scan) cannot erase
// it; this replaced the drilled dot code that closed up on rough on-edge prints.
//
// The read projects each cell diagonal into the image through the fitted affine (the same model
// the measurement uses) and takes an intensity line profile along the middle of the segment,
// binarised with Otsu's threshold over the code region. A cell counts as filled or empty only
// when the profile is decisive; anything in between, or a non-contiguous fill pattern, returns
// null so the caller leaves the plate unidentified rather than mislabelling it.
//
// `partBright` is the polarity ring detection already validated against the whole coupon grid,
// so no local polarity vote is needed (a local guess could disagree with the validated global
// read and mislabel the plane).

// Cell classification is a two-class read with a reject option (Chow's rule): the nominal states
// are fraction 1 (a rib covers the entire profile by construction) and fraction 0 (the cell
// interior holds nothing by construction), so the decision bands are the maximum-margin thirds
// between them. A profile landing in the middle third is rejected as unreadable rather than
// guessed.
const FILLED_MIN_FRACTION = 2 / 3
const EMPTY_MAX_FRACTION = 1 / 3

// Sample count along each profile line; spacing stays well under the rib width (the narrowest
// feature the profile must resolve) for every plausible coupon geometry.
const PROFILE_SAMPLES = 41

export function readPlaneId(
  cv: OpenCv,
  image: Mat,
  coupon: CouponSpec,
  affine: AffineModel,
  partBright: boolean,
): Plane | null {
  const n = countPlaneDiagonals(cv, image, coupon, affine, partBright)
  return n === 1 ? 'XY' : n === 2 ? 'XZ' : n === 3 ? 'YZ' : null
}

// Exposed for tests: the number of leading filled bottom-row cell diagonals, or null when any
// cell is indecisive or the fill pattern is not a contiguous run starting at the origin cell.
export function countPlaneDiagonals(
  cv: OpenCv,
  image: Mat,
  coupon: CouponSpec,
  affine: AffineModel,
  partBright: boolean,
): number | null {
  const pitchMm = couponPitchMm(coupon)
  const maxCode = 3
  // The largest code needs maxCode bottom-row cells; a smaller grid cannot carry the marker.
  if (coupon.gridN - 1 < maxCode) return null

  // Profile geometry, all in the coupon's mm frame (projected per sample through the affine).
  // The profile spans the middle of the cell diagonal: one nominal ring outer diameter is
  // excluded at each end, which clears the ring disk (even with the on-edge wall boost) and the
  // funnel mouth, both bounded by that diameter. Three parallel lines offset by a quarter rib
  // width sit inside the rib's half-width by construction.
  const diagonalMm = pitchMm * Math.SQRT2
  const tMin = coupon.ringOuterDiameterMm / diagonalMm
  const tMax = 1 - tMin
  if (tMin >= tMax) return null // rings so large relative to the pitch that no rib is exposed
  const offsetsMm = [-coupon.ribWidthMm / 4, 0, coupon.ribWidthMm / 4]
  // Perpendicular to the cell diagonal direction (1,1)/sqrt(2) in the mm frame.
  const perpMm = { x: -Math.SQRT1_2, y: Math.SQRT1_2 }

  // Each cell's sample points, projected into the image.
  const cells = Array.from({ length: maxCode }, (_, k) => {
    const points: Array<{ x: number; y: number }> = []
    for (const o of offsetsMm) {
      for (let i = 0; i < PROFILE_SAMPLES; i++) {
        const t = tMin + ((tMax - tMin) * i) / (PROFILE_SAMPLES - 1)
        points.push(
          projectMmToPx(
            affine,
            (k + t) * pitchMm + o * perpMm.x,
            t * pitchMm + o * perpMm.y,
          ),
        )
      }
    }
    return points
  })

  // Binarise the region containing all code cells once, with Otsu's threshold.
  const margin = Math.max(4, Math.round(0.1 * affine.scaleXPxPerMm * pitchMm))
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const points of cells)
    for (const p of points) {
      x0 = Math.min(x0, p.x)
      y0 = Math.min(y0, p.y)
      x1 = Math.max(x1, p.x)
      y1 = Math.max(y1, p.y)
    }
  x0 = Math.max(0, Math.floor(x0) - margin)
  y0 = Math.max(0, Math.floor(y0) - margin)
  x1 = Math.min(image.cols, Math.ceil(x1) + margin)
  y1 = Math.min(image.rows, Math.ceil(y1) + margin)
  if (x1 - x0 < 8 || y1 - y0 < 8) return null

  const roiView = image.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0))
  const roi = roiView.clone()
  roiView.delete()
  let gray: Mat | null = null
  const binary = new cv.Mat()
  try {
    gray = valueChannel(cv, roi)
    cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU)
    // Make the part the white foreground, matching the polarity ring detection validated.
    if (!partBright) cv.bitwise_not(binary, binary)

    let count = 0
    let runEnded = false
    for (const points of cells) {
      const fraction = profileForegroundFraction(binary, points, x0, y0)
      if (fraction === null) return null // profile leaves the image: cannot certify the code
      const filled = fraction >= FILLED_MIN_FRACTION
      const empty = fraction <= EMPTY_MAX_FRACTION
      if (!filled && !empty) return null // indecisive cell: refuse to guess
      if (filled) {
        if (runEnded) return null // filled after empty: not a contiguous run from the origin
        count++
      } else {
        runEnded = true
      }
    }
    return count
  } finally {
    roi.delete()
    gray?.delete()
    binary.delete()
  }
}

// Fraction of part-foreground samples among the cell's projected profile points, read from the
// binarised ROI. Returns null when any sample falls outside the ROI.
function profileForegroundFraction(
  binary: Mat,
  points: ReadonlyArray<{ x: number; y: number }>,
  roiX: number,
  roiY: number,
): number | null {
  let foreground = 0
  for (const p of points) {
    const x = Math.round(p.x - roiX)
    const y = Math.round(p.y - roiY)
    if (x < 0 || y < 0 || x >= binary.cols || y >= binary.rows) return null
    foreground += binary.ucharPtr(y, x)[0] > 0 ? 1 : 0
  }
  return foreground / points.length
}
