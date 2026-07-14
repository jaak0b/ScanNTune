// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest'
import { decodeJpgFixtureBgr, getCv } from '../../helpers/cv'
import { analyzeEmCoupon } from '../../../src/engine/em/emAnalyzer'
import type { EmResult } from '../../../src/engine/em/emAnalyzer'
import { printedEmSpec } from '../../helpers/emPrintedSpec'

// Regression tests over a user-contributed pair of real 600 dpi JPEG scans of the SAME
// black-on-white flow coupon, analyzed under the spec it was printed with (pitch 0.70 to
// 1.10 mm, 13 blocks, 7 lines per block, nominal width 0.42 mm; see printedEmSpec),
// scanned in two placements: once as laid on the glass and
// once turned a quarter turn. The scanner's calibrated resolution is 23.622 px/mm
// (600 dpi nominal). The bounds are physical sanity checks, not tuned targets.
const SCAN_PX_PER_MM = 23.622

describe('real-scan EM regression, black coupon scanned in two placements', () => {
  let r0: EmResult
  let r90: EmResult

  beforeAll(async () => {
    const cv = await getCv()
    const spec = printedEmSpec()
    const bgr0 = decodeJpgFixtureBgr(cv, 'em/em_real_black_0deg.jpg')
    try {
      r0 = analyzeEmCoupon(cv, bgr0, spec, SCAN_PX_PER_MM)
    } finally {
      bgr0.delete()
    }
    const bgr90 = decodeJpgFixtureBgr(cv, 'em/em_real_black_90deg.jpg')
    try {
      r90 = analyzeEmCoupon(cv, bgr90, spec, SCAN_PX_PER_MM)
    } finally {
      bgr90.delete()
    }
  }, 180000)

  it(
    'measures a plausible bead width on each placement of the real black coupon scan',
    () => {
      expect(r0.failureReason).toBeNull()
      expect(r0.success).toBe(true)
      expect(r90.failureReason).toBeNull()
      expect(r90.success).toBe(true)

      expect(r0.blocksMeasured).toBeGreaterThanOrEqual(20)
      expect(r90.blocksMeasured).toBeGreaterThanOrEqual(20)

      // Physical sanity for a 0.42 mm nominal print read through JPEG edge ringing, not a
      // tuned target. Observed 0.4378 and 0.4495 mm at the regression baseline.
      expect(r0.wMm as number).toBeGreaterThanOrEqual(0.40)
      expect(r0.wMm as number).toBeLessThanOrEqual(0.49)
      expect(r90.wMm as number).toBeGreaterThanOrEqual(0.40)
      expect(r90.wMm as number).toBeLessThanOrEqual(0.49)

      // The printer's axis scale is within a fraction of a percent; observed 0.9865/0.9867.
      expect(r0.pitchScale as number).toBeGreaterThanOrEqual(0.975)
      expect(r0.pitchScale as number).toBeLessThanOrEqual(1.005)
      expect(r90.pitchScale as number).toBeGreaterThanOrEqual(0.975)
      expect(r90.pitchScale as number).toBeLessThanOrEqual(1.005)
    },
    180000,
  )

  it(
    'recovers the same bead width from both placements of the same print',
    () => {
      // The two placements carry opposite lamp-shadow signs and JPEG ringing; the observed
      // disagreement is 0.012 mm. A real regression (wrong channel, biased edges, broken
      // orientation handling) shifts w by well over 0.02 mm.
      expect(Math.abs((r0.wMm as number) - (r90.wMm as number))).toBeLessThanOrEqual(0.02)
    },
    180000,
  )

  it(
    'flags the lamp shadow and mirrored placement on both scans',
    () => {
      expect(r0.shadowWarning).toBe(true)
      expect(r90.shadowWarning).toBe(true)

      expect(r0.flipped).toBe(true)
      expect(r90.flipped).toBe(true)

      expect(r0.rotationQuarterTurns).toBe(2)
      expect(r90.rotationQuarterTurns).toBe(0)

      // Placement tilt tolerance: the coupon was hand-placed square. rotationDegrees is
      // signed; observed -179.67 and 0.02 degrees, so compare the magnitude.
      expect(Math.abs(Math.abs(r0.rotationDegrees) - 180)).toBeLessThanOrEqual(1.0)
      expect(Math.abs(r90.rotationDegrees)).toBeLessThanOrEqual(1.0)
    },
    180000,
  )
})
