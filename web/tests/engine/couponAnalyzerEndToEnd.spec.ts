// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { analyzeFixture } from '../helpers/cv'
import type { AlignedResult } from '../../src/engine/types'

// Mirrors ScanNTune.Tests/CouponAnalyzerEndToEndTests.cs against the perfect coupon render.
let result: AlignedResult
let plain: AlignedResult

beforeAll(async () => {
  result = await analyzeFixture([])
  plain = await analyzeFixture([], undefined, { robust: false })
}, 60000)

describe('coupon analyzer end to end', () => {
  it('detects the full ring grid (23 holes)', () => {
    expect(result.ringsDetected).toBe(23)
  })

  it('perfect render has zero skew', () => {
    expect(Math.abs(result.skewDegrees)).toBeLessThanOrEqual(0.05)
  })

  it('perfect render is isotropic', () => {
    expect(Math.abs(result.xScalePercent - result.yScalePercent)).toBeLessThanOrEqual(0.1)
  })

  it('scale errors are near zero', () => {
    expect(Math.abs(result.xScalePercent)).toBeLessThanOrEqual(0.1)
    expect(Math.abs(result.yScalePercent)).toBeLessThanOrEqual(0.1)
  })

  it('affine fit is tight', () => {
    expect(result.rmsResidualPx).toBeLessThan(0.5)
  })

  it('robust default agrees with plain least squares on the fixture', () => {
    expect(Math.abs(result.xScalePercent - plain.xScalePercent)).toBeLessThanOrEqual(0.05)
    expect(Math.abs(result.yScalePercent - plain.yScalePercent)).toBeLessThanOrEqual(0.05)
    expect(Math.abs(result.skewDegrees - plain.skewDegrees)).toBeLessThanOrEqual(0.05)
  })
})
