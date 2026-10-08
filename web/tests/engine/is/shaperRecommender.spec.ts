// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  SHAPER_TYPES,
  formatKlipperShaper,
  modeSpectrum,
  recommendShapers,
  recommendShapersForModes,
  residualVibration,
  shaperImpulses,
  shaperMaxAccel,
  shaperSmoothingMm,
  worstBandResidual,
} from '../../../src/engine/is/shaperRecommender'

describe('shaperImpulses', () => {
  it('impulse amplitudes are positive with strictly increasing times for every type', () => {
    for (const type of SHAPER_TYPES) {
      const { amplitudes, timesS } = shaperImpulses(type, 50, 0.1)
      // Amplitudes are unnormalized (the residual formula divides by their sum).
      expect(amplitudes.reduce((a, b) => a + b, 0)).toBeGreaterThan(0.5)
      for (const a of amplitudes) expect(a).toBeGreaterThan(0)
      for (let i = 1; i < timesS.length; i++) expect(timesS[i]).toBeGreaterThan(timesS[i - 1])
    }
  })

  it('ZV cancels its design resonance exactly', () => {
    const zv = shaperImpulses('ZV', 60, 0.08)
    expect(residualVibration(zv, 60, 0.08)).toBeLessThan(1e-9)
  })

  it('EI family keeps the design residual at or under the 5% tolerance', () => {
    for (const type of ['EI', '2HUMP_EI', '3HUMP_EI'] as const) {
      const s = shaperImpulses(type, 45, 0.1)
      expect(residualVibration(s, 45, 0.1)).toBeLessThanOrEqual(0.05 + 1e-6)
    }
  })

  it('EI shapers stay under tolerance over a wider frequency band than ZV', () => {
    const zv = shaperImpulses('ZV', 50, 0.1)
    const ei = shaperImpulses('EI', 50, 0.1)
    // 12% off-resonance: EI must still be within its 5% design tolerance, ZV must not.
    expect(residualVibration(ei, 56, 0.1)).toBeLessThanOrEqual(0.05 + 1e-6)
    expect(residualVibration(zv, 56, 0.1)).toBeGreaterThan(0.05)
  })
})

describe('smoothing and max accel', () => {
  it('smoothing grows with acceleration and longer shapers smooth more', () => {
    const zv = shaperImpulses('ZV', 50, 0.1)
    const threeHump = shaperImpulses('3HUMP_EI', 50, 0.1)
    expect(shaperSmoothingMm(zv, 6000)).toBeGreaterThan(shaperSmoothingMm(zv, 3000))
    expect(shaperSmoothingMm(threeHump, 3000)).toBeGreaterThan(shaperSmoothingMm(zv, 3000))
  })

  it('pins ZV and EI smoothing and max accel to hand-computed Klipper-semantics values', () => {
    // Regression pin of the Klipper _get_shaper_smoothing semantics (verified against the
    // upstream source): ts = sum(A[i] * T[i]) / sum(A), the amplitude-weighted mean impulse
    // time; each impulse contributes with dt = T[i] - ts; only impulses with T[i] >= ts enter
    // the 90-degree velocity term; smoothing = max(sqrt(2)/D * sum A[i] (scv + accel/2 dt) dt,
    // 1/D * sum A[i] accel/2 dt^2). The expected numbers were computed independently of the
    // module from that formula, at f = 50 Hz, zeta = 0.1, accel = 3000 mm/s^2, scv = 5 mm/s:
    //   ZV: df = 0.994987, t_d = 0.0201008 s, K = 0.729206, D = 1.729206, ts = 0.00423840 s,
    //       smoothing = 0.0475497 mm; max accel at the 0.12 mm target = 9742.8 mm/s^2.
    //   EI: A = [0.2625, 0.346373, 0.139594], T = [0, 0.0100504, 0.0201008] s,
    //       ts = 0.00838954 s, smoothing = 0.0776699 mm; max accel = 4656.5 mm/s^2.
    // A change of ts, the gate, or dt moves these in the third digit or worse, so any
    // divergence from the Klipper semantics fails loudly instead of passing a monotonicity check.
    const zv = shaperImpulses('ZV', 50, 0.1)
    expect(shaperSmoothingMm(zv, 3000)).toBeCloseTo(0.04755, 4)
    expect(shaperMaxAccel(zv)).toBeCloseTo(9742.8, 0)
    const ei = shaperImpulses('EI', 50, 0.1)
    expect(shaperSmoothingMm(ei, 3000)).toBeCloseTo(0.07767, 4)
    expect(shaperMaxAccel(ei)).toBeCloseTo(4656.5, 0)
  })

  it('max accel is positive and higher for shorter shapers', () => {
    const zvAccel = shaperMaxAccel(shaperImpulses('ZV', 50, 0.1))
    const threeHumpAccel = shaperMaxAccel(shaperImpulses('3HUMP_EI', 50, 0.1))
    expect(zvAccel).toBeGreaterThan(0)
    expect(threeHumpAccel).toBeGreaterThan(0)
    expect(zvAccel).toBeGreaterThan(threeHumpAccel)
  })
})

describe('recommendShapers', () => {
  it('returns all five options and recommends one within the band vibration tolerance', () => {
    const rec = recommendShapers(52.3, 0.06)
    expect(rec.options).toHaveLength(5)
    expect(rec.recommended.bandResidualVibration).toBeLessThanOrEqual(0.05 + 1e-6)
    // Among the tolerant options, none permits a higher acceleration than the recommendation.
    for (const o of rec.options) {
      if (o.bandResidualVibration <= 0.05 + 1e-6) {
        expect(o.maxAccelMmS2).toBeLessThanOrEqual(rec.recommended.maxAccelMmS2 + 1e-6)
      }
    }
  })

  it('judges robustness across the tolerance band, so ZV is not recommended at a real measurement', () => {
    // The real Y-axis measurement of this session: 52 Hz, damping 0.069, 95% CI 0.2 Hz. At its
    // own design point ZV shows a ~0% residual, but across the +/-5% band its suppression
    // collapses; the band-robust rule must expose that instead of crowning ZV.
    const rec = recommendShapers(52, 0.069, 0.2)
    expect(rec.recommended.type).not.toBe('ZV')
    const zv = rec.options.find((o) => o.type === 'ZV')!
    const mzv = rec.options.find((o) => o.type === 'MZV')!
    expect(zv.bandResidualVibration).toBeGreaterThan(mzv.bandResidualVibration)
    expect(zv.bandResidualVibration).toBeGreaterThan(0.05)
  })

  it('widens the band with the measurement confidence interval', () => {
    const impulses = shaperImpulses('MZV', 52, 0.069)
    const narrow = worstBandResidual(impulses, 52, 0.069, 0.05)
    const wide = worstBandResidual(impulses, 52, 0.069, 0.1)
    expect(wide).toBeGreaterThan(narrow)
  })
})

describe('formatters', () => {
  it('formats the Klipper suggestion', () => {
    const rec = recommendShapers(52.34, 0.06)
    const klipper = formatKlipperShaper('x', rec.recommended)
    expect(klipper).toContain('shaper_freq_x: 52.3')
    expect(klipper).toContain(`shaper_type_x: ${rec.recommended.type.toLowerCase()}`)
  })

  it('sets the damping ratio the shaper was designed at, so Klipper builds the same shaper', () => {
    // One mode: the shapers are designed at the measured damping. Two modes: Klipper's
    // fit_shaper designs every shaper at its default damping ratio 0.1, so the measured 0.05 of
    // either mode would make the firmware build a different shaper than the one scored.
    const single = formatKlipperShaper('x', recommendShapers(52.34, 0.06).recommended)
    expect(single.split('\n')).toContain('damping_ratio_x: 0.060')
    const two = recommendShapersForModes([
      { frequencyHz: 45, dampingRatio: 0.05, amplitudeMm: 0.03 },
      { frequencyHz: 62, dampingRatio: 0.05, amplitudeMm: 0.02 },
    ])
    expect(formatKlipperShaper('y', two.recommended).split('\n')).toContain('damping_ratio_y: 0.100')
  })
})

describe('multi-mode shaper selection', () => {
  const twoModes = [
    { frequencyHz: 45, dampingRatio: 0.05, amplitudeMm: 0.03 },
    { frequencyHz: 62, dampingRatio: 0.05, amplitudeMm: 0.02 },
  ]

  it('synthesizes a spectrum that peaks at each mode', () => {
    const freqs = Array.from({ length: 391 }, (_, i) => 5 + i * 0.5)
    const psd = modeSpectrum(twoModes, freqs)
    const peaks = freqs.filter((_, i) => i > 0 && i < freqs.length - 1 && psd[i] > psd[i - 1] && psd[i] > psd[i + 1])
    expect(peaks).toHaveLength(2)
    expect(Math.abs(peaks[0] - 45)).toBeLessThanOrEqual(1)
    expect(Math.abs(peaks[1] - 62)).toBeLessThanOrEqual(1)
  })

  it('recommends a shaper that suppresses both modes', () => {
    const { recommended } = recommendShapersForModes(twoModes)
    const impulses = shaperImpulses(recommended.type, recommended.frequencyHz, 0.1)
    for (const mode of twoModes) {
      expect(residualVibration(impulses, mode.frequencyHz, mode.dampingRatio)).toBeLessThanOrEqual(0.2)
    }
  })

  it('tunes every shaper type within its own frequency range', () => {
    const { options } = recommendShapersForModes(twoModes)
    expect(options.map((o) => o.type)).toEqual(['ZV', 'MZV', 'EI', '2HUMP_EI', '3HUMP_EI'])
    for (const o of options) expect(o.frequencyHz).toBeLessThanOrEqual(150)
  })
})
