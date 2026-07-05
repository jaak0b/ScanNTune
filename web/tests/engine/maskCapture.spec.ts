// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getCv, decodeFixtureBgr } from '../helpers/cv'
import { detectRingsDual } from '../../src/engine/ringDetector'
import { analyzeCoupon } from '../../src/engine/couponAnalyzer'
import { defaultCouponSpec } from '../../src/engine/types'
import type { Mat } from '../../src/engine/opencv'

// The Scan/Threshold toggle shows the binary mask the detector searched. The detector hands back one
// mask per polarity on request; the analyzer keeps the one that fit the grid and frees the other.
describe('threshold mask capture', () => {
  it('captures a full-frame single-channel mask per polarity alongside the rings', async () => {
    const cv = await getCv()
    const image = decodeFixtureBgr(cv, 'TestData_2solid.png')
    const masks: { bright?: Mat; dark?: Mat } = {}
    try {
      const detected = detectRingsDual(cv, image, undefined, undefined, masks)
      // One hypothesis is the part, the other is noise: the ring set rides on exactly one of them.
      expect(Math.max(detected.bright.length, detected.dark.length)).toBe(23)
      for (const mask of [masks.bright, masks.dark]) {
        expect(mask).toBeDefined()
        expect(mask!.rows).toBe(image.rows)
        expect(mask!.cols).toBe(image.cols)
        expect(mask!.channels()).toBe(1)
      }
    } finally {
      masks.bright?.delete()
      masks.dark?.delete()
      image.delete()
    }
  }, 60000)

  it('analyzeCoupon hands back exactly the fitting polarity mask', async () => {
    const cv = await getCv()
    const image = decodeFixtureBgr(cv, 'TestData_2solid.png')
    const maskHolder: { mask?: Mat } = {}
    try {
      const result = analyzeCoupon(
        cv,
        image,
        { coupon: defaultCouponSpec(), pxPerMm: null },
        undefined,
        maskHolder,
      )
      expect(result.aligned).toBe(true)
      expect(maskHolder.mask).toBeDefined()
      expect(maskHolder.mask!.rows).toBe(image.rows)
      expect(maskHolder.mask!.cols).toBe(image.cols)
      expect(maskHolder.mask!.channels()).toBe(1)
    } finally {
      maskHolder.mask?.delete()
      image.delete()
    }
  }, 60000)
})
