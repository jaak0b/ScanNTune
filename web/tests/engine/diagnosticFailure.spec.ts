// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getCv, blankBgr } from '../helpers/cv'
import { alignmentFailureReason, analyzeCoupon } from '../../src/engine/couponAnalyzer'
import { defaultCouponSpec } from '../../src/engine/types'

// A scan that can't be aligned is a normal outcome, not an exception: analyzeCoupon returns a result
// with the detection carried and the measurement null, so the UI can show what it found.
describe('unalignable scan', () => {
  it('a blank scan returns an unaligned result, not a throw', async () => {
    const cv = await getCv()
    const blank = blankBgr(cv, 600)
    try {
      const result = analyzeCoupon(cv, blank, { coupon: defaultCouponSpec() })
      expect(result.aligned).toBe(false)
      expect(result.orientation).toBeNull()
      expect(result.xScalePercent).toBeNull()
      expect(result.rings).toBeDefined()
      expect(result.ringsExpected).toBe(23)
    } finally {
      blank.delete()
    }
  }, 60000)
})

// The two failure wordings: under-detection counts the missing rings; over-detection (more
// ring-like shapes than the declared coupon can produce) points at the background instead of
// claiming a nonsensical "350 of 23".
describe('alignment failure wording', () => {
  it('under-detection names the shortfall', () => {
    expect(alignmentFailureReason(5, 23)).toBe(
      'The coupon pattern was not found: only 5 of its 23 measurement rings were detected. ' +
        'Make sure the whole coupon lies inside the scan area on a plain, single-colour ' +
        'background, then scan again.',
    )
  })

  it('over-detection points at the background', () => {
    expect(alignmentFailureReason(350, 23)).toBe(
      'The coupon could not be told apart from the background: 350 ring-like shapes were ' +
        'detected where the coupon has only 23 measurement rings. Scan it again on a plain, ' +
        'single-colour background.',
    )
  })
})
