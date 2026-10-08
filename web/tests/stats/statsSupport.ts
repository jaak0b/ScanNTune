import { analyzeTracedLine, detectionStatisticAt, poolAxisFits, poolCouponAxes } from '../../src/engine/is/ringAnalyzer'
import type { AxisPool } from '../../src/engine/is/ringAnalyzer'
import { defaultIsTestRequest, fitSpecToPrinter } from '../../src/engine/is/types'
import type { IsAxis, IsTestRequest, IsTestSpec } from '../../src/engine/is/types'
import { defaultPrinterProfile } from '../../src/engine/gcode/profileTypes'
import { chiSquareSurvivalEvenDof } from '../../src/engine/math'
import { simulateAxis } from '../helpers/isTraceSim'
import type { SimLine, SimNoise, TraceSimOptions } from '../helpers/isTraceSim'

// Shared setup of the statistical calibration suite: the coupons the cases run on, one analysis
// of a simulated axis, and the noncentral chi-square relations that set the power-case
// amplitudes. Every replicate uses a fixed seed, so every count in the suite is reproducible.

const profile = defaultPrinterProfile()

function fitted(overrides: Partial<IsTestRequest>): IsTestSpec {
  return { ...fitSpecToPrinter({ ...defaultIsTestRequest(profile), ...overrides }, profile).spec, axes: ['y'] }
}

/** The default coupon's Y group: tiers 106 and 150 mm/s, five rungs each. */
export const TWO_TIER = fitted({})
/** The default coupon with 21 mm measured lines (a 120 mm bed with scan-with-plate placement). */
export const SHORT_LINES = { ...TWO_TIER, measuredLineMm: 21 }
/** A coupon whose every corner is the 20 mm/s bottom rung, the longest post-corner ramp chirp,
 *  with five lines per speed so the axis keeps the default's 10 lines. */
export const BOTTOM_RUNG: IsTestSpec = { ...fitted({ cornerSpeedMmS: 20 }), linesPerSpeed: 5 }

/** The default coupon with both groups, for the cases that analyze the two axes together. */
export const TWO_AXES: IsTestSpec = fitSpecToPrinter(defaultIsTestRequest(profile), profile).spec

export type CaseOptions = Omit<TraceSimOptions, 'seed' | 'spec'>

export const NOISE: Record<string, SimNoise> = {
  iid: { model: 'iid', sigmaPx: 0.1 },
  bilinear: { model: 'bilinear', sigmaPx: 0.1 },
  blur1: { model: 'blur1', sigmaPx: 0.1 },
  blur2: { model: 'blur2', sigmaPx: 0.1 },
  redAr2: { model: 'redAr2', sigmaPx: 0.1, peakHz: 60 },
  perLine: { model: 'iid', sigmaPx: 0.1, perLineScale: [0.5, 2, 0.7, 1.4, 1, 0.5, 2, 0.7, 1.4, 1] },
}

export function simulate(spec: IsTestSpec, options: CaseOptions, seed: number): SimLine[] {
  return simulateAxis({ seed, spec, ...options })
}

/** The production axis analysis of one simulated axis. */
export function analyzeCase(spec: IsTestSpec, options: CaseOptions, seed: number): AxisPool {
  const lines = simulate(spec, options, seed)
  return poolAxisFits(lines.map((l) => analyzeTracedLine(l.trace)), spec.speedsMmS)
}

/** The seed of a group's simulated lines in a two-axis case: the groups draw independent noise. */
function axisSeed(axis: IsAxis, seed: number): number {
  return axis === 'x' ? seed : seed + 500_000
}

/** One group of a two-axis coupon analyzed alone, on its commanded time base. */
export function analyzeAxisAlone(spec: IsTestSpec, axis: IsAxis, options: Omit<CaseOptions, 'axis'>, seed: number): AxisPool {
  const lines = simulateAxis({ seed: axisSeed(axis, seed), spec, axis, ...options })
  return poolAxisFits(lines.map((l) => analyzeTracedLine(l.trace)), spec.speedsMmS)
}

/** The production analysis of a two-axis coupon: both groups pooled together (X first). */
export function analyzeCouponCase(
  spec: IsTestSpec,
  x: Omit<CaseOptions, 'axis'>,
  y: Omit<CaseOptions, 'axis'>,
  seed: number,
): AxisPool[] {
  const fits = (axis: IsAxis, options: Omit<CaseOptions, 'axis'>) =>
    simulateAxis({ seed: axisSeed(axis, seed), spec, axis, ...options }).map((l) => analyzeTracedLine(l.trace))
  return poolCouponAxes([fits('x', x), fits('y', y)], spec.speedsMmS)
}

/** The detection statistic Q at one grid point over the lines `keep` selects, with the flow-lag
 *  null model (detectionStatisticAt): no pattern search and no corner-model choice, unlike the
 *  production analysis, which may choose the bead-drag model. */
export function statisticCase(
  spec: IsTestSpec,
  options: CaseOptions,
  seed: number,
  frequencyHz: number,
  dampingRatio: number,
  keep: (line: SimLine) => boolean = () => true,
): number {
  const lines = simulate(spec, options, seed).filter(keep)
  return detectionStatisticAt(lines.map((l) => analyzeTracedLine(l.trace)), frequencyHz, dampingRatio)
}

/**
 * The counts a correct implementation stays within for `n` independent seeds that each succeed
 * with probability `p`, failing with probability at most `tail` on each side: the smallest count
 * whose binomial lower tail P(X <= count) exceeds `tail`, and the largest whose upper tail
 * P(X >= count) does.
 */
export function binomialBounds(n: number, p: number, tail: number): { lower: number; upper: number } {
  const pmf: number[] = []
  let logTerm = n * Math.log(1 - p)
  for (let k = 0; k <= n; k++) {
    pmf.push(Math.exp(logTerm))
    logTerm += Math.log((n - k) / (k + 1)) + Math.log(p / (1 - p))
  }
  let lower = 0
  for (let below = pmf[0]; below <= tail && lower < n; below += pmf[++lower]);
  let upper = n
  for (let above = pmf[n]; above <= tail && upper > 0; above += pmf[--upper]);
  return { lower, upper }
}

/** The noncentrality at which the noncentral chi2_dof exceeds `critical` with `power`: the
 *  engine's own, which the proportionality gate uses too. */
export { noncentralityForPower } from '../../src/engine/math'

/** The x with P(chi2_dof >= x) = tail, by bisection (even dof). */
export function chiSquareCritical(dof: number, tail: number): number {
  let lo = 0
  let hi = 10 * dof + 200
  for (let k = 0; k < 200; k++) {
    const mid = 0.5 * (lo + hi)
    if (chiSquareSurvivalEvenDof(mid, dof) > tail) lo = mid
    else hi = mid
  }
  return 0.5 * (lo + hi)
}

/**
 * The noncentrality of the production statistic at the true point per squared millimetre of
 * top-rung amplitude, measured on `pilots` replicates at amplitude ampMm: E[Q] = dof + lambda for
 * a noncentral chi-square, and lambda grows with the amplitude squared.
 */
export function measuredNoncentralityPerMm2(
  spec: IsTestSpec,
  options: CaseOptions,
  ampMm: number,
  frequencyHz: number,
  dampingRatio: number,
  dof: number,
  pilots: number,
  seedBase: number,
  keep: (line: SimLine) => boolean = () => true,
): number {
  let sum = 0
  for (let i = 0; i < pilots; i++) {
    sum += statisticCase(
      spec,
      { ...options, ring: { frequencyHz, dampingRatio, ampMm } },
      seedBase + i,
      frequencyHz,
      dampingRatio,
      keep,
    )
  }
  return (sum / pilots - dof) / (ampMm * ampMm)
}
