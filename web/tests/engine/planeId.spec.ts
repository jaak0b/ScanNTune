// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { getCv, decodeFixtureBgr, blankGray } from '../helpers/cv'
import { analyzeCoupon } from '../../src/engine/couponAnalyzer'
import { readPlaneId } from '../../src/engine/planeIdReader'
import { asAligned, defaultCouponSpec } from '../../src/engine/types'
import type { OpenCv, Mat } from '../../src/engine/opencv'
import type { AlignedResult } from '../../src/engine/types'

// End-to-end over the three plate models, rendered flat from calibration_coupon.scad (scan_view).
// The ring/hole/diagonal centres are exactly the model's, so this pins ring detection on the
// on-edge geometry AND the plane-ID read (1/2/3 diagonal ribs across the bottom-row cells,
// starting at the origin marker => XY/XZ/YZ).

let cv: OpenCv
const cases: Array<{ file: string; plane: 'XY' | 'XZ' | 'YZ' }> = [
  { file: 'render_xy.png', plane: 'XY' },
  { file: 'render_xz.png', plane: 'XZ' },
  { file: 'render_yz.png', plane: 'YZ' },
]

const results: Record<string, AlignedResult> = {}

beforeAll(async () => {
  cv = await getCv()
  for (const c of cases) {
    const img: Mat = decodeFixtureBgr(cv, c.file)
    try {
      results[c.plane] = asAligned(analyzeCoupon(cv, img, { coupon: defaultCouponSpec(), pxPerMm: null }))
    } finally {
      img.delete()
    }
  }
}, 60000)

describe('plane-ID and detection on rendered plates', () => {
  it.each(cases)('reads the plane-ID diagonals on the $plane plate', ({ plane }) => {
    expect(results[plane].plane).toBe(plane)
  })

  it.each(cases)('detects the ring grid on the $plane plate', ({ plane }) => {
    // 23 holes (25 vertices minus the two solid markers); the pipeline tolerates one stray miss, so
    // a synthetic render landing on 22 is still a healthy grid.
    expect(results[plane].ringsDetected).toBeGreaterThanOrEqual(22)
  })

  it.each(cases)('a $plane render of the scanned face reads flipped false', ({ plane }) => {
    // The scan_view fixtures are mirrored the way a flatbed images the face on the glass, so the
    // designed scan face must read as NOT flipped; the old top-view convention read the opposite.
    expect(results[plane].orientation?.flipped).toBe(false)
  })

  it.each(cases)('a perfect $plane render has near-zero skew', ({ plane }) => {
    expect(Math.abs(results[plane].skewDegrees)).toBeLessThanOrEqual(0.1)
  })

  it.each(cases)('a perfect $plane render is isotropic', ({ plane }) => {
    const r = results[plane]
    expect(Math.abs(r.xScalePercent - r.yScalePercent)).toBeLessThanOrEqual(0.2)
  })

  it('refuses a grid too small to carry the largest code (gridN < 4)', () => {
    const mask = blankGray(cv)
    try {
      const affine = { a: 5, b: 0, c: 0, d: 5, tx: 50, ty: 50 }
      const spec = { ...defaultCouponSpec(), gridN: 3 }
      expect(
        readPlaneId(mask, spec, { ...affine, scaleXPxPerMm: 5, scaleYPxPerMm: 5, skewDegrees: 0, rmsResidualPx: 0, pointCount: 7 }),
      ).toBeNull()
    } finally {
      mask.delete()
    }
  })
})
