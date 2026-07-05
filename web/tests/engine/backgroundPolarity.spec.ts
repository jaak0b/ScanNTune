// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getCv, decodeFixtureBgr, decodeE2eFixtureBgr } from '../helpers/cv'
import { analyzeCoupon } from '../../src/engine/couponAnalyzer'
import { defaultCouponSpec } from '../../src/engine/types'

// The threshold polarity (is the part brighter or darker than what's behind it?) must not be guessed
// from the image border: a backing sheet that doesn't cover the scan bed leaves bright lid margins on
// the border, which flipped the mask and made the detector return dust specks instead of holes. Both
// polarities are tried and validated against the coupon grid; a scan where neither fits reports why.

describe('background polarity resolution', () => {
  it.each(['realxy-0.png', 'realxy-90.png'])(
    'aligns the real scan with bright lid margins (%s)',
    async (name) => {
      const cv = await getCv()
      const image = decodeE2eFixtureBgr(cv, name)
      try {
        const result = analyzeCoupon(cv, image, { coupon: defaultCouponSpec(), pxPerMm: null })
        expect(result.aligned).toBe(true)
        expect(result.ringsDetected).toBe(23)
        // The scanner is ~23.6 px/mm (measured via the card); the fit must land in that ballpark.
        expect(result.measuredPxPerMmX).toBeGreaterThan(23.0)
        expect(result.measuredPxPerMmX).toBeLessThan(24.2)
        expect(result.measuredPxPerMmY).toBeGreaterThan(23.0)
        expect(result.measuredPxPerMmY).toBeLessThan(24.2)
      } finally {
        image.delete()
      }
    },
    120000,
  )

  it('aligns the synthetic fixture in both polarities', async () => {
    const cv = await getCv()
    const original = decodeFixtureBgr(cv, 'TestData_2solid.png')
    const inverted = new cv.Mat()
    cv.bitwise_not(original, inverted)
    try {
      for (const image of [original, inverted]) {
        const result = analyzeCoupon(cv, image, { coupon: defaultCouponSpec(), pxPerMm: null })
        expect(result.aligned).toBe(true)
        expect(result.ringsDetected).toBe(23)
      }
    } finally {
      original.delete()
      inverted.delete()
    }
  })

  it('aligns the fixture when a bright margin dominates the image border', async () => {
    const cv = await getCv()
    const coupon = decodeFixtureBgr(cv, 'TestData_2solid.png')
    // Simulate the failing scans: dark backing sheet that stops short of the scan edge, bright
    // scanner-lid margin around it. The old border-mean polarity guess flips on this.
    const inverted = new cv.Mat()
    cv.bitwise_not(coupon, inverted) // bright part on dark background
    const padded = new cv.Mat()
    const m = Math.round(coupon.cols * 0.4)
    cv.copyMakeBorder(inverted, padded, m, m, m, m, cv.BORDER_CONSTANT, new cv.Scalar(250, 250, 250, 255))
    try {
      const result = analyzeCoupon(cv, padded, { coupon: defaultCouponSpec(), pxPerMm: null })
      expect(result.aligned).toBe(true)
      expect(result.ringsDetected).toBe(23)
    } finally {
      coupon.delete()
      inverted.delete()
      padded.delete()
    }
  })

  it('reports a failure reason when no coupon fits either polarity', async () => {
    const cv = await getCv()
    const blank = new cv.Mat(800, 600, cv.CV_8UC3, new cv.Scalar(255, 255, 255, 255))
    try {
      const result = analyzeCoupon(cv, blank, { coupon: defaultCouponSpec(), pxPerMm: null })
      expect(result.aligned).toBe(false)
      expect(result.failureReason).toBeTruthy()
    } finally {
      blank.delete()
    }
  })

  it('leaves failureReason null on an aligned scan', async () => {
    const cv = await getCv()
    const image = decodeFixtureBgr(cv, 'TestData_2solid.png')
    try {
      const result = analyzeCoupon(cv, image, { coupon: defaultCouponSpec(), pxPerMm: null })
      expect(result.aligned).toBe(true)
      expect(result.failureReason).toBeNull()
    } finally {
      image.delete()
    }
  })
})
