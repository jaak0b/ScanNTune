import { burgArSegments, latticeSegments, spectralDensity } from '../correlatedNoise'
import type { ArFit } from '../correlatedNoise'
import { nullDesign, noiseModel, projectColumns, projectPeriodic, projectRing, ringScratch } from './ringGls'
import type { LineBasis, LineNoise, NullDesign, RingProjection } from './ringGls'
import { F_MAX_HZ, F_MIN_HZ } from './types'
import { FREQUENCY_GRID_HZ, cornerDeficit, ringColumns } from './ringRegressors'

// The generalized likelihood ratio test (GLRT) of a ring at one point theta = (f, zeta) of one
// traced line, with the AR noise model refitted under each hypothesis (S. M. Kay, "Fundamentals of
// Statistical Signal Processing, Volume II: Detection Theory", Prentice Hall 1998, ch. 9, signals in
// noise of unknown parameters). A noise model fitted under the null alone absorbs a component that
// persists over the window: an AR model of high enough order predicts a slowly decaying sinusoid
// almost exactly, so the whitened data no longer show it, and a test that whitens with that model
// loses the component. Under the alternative the ring is explained by the ring columns, the noise
// model is refitted to what remains, and the ratio of the two maximized likelihoods credits the
// component in full.
//
// Each hypothesis is fitted by iterated feasible generalized least squares (the iterated
// Cochrane-Orcutt procedure, D. Cochrane and G. H. Orcutt 1949): the regression by GLS under the
// current noise model, the AR model refitted by Burg's method to the raw residual at the order the
// null model's AICc chose, repeated while the exact Gaussian deviance falls. The innovation
// variance function (ringGls.ts, Harvey 1976) is the axis's, held fixed in both hypotheses. The deviance is the
// exact -2 log-likelihood of the AR model observed on the line's lattice (innovations form with
// the Kalman filter for unread samples, Jones 1980), profiled over the innovation variance:
// m ln(SSR / m) + ln det + m, with SSR the whitened residual sum of squares of a unit-variance
// model. Every fit that is evaluated is a point of its hypothesis's parameter space, so the
// smallest evaluated deviance bounds that hypothesis's minimum from above; the ratio is reported
// against the null fit's smallest deviance, and it is never below the ratio of the null noise
// model held fixed (the score form the field uses), which is one of the evaluated points.
//
// Small-sample correction: the deviance difference is scaled by the Bartlett factor of the normal
// regression model (M. S. Bartlett, "Properties of sufficiency and statistical tests", Proc. R.
// Soc. A 160, 1937), E[LR] = q m / (m - k), in the AR model's conditional form (Box and Jenkins
// 1970), where the p AR coefficients are regression coefficients on lagged values next to the k1
// regression columns of the alternative (and the variance-function slope when the axis has one):
// the statistic is (m - k1 - p) / m times the deviance difference. Measured on 2,000 simulated noise-only axes per noise model, the unscaled ratio
// exceeds the chi2_20 95% point 144 times under 1 px blur (allowed 68 to 132), the scaled one 118
// times; the scaled maximum over the grid under 2 px blur reaches pBound 0.05 in 22 of 400 axes
// (unscaled 42).

/** At most this many AR refits per hypothesis; the procedure stops earlier once the deviance
 *  falls by less than DEVIANCE_TOLERANCE. A safeguard of the iteration, not a model parameter. */
const MAX_REFITS = 8
/** Deviance decrease below which the refits stop: a thousandth of one chi-square unit. */
const DEVIANCE_TOLERANCE = 1e-3

/** One hypothesis fitted to one line. */
export interface HypothesisFit {
  /** The unit-innovation-variance AR noise model: its whitener and whitened fixed columns. */
  noise: LineNoise
  design: NullDesign
  /** The ring part of the fit; null under the null hypothesis. */
  ring: RingProjection | null
  /** Whitened residual sum of squares. */
  ssr: number
  /** Exact Gaussian -2 log-likelihood profiled over the innovation variance. */
  deviance: number
  /** Raw residual of the fit. */
  residual: Float64Array
}

/** The null fit of a line: the hypothesis fit and the AR order both hypotheses use. */
export interface NullFit extends HypothesisFit {
  order: number
  /** The corner-model scale: the flow-lag time constant (s) or the bead-drag length (mm). */
  tauS: number
  /** The covariate g(t) of the variance function at tauS (ringRegressors.cornerDeficit). */
  deficit: Float64Array
  /** The raw ring columns of modes already fitted, part of the null design of both hypotheses. */
  fixedColumns: Float64Array[]
  /** The Bartlett factor (m - k1 - p) / m the line's ratios are scaled by. */
  bartlett: number
}

/** A ring point of the detection: frequency and damping ratio. */
export interface RingPoint {
  frequencyHz: number
  dampingRatio: number
}

/** A stationary arc-length component: a sinusoid of the commanded arc length with this period. */
export interface PeriodicComponent {
  periodMm: number
}

/** A component given by its two raw columns on the line's samples. */
export interface ColumnComponent {
  columns: Float64Array[]
}

/** The component a likelihood ratio tests: a ring, an arc-length artifact, or explicit columns. */
export type TestedComponent = RingPoint | PeriodicComponent | ColumnComponent

/** The likelihood ratio of a ring at one point of one line, with its alternative fit. */
export interface RingRatio {
  /** The Bartlett-scaled -2 ln of the likelihood ratio: chi2_2 under the null at a fixed point. */
  statistic: number
  fit: HypothesisFit
}

/** m ln(SSR / m) + ln det + m: the exact Gaussian deviance profiled over the innovation variance. */
export function profiledDeviance(m: number, ssr: number, logDet: number): number {
  return m * Math.log(ssr / m) + logDet + m
}

/**
 * The ratio statistic of a ring with the noise model held at the null fit's: the Bartlett factor
 * times -m ln(1 - D / SSR0), for the whitened SSR reduction D the ring columns achieve
 * (Frisch-Waugh-Lovell). A lower bound of the statistic with the noise refitted.
 */
export function heldNoiseStatistic(h0: NullFit, m: number, reduction: number): number {
  if (!(reduction > 0)) return 0
  if (!(reduction < h0.ssr)) return Infinity
  return -h0.bartlett * m * Math.log(1 - reduction / h0.ssr)
}

function unitModel(coefficients: number[]): ArFit {
  return { coefficients, noiseVariance: 1 }
}

/** A noise model's shape: AR coefficients and variance-function slope. */
interface NoiseShape {
  coefficients: number[]
  varianceSlope: number
}

/** The hypothesis fit of a line under a noise shape, with the ring at `point`. */
function evaluate(
  basis: LineBasis,
  shape: NoiseShape,
  deficit: Float64Array,
  tauS: number,
  point: TestedComponent | null,
  fixedColumns: Float64Array[],
): HypothesisFit {
  const noise = noiseModel(basis, unitModel(shape.coefficients), shape.varianceSlope, deficit)
  const design = nullDesign(basis, noise, tauS, fixedColumns)
  return alternativeWith(basis, noise, design, point)
}

/** The noise shape refitted to a fit's raw residual: Burg's AR at `order`, the variance slope
 *  kept. */
function refitShape(basis: LineBasis, fit: HypothesisFit, order: number): NoiseShape {
  const ar = burgArSegments(latticeSegments(fit.residual, basis.rec.lattice), order)
  return { coefficients: ar.coefficients, varianceSlope: fit.noise.varianceSlope }
}

/** The fit with the noise model and null design given, the ring at `point` (or none). */
function alternativeWith(
  basis: LineBasis,
  noise: LineNoise,
  design: NullDesign,
  point: TestedComponent | null,
): HypothesisFit {
  const m = basis.m
  if (point === null) {
    return {
      noise,
      design,
      ring: null,
      ssr: design.ssr,
      deviance: profiledDeviance(m, design.ssr, noise.logDet),
      residual: noise.unwhiten(design.yr),
    }
  }
  const whitened = new Float64Array(m)
  let ring: RingProjection
  if ('columns' in point) {
    ring = projectColumns(basis, noise, design, point.columns[0], point.columns[1], whitened)
  } else if ('periodMm' in point) {
    ring = projectPeriodic(basis, noise, design, point.periodMm, ringScratch(m), new Float64Array(design.k), new Float64Array(design.k), whitened)
  } else {
    ring = projectRing(basis, noise, design, point.frequencyHz, point.dampingRatio, ringScratch(m), new Float64Array(design.k), new Float64Array(design.k), whitened)
  }
  const ssr = design.ssr - ring.D
  return {
    noise,
    design,
    ring,
    ssr,
    deviance: profiledDeviance(m, ssr, noise.logDet),
    residual: noise.unwhiten(whitened),
  }
}

/** Iterated Cochrane-Orcutt from `start` at a fixed AR order: the lowest-deviance fit reached. */
function iterate(
  basis: LineBasis,
  start: HypothesisFit,
  order: number,
  deficit: Float64Array,
  tauS: number,
  point: TestedComponent | null,
  fixedColumns: Float64Array[],
): HypothesisFit {
  let best = start
  for (let k = 0; k < MAX_REFITS; k++) {
    const next = evaluate(basis, refitShape(basis, best, order), deficit, tauS, point, fixedColumns)
    const gain = best.deviance - next.deviance
    if (gain > 0) best = next
    if (!(gain > DEVIANCE_TOLERANCE)) break
  }
  return best
}

/**
 * The null fit of a line at the flow-lag time constant tauS and the axis's variance slope: the AR
 * order of `initial` (chosen by AICc on the ordinary least squares residual), the AR refitted by
 * iterated Cochrane-Orcutt. `fixedModes` are modes already fitted, whose ring columns join the
 * null design (sequential detection of a further mode).
 */
export function nullHypothesisFit(
  basis: LineBasis,
  initial: ArFit,
  tauS: number,
  varianceSlope = 0,
  fixedModes: RingPoint[] = [],
): NullFit {
  const order = initial.coefficients.length
  const deficit = cornerDeficit(basis.rec.tS, basis.rec, basis.cornerModel, tauS)
  const fixedColumns = fixedModes.flatMap((p) => ringColumns(basis.rec.tS, p.frequencyHz, p.dampingRatio))
  const start = evaluate(basis, { coefficients: initial.coefficients, varianceSlope }, deficit, tauS, null, fixedColumns)
  const fit = iterate(basis, start, order, deficit, tauS, null, fixedColumns)
  const m = basis.m
  return {
    ...fit,
    order,
    tauS,
    deficit,
    fixedColumns,
    bartlett: (m - fit.design.k - 2 - order - (varianceSlope !== 0 ? 1 : 0)) / m,
  }
}

/**
 * The likelihood ratio statistic of a ring at `point` on one line: the null fit's deviance minus
 * the alternative's, the alternative's AR refitted by iterated Cochrane-Orcutt from the null
 * fit's noise model (and from `starts`, other AR shapes of the same order worth trying first).
 */
export function ringLikelihoodRatio(
  basis: LineBasis,
  h0: NullFit,
  point: TestedComponent,
  starts: ArFit[] = [],
): RingRatio {
  let start = alternativeWith(basis, h0.noise, h0.design, point)
  for (const s of starts) {
    if (s.coefficients.length !== h0.order) continue
    const candidate = evaluate(basis, { coefficients: s.coefficients, varianceSlope: h0.noise.varianceSlope }, h0.deficit, h0.tauS, point, h0.fixedColumns)
    if (candidate.deviance < start.deviance) start = candidate
  }
  const fit = iterate(basis, start, h0.order, h0.deficit, h0.tauS, point, h0.fixedColumns)
  return { statistic: h0.bartlett * Math.max(0, h0.deviance - fit.deviance), fit }
}

/**
 * The grid frequencies where an AR noise model's spectrum has a local maximum inside the search
 * band, the band edges included when the spectrum falls away from them: where a persistent
 * component the null model absorbed shows as a spectral peak. Frequencies convert to the AR's
 * sample lattice through `sampleIntervalS`, the line's cruise sample interval. A white model has
 * none.
 */
export function noiseSpectrumPeaks(fit: ArFit, sampleIntervalS: number): number[] {
  if (fit.coefficients.length === 0) return []
  const freqs: number[] = []
  for (let f = F_MIN_HZ; f <= F_MAX_HZ; f += FREQUENCY_GRID_HZ) freqs.push(f)
  const density = freqs.map((f) => spectralDensity(fit, f * sampleIntervalS))
  const peaks: number[] = []
  for (let i = 0; i < freqs.length; i++) {
    const left = i > 0 ? density[i - 1] : -Infinity
    const right = i < freqs.length - 1 ? density[i + 1] : -Infinity
    if (density[i] > left && density[i] >= right) peaks.push(freqs[i])
  }
  return peaks
}

/** The sample interval of a line's uniform cruise lattice, seconds (the mean interval when the
 *  window holds no cruise stretch). */
export function cruiseSampleIntervalS(basis: LineBasis): number {
  const m = basis.m
  if (basis.dt > 0) return basis.dt
  return (basis.rec.tS[m - 1] - basis.rec.tS[0]) / (basis.rec.lattice[m - 1] - basis.rec.lattice[0])
}
