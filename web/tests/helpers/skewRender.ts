import type { Mat, OpenCv } from '../../src/engine/opencv'
import type { CouponSpec } from '../../src/engine/types'
import { couponInnerDiameterMm, couponPitchMm } from '../../src/engine/types'

// Synthetic ground-truth renderer for the skew/ring coupon, the same pattern as paRender and
// emRender: the input image is generated from known seed parameters, so a recovery test's truth
// is the literal it was rendered from. Draws the ring lattice (filled ring disks with holes,
// orthogonal ribs joining the centres), the two-solid orientation marker at the origin corner and
// its +X neighbour, and the XY plane-ID diagonal rib across the first bottom-row cell, in a
// caller-given part color on a caller-given backdrop color at a caller-given px/mm. Deliberately
// simple filled primitives, no noise model.

export interface SkewRenderOptions {
  spec: CouponSpec
  pxPerMm: number
  /** BGR color of the printed part. */
  partBgr: [number, number, number]
  /** BGR color of everything behind the part. */
  backdropBgr: [number, number, number]
}

// Renders the coupon with its origin marker corner toward the image top-left, +X right, +Y down.
// The caller deletes the returned Mat.
export function renderSkewCoupon(cv: OpenCv, o: SkewRenderOptions): Mat {
  const { spec, pxPerMm } = o
  const pitchMm = couponPitchMm(spec)
  const marginMm = 10
  const sizePx = Math.round((spec.baselineMm + 2 * marginMm) * pxPerMm)
  const part = new cv.Scalar(o.partBgr[0], o.partBgr[1], o.partBgr[2])
  const backdrop = new cv.Scalar(o.backdropBgr[0], o.backdropBgr[1], o.backdropBgr[2])
  const image = new cv.Mat(sizePx, sizePx, cv.CV_8UC3, backdrop)

  // Ring centre of grid vertex (col, row) in image pixels.
  const centre = (col: number, row: number) => ({
    x: Math.round((marginMm + col * pitchMm) * pxPerMm),
    y: Math.round((marginMm + row * pitchMm) * pxPerMm),
  })
  const halfRibPx = Math.round((spec.ribWidthMm / 2) * pxPerMm)
  const ribThicknessPx = Math.max(1, Math.round(spec.ribWidthMm * pxPerMm))
  const outerRadiusPx = Math.round((spec.ringOuterDiameterMm / 2) * pxPerMm)
  const holeRadiusPx = Math.round((couponInnerDiameterMm(spec) / 2) * pxPerMm)

  // Orthogonal ribs joining neighbouring ring centres.
  for (let row = 0; row < spec.gridN; row++) {
    for (let col = 0; col < spec.gridN; col++) {
      const a = centre(col, row)
      if (col + 1 < spec.gridN) {
        const b = centre(col + 1, row)
        cv.rectangle(
          image,
          new cv.Point(a.x, a.y - halfRibPx),
          new cv.Point(b.x, b.y + halfRibPx),
          part,
          -1,
        )
      }
      if (row + 1 < spec.gridN) {
        const b = centre(col, row + 1)
        cv.rectangle(
          image,
          new cv.Point(a.x - halfRibPx, a.y),
          new cv.Point(b.x + halfRibPx, b.y),
          part,
          -1,
        )
      }
    }
  }

  // The XY plane-ID: one diagonal rib across the first bottom-row cell, ring (0,0) to ring (1,1).
  cv.line(image, new cv.Point(centre(0, 0).x, centre(0, 0).y), new cv.Point(centre(1, 1).x, centre(1, 1).y), part, ribThicknessPx)

  // Ring disks, then holes; the origin corner (0,0) and its +X neighbour (1,0) stay solid: they
  // are the orientation marker.
  for (let row = 0; row < spec.gridN; row++) {
    for (let col = 0; col < spec.gridN; col++) {
      const c = centre(col, row)
      cv.circle(image, new cv.Point(c.x, c.y), outerRadiusPx, part, -1)
    }
  }
  for (let row = 0; row < spec.gridN; row++) {
    for (let col = 0; col < spec.gridN; col++) {
      const solidMarker = row === 0 && (col === 0 || col === 1)
      if (solidMarker) continue
      const c = centre(col, row)
      cv.circle(image, new cv.Point(c.x, c.y), holeRadiusPx, backdrop, -1)
    }
  }
  return image
}
