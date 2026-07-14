import type { Mat } from './opencv'
import type { AffineModel, CouponSpec, Plane } from './types'
import { couponPitchMm, projectMmToPx } from './types'

// Reads the plane-ID code: 1/2/3 solid diagonal ribs across the bottom-row lattice cells,
// starting at the origin marker (XY=1, XZ=2, YZ=3). Cell k's diagonal runs from ring (k,0) to
// ring (k+1,1) in grid coordinates. A diagonal is additive part geometry the full width of a rib,
// so stringing, scanner shadow and over-extrusion (which only ADD part to a scan) cannot erase
// it; this replaced the drilled dot code that closed up on rough on-edge prints.
//
// The read projects each cell diagonal into the part-white binary through the fitted affine (the
// same model the measurement uses) and takes a foreground line profile along the middle of the
// segment. The binary is the threshold band the ring grid already validated (the analyzer's
// winning mask), so the read shares the measurement's single binarisation source: no local
// re-threshold that could disagree with the validated global read (a value-channel Otsu here is
// blind on a coupon that only a saturation band separates from its backdrop).
//
// A cell counts as filled or empty only when the profile is decisive; anything in between, or a
// non-contiguous fill pattern, returns null so the caller leaves the plate unidentified rather
// than mislabelling it.

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
  partWhite: Mat,
  coupon: CouponSpec,
  affine: AffineModel,
): Plane | null {
  const n = countPlaneDiagonals(partWhite, coupon, affine)
  return n === 1 ? 'XY' : n === 2 ? 'XZ' : n === 3 ? 'YZ' : null
}

// Exposed for tests: the number of leading filled bottom-row cell diagonals, or null when any
// cell is indecisive or the fill pattern is not a contiguous run starting at the origin cell.
export function countPlaneDiagonals(
  partWhite: Mat,
  coupon: CouponSpec,
  affine: AffineModel,
): number | null {
  const pitchMm = couponPitchMm(coupon)
  const maxCode = 3
  // The largest code needs maxCode bottom-row cells; a smaller grid cannot carry the marker.
  if (coupon.gridN - 1 < maxCode) return null

  // Profile geometry, all in the coupon's mm frame (projected per sample through the affine).
  // The profile spans the middle of the cell diagonal: one nominal ring outer diameter (9 mm)
  // is excluded at each end as a DISTANCE from the ring centre. The on-edge plates print larger
  // rings than the nominal spec (13 mm disk, 11 mm funnel mouth after the bore boost), but their
  // radii (6.5 mm / 5.5 mm) still sit 2.5 mm inside the exclusion. Three parallel lines offset
  // by a quarter rib width sit inside the rib's half-width by construction.
  const diagonalMm = pitchMm * Math.SQRT2
  const tMin = coupon.ringOuterDiameterMm / diagonalMm
  const tMax = 1 - tMin
  if (tMin >= tMax) return null // rings so large relative to the pitch that no rib is exposed
  const offsetsMm = [-coupon.ribWidthMm / 4, 0, coupon.ribWidthMm / 4]
  // Perpendicular to the cell diagonal direction (1,1)/sqrt(2) in the mm frame.
  const perpMm = { x: -Math.SQRT1_2, y: Math.SQRT1_2 }

  let count = 0
  let runEnded = false
  for (let k = 0; k < maxCode; k++) {
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
    const fraction = profileForegroundFraction(partWhite, points)
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
}

// Fraction of part-foreground samples among the cell's projected profile points, read from the
// part-white binary. Returns null when any sample falls outside the image.
function profileForegroundFraction(
  partWhite: Mat,
  points: ReadonlyArray<{ x: number; y: number }>,
): number | null {
  let foreground = 0
  for (const p of points) {
    const x = Math.round(p.x)
    const y = Math.round(p.y)
    if (x < 0 || y < 0 || x >= partWhite.cols || y >= partWhite.rows) return null
    foreground += partWhite.ucharPtr(y, x)[0] > 0 ? 1 : 0
  }
  return foreground / points.length
}
