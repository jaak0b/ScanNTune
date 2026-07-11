// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { decodeE2eFixtureBgr, getCv } from '../../helpers/cv'
import { alignEmCoupon } from '../../../src/engine/em/fiducialAligner'
import { analyzeEmCoupon } from '../../../src/engine/em/emAnalyzer'
import { defaultEmTestSpec } from '../../../src/engine/em/types'
import { defaultPrinterProfile } from '../../../src/engine/pa/types'

// Regression test over a real 600 dpi flatbed scan of a printed EM coupon (default spec:
// pitch 0.70 to 1.10 mm, 13 blocks, 7 lines per block, nominal width 0.42 mm). The scanner's
// calibrated resolution is 23.622 px/mm (600 dpi nominal). The bounds are physical sanity
// checks, not tuned targets.
const SCAN_PX_PER_MM = 23.622

describe('real-scan EM regression', () => {
  it(
    'aligns and recovers a plausible bead width from the real coupon scan',
    async () => {
      const cv = await getCv()
      const spec = defaultEmTestSpec(defaultPrinterProfile())
      const bgr = decodeE2eFixtureBgr(cv, 'em_real_scan.png')
      try {
        const alignment = alignEmCoupon(cv, bgr, spec)
        expect(alignment.success).toBe(true)

        const r = analyzeEmCoupon(cv, bgr, spec, SCAN_PX_PER_MM)
        expect(r.failureReason).toBeNull()
        expect(r.success).toBe(true)

        expect(r.wMm).not.toBeNull()
        expect(r.wMm as number).toBeGreaterThanOrEqual(0.38)
        expect(r.wMm as number).toBeLessThanOrEqual(0.47)

        expect(r.biasMm).not.toBeNull()
        expect(Math.abs(r.biasMm as number)).toBeLessThanOrEqual(0.06)

        // This scan was made with the beads running along the lamp axis, where the one-sided
        // penumbra does not fall across the gaps, so no shadow warning and a near-zero asymmetry.
        expect(r.flankAsymmetryMm).not.toBeNull()
        expect(Math.abs(r.flankAsymmetryMm as number)).toBeLessThanOrEqual(0.005)
        expect(r.shadowWarning).toBe(false)

        expect(r.blocksMeasured).toBeGreaterThanOrEqual(20)

        expect(r.pitchScale).not.toBeNull()
        expect(r.pitchScale as number).toBeGreaterThanOrEqual(0.99)
        expect(r.pitchScale as number).toBeLessThanOrEqual(1.01)
      } finally {
        bgr.delete()
      }
    },
    180000,
  )
})
