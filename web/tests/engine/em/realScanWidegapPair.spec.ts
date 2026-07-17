// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest'
import { decodeGoldenJpgBgr, getCv } from '../../helpers/cv'
import { analyzeEmCoupon, analyzeEmCoupons } from '../../../src/engine/em/emAnalyzer'
import type { EmResult } from '../../../src/engine/em/emAnalyzer'
import { defaultEmTestSpec } from '../../../src/engine/em/types'
import { defaultPrinterProfile } from '../../../src/engine/pa/types'

// Regression tests over the owner's real 600 dpi JPEG scans of the current wide-gap flow
// coupon (default spec of a fresh printer profile: pitch 1.14 to 1.35 mm, 9 blocks of 5
// lines per row, nominal line width 0.42 mm), scanned twice: once as laid on the glass and
// once rotated 180 degrees, the paired placement the flow supports to cancel one-sided
// scanner-lamp shading. The fixtures are the byte-for-byte golden copies shared with the
// Playwright flow suite (web/e2e/flow/golden, see its PROVENANCE.md). The scanner's
// calibrated resolution is 23.622 px/mm (600 dpi nominal). The bounds are physical sanity
// bands around the owner-reviewed baseline, not tuned targets.
const SCAN_PX_PER_MM = 23.622

describe('real-scan EM regression, wide-gap coupon scanned at 0 and 180 degrees', () => {
  let r0: EmResult
  let r180: EmResult
  let rPair: EmResult

  beforeAll(async () => {
    const cv = await getCv()
    const spec = defaultEmTestSpec(defaultPrinterProfile())
    const m0 = decodeGoldenJpgBgr(cv, 'em_widegap_0d_600dpi_black_white.jpg')
    const m180 = decodeGoldenJpgBgr(cv, 'em_widegap_180d_600dpi_black_white.jpg')
    try {
      r0 = analyzeEmCoupon(cv, m0, spec, SCAN_PX_PER_MM)
      r180 = analyzeEmCoupon(cv, m180, spec, SCAN_PX_PER_MM)
      rPair = analyzeEmCoupons(cv, [m0, m180], spec, SCAN_PX_PER_MM)
    } finally {
      m0.delete()
      m180.delete()
    }
  }, 300000)

  it('measures every block on each placement of the wide-gap coupon', () => {
    expect(r0.failureReason).toBeNull()
    expect(r0.success).toBe(true)
    expect(r180.failureReason).toBeNull()
    expect(r180.success).toBe(true)

    // 9 blocks x 2 rows per scan; both scans align and no block is dropped.
    expect(r0.blocksMeasured).toBe(18)
    expect(r180.blocksMeasured).toBe(18)
  })

  it('recovers a plausible bead width on each placement', () => {
    // Physical sanity band around the owner-reviewed baseline for a 0.42 mm nominal print
    // (observed 0.4199 and 0.4223 mm); a channel or edge-bias regression moves w far more.
    expect(r0.wMm as number).toBeGreaterThanOrEqual(0.41)
    expect(r0.wMm as number).toBeLessThanOrEqual(0.43)
    expect(r180.wMm as number).toBeGreaterThanOrEqual(0.41)
    expect(r180.wMm as number).toBeLessThanOrEqual(0.43)

    // The two placements carry opposite lamp-shading signs; observed disagreement 0.0024 mm.
    // A broken orientation handling or one-sided edge bias shifts it well over 0.01 mm.
    expect(Math.abs((r0.wMm as number) - (r180.wMm as number))).toBeLessThanOrEqual(0.01)
  })

  it('pools the pair into the combined estimate', () => {
    expect(rPair.failureReason).toBeNull()
    expect(rPair.success).toBe(true)
    expect(rPair.blocksMeasured).toBe(36)

    // Owner-reviewed baseline 0.4211 mm, within the PROVENANCE band of 0.01 mm.
    expect(rPair.wMm as number).toBeGreaterThanOrEqual(0.4111)
    expect(rPair.wMm as number).toBeLessThanOrEqual(0.4311)

    // Between-block standard error of the pooled pair; observed 0.0014 mm. A regression in
    // the sample cleaning or pooling inflates it well past 0.005 mm.
    expect(rPair.seMm as number).toBeLessThanOrEqual(0.005)

    // Separator cross-check residual; observed 0.0032 mm on the JPEG goldens.
    expect(Math.abs(rPair.biasMm as number)).toBeLessThanOrEqual(0.006)

    // Beads run along the lamp axis on this capture, so no shadow warning and a small
    // flank asymmetry (observed 0.0027 mm).
    expect(rPair.shadowWarning).toBe(false)
    expect(Math.abs(rPair.flankAsymmetryMm as number)).toBeLessThanOrEqual(0.01)

    // Printer X-scale diagnostic; observed 0.9956 with per-scan values 0.9958 and 0.9954.
    expect(rPair.pitchScale as number).toBeGreaterThanOrEqual(0.99)
    expect(rPair.pitchScale as number).toBeLessThanOrEqual(1.0)
  })

  it('reports each placement orientation from the scan diagnostics', () => {
    expect(r0.flipped).toBe(true)
    expect(r180.flipped).toBe(true)

    expect(r0.rotationQuarterTurns).toBe(0)
    expect(r180.rotationQuarterTurns).toBe(2)

    // Hand-placed square; rotationDegrees is signed (observed -0.15 and 179.74 degrees),
    // so compare the magnitude of the tilt around the nearest quarter turn.
    expect(Math.abs(r0.rotationDegrees)).toBeLessThanOrEqual(1.0)
    expect(Math.abs(Math.abs(r180.rotationDegrees) - 180)).toBeLessThanOrEqual(1.0)
  })
})
