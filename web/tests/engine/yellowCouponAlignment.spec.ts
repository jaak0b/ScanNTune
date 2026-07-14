// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { getCv } from '../helpers/cv'
import { renderSkewCoupon } from '../helpers/skewRender'
import { analyzeCoupon } from '../../src/engine/couponAnalyzer'
import { asAligned, defaultCouponSpec } from '../../src/engine/types'
import type { AlignedResult } from '../../src/engine/types'

// A saturated yellow coupon on a white backdrop matches it in the HSV value channel (V is the max
// of B, G, R, and both the yellow part and the white paper max out), so no value-channel threshold
// band can separate them; only a saturation band isolates the part. This pins the skew/ring flow
// on the shared threshold-band sweep: it must align such a scan exactly like a neutral dark print.
// Both images come from the same ground-truth render (metamorphic pairing: only the colors differ).

// 4 px/mm is about 100 dpi: the coupon stays a small image while every hole is far above the
// detector's minimum hole area.
const PX_PER_MM = 4

let gray: AlignedResult
let yellow: AlignedResult

beforeAll(async () => {
  const cv = await getCv()
  const spec = defaultCouponSpec()
  const dark = renderSkewCoupon(cv, {
    spec,
    pxPerMm: PX_PER_MM,
    partBgr: [60, 60, 60],
    backdropBgr: [255, 255, 255],
  })
  // Saturated yellow with the same value as the white backdrop: V = max(0, 220, 255) = 255.
  const recolored = renderSkewCoupon(cv, {
    spec,
    pxPerMm: PX_PER_MM,
    partBgr: [0, 220, 255],
    backdropBgr: [255, 255, 255],
  })
  try {
    gray = asAligned(analyzeCoupon(cv, dark, { coupon: spec, pxPerMm: null }))
    yellow = asAligned(analyzeCoupon(cv, recolored, { coupon: spec, pxPerMm: null }))
  } finally {
    dark.delete()
    recolored.delete()
  }
}, 60000)

describe('yellow-on-white coupon alignment', () => {
  it('aligns the yellow coupon', () => {
    expect(yellow.aligned).toBe(true)
  })

  it('detects the full 23-hole ring grid, same as the dark render', () => {
    expect(gray.ringsDetected).toBe(23)
    expect(yellow.ringsDetected).toBe(23)
  })

  it('measures near-zero skew on both renders', () => {
    // The render is unsheared by construction; the only error source is the integer pixel
    // quantization of the drawn centres at 4 px/mm, which stays inside the 0.1 degree bound the
    // perfect scad renders are held to in planeId.spec.ts.
    expect(Math.abs(gray.skewDegrees)).toBeLessThanOrEqual(0.1)
    expect(Math.abs(yellow.skewDegrees)).toBeLessThanOrEqual(0.1)
  })

  it('reads the XY plane-ID from the winning binary, not a value-channel re-threshold', () => {
    expect(gray.plane).toBe('XY')
    expect(yellow.plane).toBe('XY')
  })
})
