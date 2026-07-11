// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  analyzeTracedLine,
  gaussianTrend,
  poolAxisFits,
} from '../../../src/engine/is/ringAnalyzer'
import type { LineFit, RingModelParams } from '../../../src/engine/is/ringAnalyzer'
import type { TracedLine } from '../../../src/engine/is/lineTracer'

// Unit-level validation of the ring fitting on synthetic 1-D traces (no imaging): the
// generator synthesizes the PHYSICAL trace (forced corner-overshoot lobe, free damped ring,
// offset, optionally drift), deliberately richer than the analyzer's fit model, so these
// tests pin the estimator (detrend, transient exclusion, periodogram seed, variable
// projection, Levenberg-Marquardt polish) and the refusal gates in isolation. The
// image-level ground-truth recovery lives in isAnalyzer.spec.ts.

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gauss(rand: () => number): number {
  const u = Math.max(rand(), 1e-12)
  const v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

interface TruthParams {
  lobeAmpMm: number
  lobeTauS: number
  ringAmpMm: number
  frequencyHz: number
  dampingRatio: number
  phaseRad: number
  offsetMm: number
  /** Slow drift across the record, mm per second (scanner transport artifact). */
  driftMmPerS?: number
}

/** The physical trace: forced overshoot lobe + free damped ring + offset + drift. */
function truthModel(p: TruthParams, t: number): number {
  const omega = 2 * Math.PI * p.frequencyHz
  const damped = omega * Math.sqrt(Math.max(0, 1 - p.dampingRatio * p.dampingRatio))
  return (
    p.lobeAmpMm * Math.exp(-t / Math.max(p.lobeTauS, 1e-6)) +
    p.ringAmpMm * Math.exp(-omega * p.dampingRatio * t) * Math.cos(damped * t + p.phaseRad) +
    p.offsetMm +
    (p.driftMmPerS ?? 0) * t
  )
}

function makeTrace(params: TruthParams, noiseMm: number, seed = 42): TracedLine {
  const n = 750
  const dt = 0.2 / n
  const tS = new Float64Array(n)
  const lateralMm = new Float64Array(n)
  const rand = rng(seed)
  for (let i = 0; i < n; i++) {
    tS[i] = i * dt
    lateralMm[i] = truthModel(params, tS[i]) + (noiseMm > 0 ? gauss(rand) * noiseMm : 0)
  }
  return { speedMmS: 150, tS, lateralMm, noiseWindowStart: Math.floor(0.75 * n) }
}

const TRUE_PARAMS: TruthParams = {
  lobeAmpMm: 0.08,
  lobeTauS: 0.008,
  ringAmpMm: 0.25,
  frequencyHz: 75,
  dampingRatio: 0.05,
  phaseRad: 0.4,
  offsetMm: 0,
}

describe('analyzeTracedLine', () => {
  it('recovers frequency within 0.2 Hz and damping within 0.005 from a clean trace', () => {
    const fit = analyzeTracedLine(makeTrace(TRUE_PARAMS, 0.002))
    expect(fit.accepted).toBe(true)
    expect(Math.abs(fit.params!.frequencyHz - 75)).toBeLessThan(0.2)
    expect(Math.abs(fit.params!.dampingRatio - 0.05)).toBeLessThan(0.005)
    expect(fit.frequencySeHz).not.toBeNull()
    expect(fit.frequencySeHz!).toBeGreaterThan(0)
  })

  it('recovers a low 25 Hz resonance and a high 140 Hz resonance', () => {
    for (const f of [25, 140]) {
      const fit = analyzeTracedLine(makeTrace({ ...TRUE_PARAMS, frequencyHz: f }, 0.002))
      expect(fit.accepted).toBe(true)
      // The settle lobe overlaps spectrally with a low resonance, so the edge tolerance is
      // looser than the mid-band 0.2 Hz; 1 Hz is still far inside every downstream gate.
      expect(Math.abs(fit.params!.frequencyHz - f)).toBeLessThan(1)
    }
  })

  it('refuses a trace whose amplitude is below the detection threshold, with the amplitude reason', () => {
    const fit = analyzeTracedLine(makeTrace({ ...TRUE_PARAMS, ringAmpMm: 0.003, lobeAmpMm: 0 }, 0.01))
    expect(fit.accepted).toBe(false)
    expect(fit.refusalReason).toContain('below the detection threshold')
  })

  it('recovers the frequency under a slow drift the record-length filter cannot remove', () => {
    // Regression for the real-scan failure of 2026-07-11: a ~0.1 mm near-linear drift across
    // the 0.2 s record (scanner transport artifact) three times the ring amplitude, plus a
    // large forced overshoot. The background line and the transient exclusion must keep the
    // fit on the ring.
    const fit = analyzeTracedLine(
      makeTrace(
        { ...TRUE_PARAMS, frequencyHz: 52, ringAmpMm: 0.03, lobeAmpMm: 0.1, driftMmPerS: 0.5 },
        0.003,
      ),
    )
    expect(fit.accepted).toBe(true)
    expect(Math.abs(fit.params!.frequencyHz - 52)).toBeLessThan(1)
    expect(fit.params!.dampingRatio).toBeLessThan(0.15)
  })

  it('refuses a fit that lands at the frequency search bound', () => {
    const fit = analyzeTracedLine(makeTrace({ ...TRUE_PARAMS, frequencyHz: 152 }, 0.002))
    expect(fit.accepted).toBe(false)
    expect(fit.refusalReason).toContain('search range')
  })
})

describe('gaussianTrend', () => {
  it('passes low-frequency waviness into the trend and keeps the ring band out of it', () => {
    const n = 750
    const tS = new Float64Array(n)
    const y = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      tS[i] = (i * 0.2) / n
      // 3 Hz waviness (trend) plus a 75 Hz ring (signal).
      y[i] = 0.1 * Math.sin(2 * Math.PI * 3 * tS[i]) + 0.05 * Math.cos(2 * Math.PI * 75 * tS[i])
    }
    const trend = gaussianTrend(tS, y, 3 / 20)
    // The trend should track the waviness closely in the interior, not the ring.
    let ringLeak = 0
    for (let i = 100; i < n - 100; i++) {
      const wav = 0.1 * Math.sin(2 * Math.PI * 3 * tS[i])
      ringLeak = Math.max(ringLeak, Math.abs(trend[i] - wav))
    }
    expect(ringLeak).toBeLessThan(0.02)
  })
})

describe('poolAxisFits', () => {
  const goodParams = (f: number): RingModelParams => ({
    backgroundMm: 0,
    backgroundSlopeMmPerS: 0,
    ringAmpMm: 0.25,
    frequencyHz: f,
    dampingRatio: 0.05,
    phaseRad: 0.4,
  })
  const goodFit = (f: number, se = 0.05): LineFit => ({
    accepted: true,
    refusalReason: null,
    params: goodParams(f),
    r2: 0.95,
    noiseRmsMm: 0.002,
    frequencySeHz: se,
  })
  const refusedFit = (reason: string): LineFit => ({
    accepted: false,
    refusalReason: reason,
    params: null,
    r2: 0,
    noiseRmsMm: 0.002,
    frequencySeHz: null,
  })

  it('pools agreeing replicates to the median with a finite confidence interval', () => {
    const fits = [74.8, 75.0, 75.1, 75.2, 74.9].map((f) => goodFit(f))
    const pool = poolAxisFits(fits, [150], [150, 150, 150, 150, 150])
    expect(pool.accepted).toBe(true)
    expect(pool.frequencyHz).toBeCloseTo(75.0, 1)
    expect(pool.frequencyCi95Hz).toBeGreaterThan(0)
    expect(pool.frequencyCi95Hz!).toBeLessThan(7.5)
    expect(pool.linesUsed).toBe(5)
  })

  it('refuses when fewer than three lines fit, surfacing the line-level reasons', () => {
    const fits = [goodFit(75), goodFit(75.1), refusedFit('line reason A'), refusedFit('line reason A')]
    const pool = poolAxisFits(fits, [150], [150, 150, 150, 150])
    expect(pool.accepted).toBe(false)
    expect(pool.refusals.some((r) => r.includes('usable ringing fit'))).toBe(true)
    expect(pool.refusals).toContain('line reason A')
  })

  it('refuses scattered replicate frequencies', () => {
    const fits = [60, 68, 75, 82, 90].map((f) => goodFit(f))
    const pool = poolAxisFits(fits, [150], [150, 150, 150, 150, 150])
    expect(pool.accepted).toBe(false)
    expect(pool.refusals.some((r) => r.includes('disagree on the ringing frequency'))).toBe(true)
  })

  it('refuses when speed tiers disagree (speed-invariance check)', () => {
    const fits = [goodFit(75), goodFit(75.1), goodFit(75.2), goodFit(55), goodFit(55.1), goodFit(55.2)]
    const speeds = [150, 150, 150, 100, 100, 100]
    const pool = poolAxisFits(fits, [150, 100], speeds)
    expect(pool.accepted).toBe(false)
    expect(pool.refusals.some((r) => r.includes('speed tiers disagree'))).toBe(true)
  })

  it('refuses a confidence interval wider than the shaper stopband', () => {
    // Per-line CRB standard errors so large the pooled 95% CI exceeds 10% of f.
    const fits = [75, 75.1, 74.9, 75.2, 74.8].map((f) => goodFit(f, 12))
    const pool = poolAxisFits(fits, [150], [150, 150, 150, 150, 150])
    expect(pool.accepted).toBe(false)
    expect(pool.refusals.some((r) => r.includes('too uncertain'))).toBe(true)
  })
})
