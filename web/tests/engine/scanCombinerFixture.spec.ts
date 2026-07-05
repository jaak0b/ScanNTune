// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getCv, decodeFixtureBgr, stretchX, rotate } from '../helpers/cv'
import { analyzeCoupon } from '../../src/engine/couponAnalyzer'
import { combineScans } from '../../src/engine/scanCombiner'
import { asAligned, defaultCouponSpec } from '../../src/engine/types'
import type { Mat, OpenCv } from '../../src/engine/opencv'

// Mirrors ScanNTune.Tests/ScanCombinerTests.cs. The scanner reads +3% along its X axis (applied to
// both scans in the bed frame); a quarter-turn cancels it, same-orientation does not.
const ScannerXStretch = 1.03

function analyze(cv: OpenCv, image: Mat) {
  return asAligned(analyzeCoupon(cv, image, { coupon: defaultCouponSpec() }))
}

describe('scan combiner (fixture)', () => {
  it('combining quarter-turn scans cancels scanner anisotropy', async () => {
    const cv = await getCv()
    const original = decodeFixtureBgr(cv, 'TestData_2solid.png')
    const aImg = stretchX(cv, original, ScannerXStretch)
    const rotated = rotate(cv, original, 90)
    const bImg = stretchX(cv, rotated, ScannerXStretch)
    try {
      const a = analyze(cv, aImg)
      const b = analyze(cv, bImg)
      const combined = combineScans(a, b)

      expect(Math.abs(a.xScalePercent - a.yScalePercent)).toBeGreaterThan(1.5)
      const printerAniso = combined.combined.xScalePercent - combined.combined.yScalePercent
      expect(Math.abs(printerAniso)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(Math.abs(combined.scanner.anisotropyPercent) - 3.0)).toBeLessThanOrEqual(0.6)
      expect(combined.rotationLooksValid).toBe(true)
    } finally {
      original.delete()
      aImg.delete()
      rotated.delete()
      bImg.delete()
    }
  }, 60000)

  it('same orientation twice is flagged invalid', async () => {
    const cv = await getCv()
    const o1 = decodeFixtureBgr(cv, 'TestData_2solid.png')
    const a1 = stretchX(cv, o1, ScannerXStretch)
    const o2 = decodeFixtureBgr(cv, 'TestData_2solid.png')
    const a2 = stretchX(cv, o2, ScannerXStretch)
    try {
      const combined = combineScans(analyze(cv, a1), analyze(cv, a2))
      expect(combined.rotationLooksValid).toBe(false)
    } finally {
      o1.delete()
      a1.delete()
      o2.delete()
      a2.delete()
    }
  }, 60000)
})
