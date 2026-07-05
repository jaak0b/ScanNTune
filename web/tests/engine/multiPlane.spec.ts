import { describe, it, expect } from 'vitest'
import { combinePlanes } from '../../src/engine/multiPlaneCombiner'
import {
  skewCorrectionMulti,
  axisSizeCorrection,
  KLIPPER,
  MARLIN,
  REPRAP,
  SCALE,
  SHRINKAGE,
} from '../../src/engine/correctionFormatter'
import { defaultCouponSpec } from '../../src/engine/types'
import { alignedResult } from '../helpers/results'
import type { AlignedResult, PlaneAnalysis, Plane, TwoScanResult } from '../../src/engine/types'

function cr(x: number, y: number, skew: number): AlignedResult {
  return alignedResult({ xScalePercent: x, yScalePercent: y, skewDegrees: skew })
}
function two(x: number, y: number, skew: number): TwoScanResult {
  const c = cr(x, y, skew)
  return {
    combined: c,
    scanner: { anisotropyPercent: 0, skewDegrees: 0 },
    scanA: c,
    scanB: c,
    relativeRotationDegrees: 90,
    rotationLooksValid: true,
    flipMismatch: false,
  }
}
function plane(p: Plane, x: number, y: number, skew: number): PlaneAnalysis {
  return { plane: p, twoScan: two(x, y, skew) }
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
    const c = skewCorrectionMulti(KLIPPER, skews, coupon)
    expect(c.code).toContain('SET_SKEW')
    expect(c.code).toContain('XY=')
    expect(c.code).toContain('XZ=')
    expect(c.code).toContain('YZ=')
    expect(c.code).toContain('SKEW_PROFILE SAVE=ScanNTune')
  })

  it('Marlin uses I/J/K per plane', () => {
    const c = skewCorrectionMulti(MARLIN, skews, coupon)
    expect(c.code).toMatch(/^M852 I-?\d/)
    expect(c.code).toContain(' J')
    expect(c.code).toContain(' K')
    expect(c.code).toContain('M500')
  })

  it('RRF maps XY->X, XZ->Z, YZ->Y', () => {
    const c = skewCorrectionMulti(REPRAP, skews, coupon)
    expect(c.code).toContain('M556 S100')
    expect(c.code).toMatch(/ X-?\d/)
    expect(c.code).toMatch(/ Z-?\d/)
    expect(c.code).toMatch(/ Y-?\d/)
  })

  it('drops an out-of-range plane and notes it', () => {
    const c = skewCorrectionMulti(MARLIN, [{ plane: 'XY', skewDegrees: 0.2 }, { plane: 'XZ', skewDegrees: 60 }], coupon)
    expect(c.code).toContain('I')
    expect(c.code).not.toContain('J')
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

  it('Shrinkage uses only X and Y', () => {
    const c = axisSizeCorrection(SHRINKAGE, scales, {})
    expect(c.code).toContain('XY shrinkage')
    // average of -1% and -2% => 0.985 factor => 98.50 %
    expect(c.code).toContain('98.50')
  })
})
