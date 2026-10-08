import { describe, it, expect } from 'vitest'
import { combinePlanes } from '../../src/engine/multiPlaneCombiner'
import {
  skewCorrectionMulti,
  axisSizeCorrection,
  SCALE,
  SHRINKAGE,
  ROTATION_DISTANCE,
} from '../../src/engine/correctionFormatter'
import { defaultCouponSpec } from '../../src/engine/types'
import { alignedResult } from '../helpers/results'
import type { AlignedResult, PlaneAnalysis, Plane, ScanSetResult } from '../../src/engine/types'

function cr(x: number, y: number, skew: number): AlignedResult {
  return alignedResult({ xScalePercent: x, yScalePercent: y, skewDegrees: skew })
}
function two(x: number, y: number, skew: number): ScanSetResult {
  const c = cr(x, y, skew)
  return {
    combined: c,
    scanner: { anisotropyPercent: 0, skewDegrees: 0 },
    scans: [c, c],
    scanAnglesDegrees: [0, 90],
    angleSpreadDegrees: 90,
    rotationLooksValid: true,
    flipMismatch: false,
    failureReason: null,
    uncertainty: null,
  }
}
function plane(p: Plane, x: number, y: number, skew: number): PlaneAnalysis {
  return { plane: p, scanSet: two(x, y, skew) }
}

describe('multi-plane combine', () => {
  it('reconciles each physical axis across the plates that measured it', () => {
    // XY -> (X, Y), XZ -> (X, Z), YZ -> (Y, Z). first=xScale (marker +X), second=yScale (perp).
    const r = combinePlanes([plane('XY', 0.1, 0.2, 0), plane('XZ', 0.3, 0.4, 0), plane('YZ', 0.5, 0.6, 0)])
    const by = (a: string) => r.scales.find((s) => s.axis === a)!
    expect(by('X').scalePercent).toBeCloseTo((0.1 + 0.3) / 2, 6)
    expect(by('Y').scalePercent).toBeCloseTo((0.2 + 0.5) / 2, 6)
    expect(by('Z').scalePercent).toBeCloseTo((0.4 + 0.6) / 2, 6)
    expect(by('X').sources.sort()).toEqual(['XY', 'XZ'])
    expect(by('Z').sources.sort()).toEqual(['XZ', 'YZ'])
  })

  it('handles a partial upload (only XY)', () => {
    const r = combinePlanes([plane('XY', 0.1, 0.2, 0)])
    expect(r.scales.map((s) => s.axis)).toEqual(['X', 'Y'])
    expect(r.scales.find((s) => s.axis === 'Z')).toBeUndefined()
    expect(r.skews).toHaveLength(1)
  })
})

describe('multi-plane skew formatter', () => {
  const coupon = defaultCouponSpec()
  const skews = [
    { plane: 'XY' as Plane, skewDegrees: 0.2 },
    { plane: 'XZ' as Plane, skewDegrees: -0.1 },
    { plane: 'YZ' as Plane, skewDegrees: 0.05 },
  ]

  it('Klipper carries every plane in one SET_SKEW', () => {
    const c = skewCorrectionMulti(skews, coupon)
    expect(c.code).toContain('SET_SKEW')
    expect(c.code).toContain('XY=')
    expect(c.code).toContain('XZ=')
    expect(c.code).toContain('YZ=')
    expect(c.code).toContain('SKEW_PROFILE SAVE=ScanNTune')
  })

  it('drops an out-of-range plane and notes it', () => {
    const c = skewCorrectionMulti([{ plane: 'XY', skewDegrees: 0.2 }, { plane: 'XZ', skewDegrees: 60 }], coupon)
    expect(c.code).toContain('XY=')
    expect(c.code).not.toContain('XZ=')
    expect(c.hint).toContain('XZ')
  })
})

describe('per-axis size formatter', () => {
  const scales = [
    { axis: 'X' as const, scalePercent: -1.0, sources: ['XY' as Plane] },
    { axis: 'Y' as const, scalePercent: -2.0, sources: ['XY' as Plane] },
    { axis: 'Z' as const, scalePercent: 0.5, sources: ['XZ' as Plane] },
  ]

  it('Scale % gives a per-axis line and flags Z', () => {
    const c = axisSizeCorrection(SCALE, scales, {})
    expect(c.code).toContain('X ')
    expect(c.code).toContain('Y ')
    expect(c.code).toContain('Z ')
    expect(c.hint).toContain('Z is layer-height driven')
  })

  it('Shrinkage gives one combined XY line plus a separate Z line, with no extra note', () => {
    const c = axisSizeCorrection(SHRINKAGE, scales, {})
    expect(c.code).toContain('XY 98.50 %')
    expect(c.code).toContain('Z 100.50 %')
    expect(c.code).not.toContain('X 99.00 %')
    expect(c.code).not.toContain('Y 98.00 %')
    expect(c.hint).not.toContain('layer-height')
  })

  it('Shrinkage omits Z entirely when no Z scale was measured', () => {
    const xyOnly = scales.filter((s) => s.axis !== 'Z')
    const c = axisSizeCorrection(SHRINKAGE, xyOnly, {})
    expect(c.code).toContain('XY 98.50 %')
    expect(c.code).not.toContain('Z ')
  })

  it('Shrinkage treats a current compensation of 100 the same as the default uncompensated case', () => {
    const c = axisSizeCorrection(SHRINKAGE, scales, { XY: 100, Z: 100 })
    expect(c.code).toContain('XY 98.50 %')
    expect(c.code).toContain('Z 100.50 %')
    expect(c.hint).not.toContain('already includes')
  })

  it('Shrinkage compounds a non-default current compensation onto the measured deviation', () => {
    const c = axisSizeCorrection(SHRINKAGE, scales, { XY: 98, Z: 101 })
    expect(c.code).toContain('XY 96.53 %')
    expect(c.code).toContain('Z 101.50 %')
    expect(c.hint).toContain('already includes the compensation that was active when the plate printed')
  })

  it('Shrinkage compounds XY only when no Z scale was measured', () => {
    const xyOnly = scales.filter((s) => s.axis !== 'Z')
    const c = axisSizeCorrection(SHRINKAGE, xyOnly, { XY: 98 })
    expect(c.code).toContain('XY 96.53 %')
    expect(c.code).not.toContain('Z ')
  })

  it('Shrinkage accepts the boundary values of the plausibility band (80 and 125)', () => {
    const low = axisSizeCorrection(SHRINKAGE, scales, { XY: 80, Z: 80 })
    expect(low.code).toContain('XY')
    expect(low.code).not.toContain('check the entered compensation')
    const high = axisSizeCorrection(SHRINKAGE, scales, { XY: 125, Z: 125 })
    expect(high.code).toContain('XY')
    expect(high.code).not.toContain('check the entered compensation')
  })

  it.each([0, 79.9, 125.1, 0.98, 9800, NaN])(
    'Shrinkage refuses a present current compensation outside the plausibility band (%s)',
    (v) => {
      const c = axisSizeCorrection(SHRINKAGE, scales, { XY: v })
      expect(c.code).toBe('check the entered compensation')
      expect(c.hint).toContain('percent')
    },
  )

  it('Shrinkage treats an empty/null current compensation as 100', () => {
    const c = axisSizeCorrection(SHRINKAGE, scales, { XY: null })
    expect(c.code).toContain('XY 98.50 %')
  })

  it('An XY current has no effect on flavours other than Shrinkage', () => {
    const withXY = { XY: 98 }
    expect(axisSizeCorrection(ROTATION_DISTANCE, scales, withXY)).toEqual(
      axisSizeCorrection(ROTATION_DISTANCE, scales, {}),
    )
    expect(axisSizeCorrection(SCALE, scales, withXY)).toEqual(axisSizeCorrection(SCALE, scales, {}))
  })
})
