// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { decodeFlowGoldenJpgBgr, getCv } from '../../helpers/cv'
import { alignPaCoupon } from '../../../src/engine/pa/fiducialAligner'
import { analyzePaCoupon } from '../../../src/engine/pa/paAnalyzer'
import { defaultPaTestSpec } from '../../../src/engine/pa/types'

// Regression test over the golden real flatbed scan of a printed PA coupon
// (web/e2e/pressure-advance/golden/pa_micron_asa.jpg; default spec: 16 lines, PA 0 to 0.06).
// EXPECTED_PA is what the pipeline measured when the golden was captured (see the golden's
// PROVENANCE.md); the tolerance is one sweep step (0.06 / 15 = 0.004), a regression bound. The
// owner's truth band for this printer and filament (0.024 to 0.032) is asserted independently, so
// a drift that stays within the step but leaves the physically plausible band still fails.
const EXPECTED_PA = 0.0309
const SWEEP_STEP = 0.004
const TRUTH_BAND: [number, number] = [0.024, 0.032]

describe('real-scan PA regression', () => {
  it(
    'aligns and recovers a stable PA from the golden coupon scan',
    async () => {
      const cv = await getCv()
      const spec = defaultPaTestSpec()
      const bgr = decodeFlowGoldenJpgBgr(cv, 'pressure-advance', 'pa_micron_asa.jpg')
      try {
        const alignment = alignPaCoupon(cv, bgr, spec)
        expect(alignment.success).toBe(true)
        expect(alignment.flipped).toBe(true)
        expect(alignment.rotationQuarterTurns).toBe(0)

        const started = Date.now()
        const r = analyzePaCoupon(cv, bgr, spec)
        const elapsedMs = Date.now() - started
        // Guard against a reintroduced per-pixel kernel regression: the 35 MP scan must
        // analyze well under two minutes even on slow CI.
        expect(elapsedMs).toBeLessThan(120000)

        expect(r.success).toBe(true)
        expect(r.lines).toHaveLength(spec.lineCount)
        // Every line must yield a usable width profile (a majority of finite width samples).
        for (const line of r.lines) expect(line.measured).toBe(true)

        expect(Number.isFinite(r.bestPa)).toBe(true)
        const bestPa = r.bestPa as number
        expect(Math.abs(bestPa - EXPECTED_PA)).toBeLessThan(SWEEP_STEP)
        expect(bestPa).toBeGreaterThanOrEqual(TRUTH_BAND[0])
        expect(bestPa).toBeLessThanOrEqual(TRUTH_BAND[1])

        expect(r.sweepBracket).toBe('bracketed')
        expect(r.sePa).not.toBeNull()
        expect(Number.isFinite(r.sePa!)).toBe(true)
        expect(r.sePa!).toBeGreaterThan(0)
      } finally {
        bgr.delete()
      }
    },
    180000,
  )
})
