// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest'
import { decodeJpgFixtureBgr, getCv } from '../../helpers/cv'
import { analyzeEmCoupon } from '../../../src/engine/em/emAnalyzer'
import type { EmResult } from '../../../src/engine/em/emAnalyzer'
import { defaultEmTestSpec } from '../../../src/engine/em/types'
import { defaultPrinterProfile } from '../../../src/engine/pa/types'

// Regression anchors for the colored-coupon measurement-channel fix, over two real 600 dpi
// JPEG scans of the same-model flow coupon (default spec: pitch 0.70 to 1.10 mm, 13 blocks,
// 7 lines per block, nominal width 0.42 mm) printed in colored filament:
// - em_real_yellow_white.jpg: a yellow coupon on white paper. Before the fix this scan failed
//   with a backdrop-contrast refusal, because the plastic and the paper match in the value
//   channel; only the saturation channel separates them.
// - em_real_orange_teal.jpg: an orange coupon on a wrinkled teal paper sheet. Before the fix
//   this scan failed alignment entirely, and then needed the chromaticity discriminant: value
//   and saturation both lack contrast, only hue separates the classes, and the separator lamp
//   shadow breaks a raw-color discriminant.
// The scanner's calibrated resolution is 23.622 px/mm (600 dpi nominal). The bounds are
// physical sanity checks, not tuned targets.
const SCAN_PX_PER_MM = 23.622

describe('real-scan EM regression, colored coupons on colored backings', () => {
  let rWhite: EmResult
  let rTeal: EmResult

  beforeAll(async () => {
    const cv = await getCv()
    const spec = defaultEmTestSpec(defaultPrinterProfile())
    const bgrWhite = decodeJpgFixtureBgr(cv, 'em/em_real_yellow_white.jpg')
    try {
      rWhite = analyzeEmCoupon(cv, bgrWhite, spec, SCAN_PX_PER_MM)
    } finally {
      bgrWhite.delete()
    }
    const bgrTeal = decodeJpgFixtureBgr(cv, 'em/em_real_orange_teal.jpg')
    try {
      rTeal = analyzeEmCoupon(cv, bgrTeal, spec, SCAN_PX_PER_MM)
    } finally {
      bgrTeal.delete()
    }
  }, 240000)

  it(
    'measures the yellow coupon against the white backing it is invisible to in brightness',
    () => {
      expect(rWhite.failureReason).toBeNull()
      expect(rWhite.success).toBe(true)

      expect(rWhite.blocksMeasured).toBeGreaterThanOrEqual(24)

      // Physical sanity for a 0.42 mm nominal print, the same band as the existing real-scan
      // spec, not a tuned target. Observed 0.4256 mm at the regression baseline.
      expect(rWhite.wMm as number).toBeGreaterThanOrEqual(0.38)
      expect(rWhite.wMm as number).toBeLessThanOrEqual(0.47)

      // Separator cross-check residual; observed 0.0014 mm at the regression baseline.
      expect(Math.abs(rWhite.biasMm as number)).toBeLessThanOrEqual(0.02)
    },
    240000,
  )

  it(
    'measures the orange coupon against the wrinkled teal backing that matches it in brightness and saturation',
    () => {
      expect(rTeal.failureReason).toBeNull()
      expect(rTeal.success).toBe(true)

      expect(rTeal.blocksMeasured).toBeGreaterThanOrEqual(24)

      // Same physical-sanity band as above. Observed 0.4100 mm at the regression baseline.
      expect(rTeal.wMm as number).toBeGreaterThanOrEqual(0.38)
      expect(rTeal.wMm as number).toBeLessThanOrEqual(0.47)

      // Observed 0.0113 mm at the regression baseline; a wrong-channel or shadow-broken
      // discriminant regression shows up as a much larger separator residual or an outright
      // failure.
      expect(Math.abs(rTeal.biasMm as number)).toBeLessThanOrEqual(0.02)
    },
    240000,
  )

  it(
    'recovers the same bead width from the two backdrops within the cross-backdrop bias budget',
    () => {
      // Observed disagreement 0.0156 mm, backdrop-dependent edge bias that the separator
      // cross-check prices in; a channel-selection regression moves one scan by far more or
      // fails it outright.
      expect(
        Math.abs((rWhite.wMm as number) - (rTeal.wMm as number)),
      ).toBeLessThanOrEqual(0.025)
    },
    240000,
  )

  it(
    'reports the hand placement of both scans in degrees',
    () => {
      // Both coupons were hand-placed square; observed -1.19 and -1.12 degrees.
      expect(Math.abs(rWhite.rotationDegrees)).toBeLessThanOrEqual(3.0)
      expect(Math.abs(rTeal.rotationDegrees)).toBeLessThanOrEqual(3.0)

      expect(rWhite.rotationQuarterTurns).toBe(0)
      expect(rTeal.rotationQuarterTurns).toBe(0)

      expect(rWhite.flipped).toBe(true)
      expect(rTeal.flipped).toBe(true)
    },
    240000,
  )
})
