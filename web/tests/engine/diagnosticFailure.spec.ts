// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getCv, blankBgr } from '../helpers/cv'
import { analyzeCoupon } from '../../src/engine/couponAnalyzer'
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
