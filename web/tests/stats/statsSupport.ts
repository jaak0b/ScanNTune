import { analyzeTracedLine, detectionStatisticAt, poolAxisFits } from '../../src/engine/is/ringAnalyzer'
import type { AxisPool } from '../../src/engine/is/ringAnalyzer'
import { defaultIsTestRequest, fitSpecToPrinter } from '../../src/engine/is/types'
import type { IsTestRequest, IsTestSpec } from '../../src/engine/is/types'
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
export const BOTTOM_RUNG = fitted({ cornerSpeedMmS: 20, linesPerSpeed: 5 })

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

/** The production detection statistic Q at one grid point, over the lines `keep` selects. */
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

/** P(X >= x) for the noncentral chi-square with even dof and noncentrality lambda (the Poisson
 *  mixture of central chi-squares, Johnson, Kotz and Balakrishnan 1995, ch. 29). */
export function noncentralSurvival(x: number, dof: number, lambda: number): number {
  let total = 0
  let weight = Math.exp(-lambda / 2)
  for (let j = 0; j < 2000; j++) {
    total += weight * chiSquareSurvivalEvenDof(x, dof + 2 * j)
    weight *= lambda / 2 / (j + 1)
    if (j > lambda && weight < 1e-18) break
  }
  return total
}

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

/** The noncentrality at which the noncentral chi2_dof exceeds `critical` with `power`. */
export function noncentralityForPower(dof: number, critical: number, power: number): number {
  let lo = 0
  let hi = 10 * critical + 100
  for (let k = 0; k < 200; k++) {
    const mid = 0.5 * (lo + hi)
    if (noncentralSurvival(critical, dof, mid) < power) lo = mid
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
