// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  analyzeTracedLine,
  gaussianTrend,
  jointAxisFit,
  poolAxisFits,
} from '../../../src/engine/is/ringAnalyzer'
import type { LineFit } from '../../../src/engine/is/ringAnalyzer'
import type { TracedLine } from '../../../src/engine/is/lineTracer'

// Unit-level validation of the ring fitting on synthetic 1-D traces (no imaging): the
// generator synthesizes the PHYSICAL trace (forced corner-overshoot lobe, free damped ring,
// offset, optionally drift), deliberately richer than the analyzer's fit model, so these
// tests pin the estimator (detrend, transient exclusion, periodogram seed, variable
// projection, Levenberg-Marquardt polish), the screening classification, and the joint
// axis fit with its F-test acceptance in isolation. The image-level ground-truth recovery
// lives in isAnalyzer.spec.ts.

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

function makeTrace(params: TruthParams, noiseMm: number, seed = 42, fitStartMinS = 0): TracedLine {
  const n = 750
  const dt = 0.2 / n
  const tS = new Float64Array(n)
  const lateralMm = new Float64Array(n)
  const rand = rng(seed)
  for (let i = 0; i < n; i++) {
    tS[i] = i * dt
    lateralMm[i] = truthModel(params, tS[i]) + (noiseMm > 0 ? gauss(rand) * noiseMm : 0)
  }
  return {
    speedMmS: 150,
    tS,
    fitStartMinS,
    lateralMm,
    noiseWindowStart: Math.floor(0.75 * n),
    lateralPxPerMm: 24,
  }
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

/** Eight replicate traces of the same truth with varied phase and noise stream. */
function makeAxisTraces(
  base: TruthParams,
  noiseMm: number,
  count = 8,
  perTrace: (i: number) => Partial<TruthParams> = () => ({}),
): TracedLine[] {
  return Array.from({ length: count }, (_, i) =>
    makeTrace({ ...base, phaseRad: 0.4 + 0.5 * i, ...perTrace(i) }, noiseMm, 100 + i),
  )
}

function poolTraces(traces: TracedLine[], speedsMmS = [150]) {
  const fits = traces.map((t) => analyzeTracedLine(t))
  return {
    fits,
    pool: poolAxisFits(
      fits,
      speedsMmS,
      traces.map((t) => t.speedMmS),
    ),
  }
}

describe('analyzeTracedLine', () => {
  it('recovers frequency within 0.2 Hz and damping within 0.005 from a clean trace', () => {
    const fit = analyzeTracedLine(makeTrace(TRUE_PARAMS, 0.002))
    expect(fit.accepted).toBe(true)
    expect(fit.screening).toBe('clean')
    expect(Math.abs(fit.params!.frequencyHz - 75)).toBeLessThan(0.2)
    expect(Math.abs(fit.params!.dampingRatio - 0.05)).toBeLessThan(0.005)
    expect(fit.frequencySeHz).not.toBeNull()
    expect(fit.frequencySeHz!).toBeGreaterThan(0)
    expect(fit.window).not.toBeNull()
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

  it('labels a below-threshold amplitude as weak-ringing but keeps the line for the joint fit', () => {
    const fit = analyzeTracedLine(makeTrace({ ...TRUE_PARAMS, ringAmpMm: 0.003, lobeAmpMm: 0 }, 0.01))
    expect(fit.accepted).toBe(false)
    expect(fit.screening).toBe('weak-ringing')
    expect(fit.refusalReason).toContain('below the detection threshold')
    expect(fit.refusalCategory).toBe('weak-ringing')
    expect(fit.window).not.toBeNull()
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

  it('starts the fit window no earlier than the earliest exactly timed sample', () => {
    // 750 samples over 0.2 s (0.2667 ms apart): the free ringdown starts within the first few
    // milliseconds, but with the window held back to 0.05 s it starts at sample 188
    // (0.05 / 0.000266667 = 187.5, rounded up), leaving 562 samples; the ring is still read.
    const free = analyzeTracedLine(makeTrace(TRUE_PARAMS, 0.002))
    const held = analyzeTracedLine(makeTrace(TRUE_PARAMS, 0.002, 42, 0.05))
    expect(free.window!.y.length).toBeGreaterThan(562)
    expect(held.window!.y.length).toBe(562)
    expect(Math.abs(held.params!.frequencyHz - 75)).toBeLessThan(0.2)
  })

  it('finds no window when the earliest exactly timed sample lies past the trace', () => {
    const fit = analyzeTracedLine(makeTrace(TRUE_PARAMS, 0.002, 42, 0.3))
    expect(fit.screening).toBe('no-free-response')
    expect(fit.window).toBeNull()
  })

  it('excludes a trace too short to hold a transient and a ringdown', () => {
    const tS = new Float64Array([0, 0.001, 0.002])
    const lateralMm = new Float64Array([0.1, 0.05, 0.02])
    const fit = analyzeTracedLine({
      speedMmS: 150,
      tS,
      fitStartMinS: 0,
      lateralMm,
      noiseWindowStart: 2,
      lateralPxPerMm: 24,
    })
    expect(fit.accepted).toBe(false)
    expect(fit.screening).toBe('no-free-response')
    expect(fit.refusalReason).toContain('never settles')
    expect(fit.refusalCategory).toBe('irregular-trace')
    expect(fit.window).toBeNull()
  })

  it('excludes a fit that lands at the frequency search bound', () => {
    const fit = analyzeTracedLine(makeTrace({ ...TRUE_PARAMS, frequencyHz: 152 }, 0.002))
    expect(fit.accepted).toBe(false)
    expect(fit.screening).toBe('out-of-band')
    expect(fit.refusalReason).toContain('search range')
    expect(fit.refusalCategory).toBe('out-of-band')
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

describe('jointAxisFit and poolAxisFits', () => {
  it('recovers frequency and damping from eight agreeing traces at the current amplitude', () => {
    const { pool } = poolTraces(makeAxisTraces(TRUE_PARAMS, 0.002))
    expect(pool.accepted).toBe(true)
    expect(Math.abs(pool.frequencyHz! - 75)).toBeLessThan(0.3)
    expect(Math.abs(pool.dampingRatio! - 0.05)).toBeLessThan(0.01)
    expect(pool.frequencySeHz).not.toBeNull()
    expect(pool.frequencySeHz!).toBeGreaterThan(0)
    expect(pool.fStatistic).not.toBeNull()
    expect(pool.linesUsed).toBe(8)
    expect(pool.lineJoint.every((s) => s.usedInJointFit)).toBe(true)
    for (const s of pool.lineJoint) {
      expect(s.usedInJointFit && s.amplitudeMm).toBeTruthy()
    }
  })

  it('rescues weak lines: recovers the truth at 8x reduced amplitude (low per-line R^2 regime)', () => {
    // Amplitude 0.03 mm against 0.012 mm sample noise: individually the lines sit near or
    // below the per-line detection threshold, but jointly they carry the resonance.
    const { fits, pool } = poolTraces(
      makeAxisTraces({ ...TRUE_PARAMS, ringAmpMm: 0.03, lobeAmpMm: 0.05 }, 0.012),
    )
    // The regime under test: per-line gates would have refused at least one line.
    expect(fits.some((f) => !f.accepted)).toBe(true)
    expect(pool.accepted).toBe(true)
    expect(Math.abs(pool.frequencyHz! - 75)).toBeLessThan(1)
    expect(Math.abs(pool.dampingRatio! - 0.05)).toBeLessThan(0.02)
  })

  it('refuses pure-noise traces through the F-test, not a per-line gate', () => {
    const { pool } = poolTraces(
      makeAxisTraces({ ...TRUE_PARAMS, ringAmpMm: 0, lobeAmpMm: 0 }, 0.01),
    )
    expect(pool.accepted).toBe(false)
    expect(pool.refusals.some((r) => r.includes('statistically significant'))).toBe(true)
    // The rescan remedy travels apart from the verdict, so a coupon-specific remedy can
    // replace it.
    expect(pool.refusals.some((r) => r.includes('half turn'))).toBe(false)
    expect(pool.rescanAdvice).toContain('half turn')
  })

  it('refuses a significant ring whose frequency is too uncertain for a shaper', () => {
    // Three 0.02 s records hold only 1.5 cycles of a 75 Hz ring: the joint fit is
    // significant and lands inside the search range, but a frequency read off so few
    // cycles carries a 95% interval wider than 10% of itself, the shaper's stopband.
    // The same ring over 0.05 s (3.75 cycles) is accepted.
    const record = (seed: number, n: number, durationS: number) => {
      const tS = new Float64Array(n)
      const y = new Float64Array(n)
      const rand = rng(seed)
      const wd = 2 * Math.PI * 75 * Math.sqrt(1 - 0.05 * 0.05)
      for (let i = 0; i < n; i++) {
        tS[i] = (i * durationS) / n
        y[i] =
          0.02 * Math.exp(-2 * Math.PI * 75 * 0.05 * tS[i]) * Math.cos(wd * tS[i] + 0.4) +
          gauss(rand) * 0.01
      }
      return { tS, y }
    }
    const weakLine = (window: { tS: Float64Array; y: Float64Array }): LineFit => ({
      accepted: false,
      screening: 'weak-ringing',
      refusalReason: 'below the detection threshold',
      refusalCategory: 'weak-ringing',
      params: null,
      r2: 0,
      noiseRmsMm: 0.01,
      frequencySeHz: null,
      window,
    })
    const short = [500, 501, 502].map((s) => record(s, 30, 0.02))
    const pool = poolAxisFits(short.map(weakLine), [150], [150, 150, 150])
    expect(pool.accepted).toBe(false)
    expect(pool.refusals).toEqual([
      'The pooled frequency estimate is too uncertain to configure an input shaper: its 95% ' +
        'confidence interval is wider than the stopband of the shaper it would set. Reprint or ' +
        'rescan the coupon.',
    ])
    // Every earlier gate passed: the ring is significant and its standard error exists, so
    // the interval itself, not a missing estimate, refused the axis.
    const joint = jointAxisFit(short, 75)!
    expect(joint.significant).toBe(true)
    expect(joint.frequencySeHz).not.toBeNull()
    const long = [500, 501, 502].map((s) => record(s, 75, 0.05))
    expect(poolAxisFits(long.map(weakLine), [150], [150, 150, 150]).accepted).toBe(true)
  })

  it('excludes an out-of-band line and keeps the joint estimate unbiased', () => {
    const traces = makeAxisTraces(TRUE_PARAMS, 0.002, 8, (i) =>
      i === 7 ? { frequencyHz: 152 } : {},
    )
    const { pool } = poolTraces(traces)
    expect(pool.accepted).toBe(true)
    expect(Math.abs(pool.frequencyHz! - 75)).toBeLessThan(0.3)
    const last = pool.lineJoint[7]
    expect(last.usedInJointFit).toBe(false)
    expect(!last.usedInJointFit && last.exclusion).toBe('out-of-band')
    expect(pool.linesUsed).toBe(7)
  })

  it('drops a wild-frequency line through the Hampel screen before the joint fit', () => {
    const traces = makeAxisTraces(TRUE_PARAMS, 0.002, 8, (i) =>
      i === 3 ? { frequencyHz: 110 } : {},
    )
    const { pool } = poolTraces(traces)
    expect(pool.accepted).toBe(true)
    expect(Math.abs(pool.frequencyHz! - 75)).toBeLessThan(0.3)
    const wild = pool.lineJoint[3]
    expect(wild.usedInJointFit).toBe(false)
    expect(!wild.usedInJointFit && wild.exclusion).toBe('frequency-outlier')
  })

  it('refuses a significant ring below the amplitude resolvability floor', () => {
    // A clean coherent 0.01 mm ring is statistically overwhelming, but with a floor above
    // it (as a coarse scan would price) the axis must refuse as unresolvable.
    const traces = makeAxisTraces({ ...TRUE_PARAMS, ringAmpMm: 0.01, lobeAmpMm: 0 }, 0.002)
    const fits = traces.map((t) => analyzeTracedLine(t))
    const pool = poolAxisFits(fits, [150], traces.map((t) => t.speedMmS), 0.02)
    expect(pool.accepted).toBe(false)
    expect(pool.refusals.some((r) => r.includes('smaller than the scan can resolve'))).toBe(true)
  })

  it('refuses scattered replicate frequencies with the disagreement reason', () => {
    const freqs = [60, 68, 75, 82, 90]
    const traces = makeAxisTraces(TRUE_PARAMS, 0.002, 5, (i) => ({ frequencyHz: freqs[i] }))
    const { pool } = poolTraces(traces)
    expect(pool.accepted).toBe(false)
    expect(pool.refusals.some((r) => r.includes('disagree on the ringing frequency'))).toBe(true)
  })

  it('refuses when per-tier joint sub-fits disagree (speed-invariance check)', () => {
    const tierFreq = (i: number) => (i < 3 ? 75 : 55)
    const traces = makeAxisTraces(TRUE_PARAMS, 0.002, 6, (i) => ({ frequencyHz: tierFreq(i) }))
    const speeds = [150, 150, 150, 100, 100, 100]
    traces.forEach((t, i) => (t.speedMmS = speeds[i]))
    const { pool } = poolTraces(traces, [150, 100])
    expect(pool.accepted).toBe(false)
    expect(pool.refusals.some((r) => r.includes('speed tiers disagree'))).toBe(true)
  })

  it('refuses with the out-of-range note when most lines were excluded at the band edge', () => {
    const outOfBand = (): LineFit => ({
      accepted: false,
      screening: 'out-of-band',
      refusalReason: 'frequency at search bound',
      refusalCategory: 'out-of-band',
      params: null,
      r2: 0,
      noiseRmsMm: 0.002,
      frequencySeHz: null,
      window: null,
    })
    const pool = poolAxisFits([outOfBand(), outOfBand(), outOfBand(), outOfBand()], [150], [150, 150, 150, 150])
    expect(pool.accepted).toBe(false)
    const reason = pool.refusals.find((r) => r.includes('usable ringing trace'))!
    expect(reason).toContain('outside the measurable range')
    expect(reason).not.toContain('half turn')
    expect(pool.rescanAdvice).toBeNull()
  })

  it('keeps the half-turn rescan advice when the exclusions have no single dominant cause', () => {
    const excluded = (screening: 'no-free-response' | 'zeta-at-bound'): LineFit => ({
      accepted: false,
      screening,
      refusalReason: 'excluded line',
      refusalCategory: 'irregular-trace',
      params: null,
      r2: 0,
      noiseRmsMm: 0.002,
      frequencySeHz: null,
      window: null,
    })
    const pool = poolAxisFits(
      [excluded('no-free-response'), excluded('no-free-response'), excluded('zeta-at-bound')],
      [150],
      [150, 150, 150],
    )
    expect(pool.accepted).toBe(false)
    expect(pool.refusals.some((r) => r.includes('usable ringing trace'))).toBe(true)
    expect(pool.rescanAdvice).toContain('half turn')
  })

  it('uses the F distribution with numerator dof 2N+2 and denominator dof n-4N-2, not swapped', () => {
    // Three 60-sample records of a moderate 75 Hz ring (N = 3, n = 180: dof 8 and 166).
    // The statistic is engineered to land BETWEEN the two orientations' critical values:
    // F_0.001(8, 166) = 3.470 (cross-checked against the infinite-denominator table bound
    // chi2_0.001(8) / 8 = 26.124 / 8 = 3.266) and F_0.001(166, 8) = 9.478. A swapped
    // fCriticalValue(dfDen, dfNum) would therefore flip the verdict to not significant.
    const makeShortRecord = (seed: number) => {
      const n = 60
      const dt = 0.05 / n
      const tS = new Float64Array(n)
      const y = new Float64Array(n)
      const rand = rng(seed)
      const wd = 2 * Math.PI * 75 * Math.sqrt(1 - 0.05 * 0.05)
      for (let i = 0; i < n; i++) {
        tS[i] = i * dt
        y[i] =
          0.007 * Math.exp(-2 * Math.PI * 75 * 0.05 * tS[i]) * Math.cos(wd * tS[i] + 0.4) +
          gauss(rand) * 0.01
      }
      return { tS, y }
    }
    const joint = jointAxisFit([makeShortRecord(500), makeShortRecord(501), makeShortRecord(502)], 75)!
    expect(joint).not.toBeNull()
    expect(joint.fCritical).toBeCloseTo(3.47, 2)
    expect(joint.fStatistic!).toBeGreaterThan(3.47)
    expect(joint.fStatistic!).toBeLessThan(9.478)
    expect(joint.significant).toBe(true)
  })

  it('jointAxisFit reports the nested-model figures consistently', () => {
    const traces = makeAxisTraces(TRUE_PARAMS, 0.002, 4)
    const fits = traces.map((t) => analyzeTracedLine(t))
    const records = fits.map((f) => f.window!)
    const joint = jointAxisFit(records, 75)!
    expect(joint).not.toBeNull()
    expect(joint.ssrNull).toBeGreaterThan(joint.ssr)
    expect(joint.fStatistic).not.toBeNull()
    expect(joint.fCritical).not.toBeNull()
    expect(joint.fStatistic!).toBeGreaterThan(joint.fCritical!)
    expect(joint.significant).toBe(true)
    expect(joint.amplitudesMm).toHaveLength(4)
    // The fitted amplitude refers to the fit-window start, roughly half an oscillation
    // after the ring begins, so it sits somewhat below the 0.25 mm generation amplitude.
    for (const amp of joint.amplitudesMm) {
      expect(amp).toBeGreaterThan(0.1)
      expect(amp).toBeLessThan(0.3)
    }
  })
})
