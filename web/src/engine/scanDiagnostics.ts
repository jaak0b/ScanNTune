import type { AffineModel, ClipSide, CouponSpec, GridCorrespondence, Plane, RingSeverity } from './types'
import { couponInnerDiameterMm, projectMmToPx } from './types'

// Pure per-scan diagnostics derived from detection and the fitted grid model. The ring tally is a
// count against the grid the coupon defines; the clipping diagnosis projects each grid position that
// SHOULD hold a hole but has none detected through the fitted affine, and flags a side when that
// hole's disk would cross (or fall past) the image border. Everything is derived from the coupon
// geometry and the fit; there is no proximity threshold.

// Green when aligned and every hole registered; amber when aligned but one hole is missing (mapGrid
// tolerates a single stray); red when the scan could not be aligned at all.
export function ringSeverity(ringsFound: number, ringsExpected: number, aligned: boolean): RingSeverity {
  if (!aligned) return 'error'
  return ringsFound >= ringsExpected ? 'ok' : 'warning'
}

// A flat XY plate scan that reads mirrored is invalid: the plate's hole rims are countersunk, so
// only the first-layer face is a valid scan face, and a face-down first layer never reads mirrored.
// A mirrored read therefore means the countersunk face was on the glass or the plate was printed
// mirrored; either way the scan cannot be measured. The standing plates (XZ/YZ) scan validly either
// way up, so their flip stays legitimate diagnostic information, never a rejection.
export function mirroredScanInvalid(plane: Plane | null, flipped: boolean | null): boolean {
  return plane === 'XY' && flipped === true
}

// The image sides an undetected hole would cross: for every expected grid vertex with no detected
// ring, its centre is projected through the fitted affine and its disk (the coupon's hole radius at
// the fitted scale) is tested against each border. A missing hole well inside the frame flags
// nothing: that is a detection miss, not clipping.
export function clippedSides(
  spec: CouponSpec,
  points: readonly GridCorrespondence[],
  affine: AffineModel,
  imageCols: number,
  imageRows: number,
): ClipSide[] {
  const present = new Set(points.map((p) => `${p.col},${p.row}`))
  const pitchMm = spec.baselineMm / (spec.gridN - 1)
  const holeRadiusPx =
    (couponInnerDiameterMm(spec) / 2) * Math.max(affine.scaleXPxPerMm, affine.scaleYPxPerMm)

  const sides = new Set<ClipSide>()
  for (let c = 0; c < spec.gridN; c++) {
    for (let r = 0; r < spec.gridN; r++) {
      if ((c === 0 || c === 1) && r === 0) continue // the two solid markers never hold a hole
      if (present.has(`${c},${r}`)) continue
      const { x: px, y: py } = projectMmToPx(affine, c * pitchMm, r * pitchMm)
      if (px - holeRadiusPx < 0) sides.add('left')
      if (px + holeRadiusPx > imageCols) sides.add('right')
      if (py - holeRadiusPx < 0) sides.add('top')
      if (py + holeRadiusPx > imageRows) sides.add('bottom')
    }
  }
  const order: ClipSide[] = ['left', 'right', 'top', 'bottom']
  return order.filter((s) => sides.has(s))
}
