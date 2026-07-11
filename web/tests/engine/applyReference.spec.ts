// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { analyzeFixture } from '../helpers/cv'
import { applyReference } from '../../src/engine/couponAnalyzer'
import { alignedResult } from '../helpers/results'
import type { AlignedResult } from '../../src/engine/types'

// The per-scan pass defers the pxPerMm reference to combine time, so a DPI change re-prices a cached
// result without re-running any CV. This proves that deferral is faithful: analysing with a reference
// baked in must equal analysing reference-free and applying the same reference afterwards.
const PX_PER_MM = 23.62

let withRef: AlignedResult
let repriced: AlignedResult

beforeAll(async () => {
  withRef = await analyzeFixture([], { pxPerMm: PX_PER_MM })
  const referenceFree = await analyzeFixture([], { pxPerMm: null })
  repriced = applyReference(referenceFree, PX_PER_MM)
}, 60000)

describe('applyReference deferral', () => {
  it('reproduces the baked-in scale errors exactly', () => {
    expect(repriced.xScalePercent).toBeCloseTo(withRef.xScalePercent, 9)
    expect(repriced.yScalePercent).toBeCloseTo(withRef.yScalePercent, 9)
  })

  it('leaves the reference-independent measurements untouched', () => {
    expect(repriced.measuredPxPerMmX).toBe(withRef.measuredPxPerMmX)
    expect(repriced.skewDegrees).toBe(withRef.skewDegrees)
  })
})

// A per-axis (CCD) reference is fixed to the glass while the coupon lies at any angle, so each
// coupon axis must be priced against the reference's effective px/mm along that axis's image
// direction: |u| / |S^-1 u| for S = diag(horizontal, vertical).
describe('applyReference with a per-axis (CCD) reference', () => {
  const H = 23.86 // horizontal px/mm (sensor axis, card-corrected)
  const V = 23.622 // vertical px/mm (carriage axis, nominal 600 dpi)
  const ref = { horizontal: H, vertical: V }

  function scanAt(angleDegrees: number, mX: number, mY: number): AlignedResult {
    const rad = (angleDegrees * Math.PI) / 180.0
    return applyReference(
      alignedResult({
        measuredPxPerMmX: mX,
        measuredPxPerMmY: mY,
        orientation: {
          flipped: false,
          originX: 0,
          originY: 0,
          xAxisX: Math.cos(rad),
          xAxisY: Math.sin(rad),
        },
      }),
      ref,
    )
  }

  it('prices the axes by the axis figures when the coupon lies square on the glass', () => {
    const r = scanAt(0, H, V)
    expect(r.xScalePercent).toBeCloseTo(0, 9)
    expect(r.yScalePercent).toBeCloseTo(0, 9)
  })

  it('swaps the axis figures when the coupon lies a quarter turn on the glass', () => {
    const r = scanAt(90, V, H)
    expect(r.xScalePercent).toBeCloseTo(0, 9)
    expect(r.yScalePercent).toBeCloseTo(0, 9)
  })

  it('prices an angled coupon along each axis direction', () => {
    const rad = (30 * Math.PI) / 180.0
    const alongX = 1 / Math.hypot(Math.cos(rad) / H, Math.sin(rad) / V)
    const alongY = 1 / Math.hypot(-Math.sin(rad) / H, Math.cos(rad) / V)
    // A printer 0.5% oversize on X, exact on Y, seen through the anisotropic scanner at 30 degrees.
    const r = scanAt(30, alongX * 1.005, alongY)
    expect(r.xScalePercent).toBeCloseTo(0.5, 9)
    expect(r.yScalePercent).toBeCloseTo(0, 9)
  })

  it('rejects a non-positive axis figure', () => {
    expect(() => applyReference(alignedResult(), { horizontal: 0, vertical: 23 })).toThrow(/positive/)
    expect(() => applyReference(alignedResult(), { horizontal: 23, vertical: -1 })).toThrow(/positive/)
  })
})
