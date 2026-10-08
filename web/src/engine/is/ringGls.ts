import { arWhitener, latticeSegments, selectOrderAiccSegments } from '../correlatedNoise'
import type { ArFit, ArWhitener } from '../correlatedNoise'
import { arcLengthMm, cornerColumns, driftBasis, periodicColumns } from './ringRegressors'
import type { CornerModelKind, VarianceCovariate } from './ringRegressors'
import type { SampleTimes } from './ringRegressors'

// Generalized least squares machinery of the input shaper ring model, per traced line. The
// model of one line's fit window (t in seconds since the ringing corner):
//
//   y(t) = sum_k d_k cos(pi k (t - t0) / T)            drift (discrete cosine basis)
//        + sum_P p_P cos(2 pi s / P) + q_P sin(2 pi s / P)    detected arc-length artifacts P
//        + g (q_tau(t) / v(t) - 1) + h c e^(-t/tau) / v(t)  flow lag of the commanded flow,
//          or g e^(-s/lambda), the bead dragged at the corner (the axis's corner model)
//        + e^(-zeta w t) (a cos(w_d t) + b sin(w_d t))   ring, w = 2 pi f, w_d = w sqrt(1 - zeta^2)
//        + AR(p) noise on the sample lattice, its innovation standard deviation scaled by
//          exp(b g(t) / 2) with g the flow-lag deficit of the commanded flow
//
// Time t is the deposit time of the sample for the ring and the flow lag, which happen in time,
// and the commanded time (one to one with the commanded arc length s) for the drift and the
// patterns fixed in the print or the scan (ringRegressors.SampleTimes). The drift and flow-lag
// columns form the NULL design; the two ring columns are added in the full model. Every column and the data are whitened by the same exact AR innovations operator
// (correlatedNoise.arWhitener), then divided by the innovation scale, so under the model the
// whitened residuals are iid N(0, 1) whatever the regressor shapes.
//
// The innovation scale is the multiplicative variance function of A. C. Harvey ("Estimating
// regression models with multiplicative heteroscedasticity", Econometrica 44(3), 1976, 461-465),
// log sigma_t^2 = a + b g(t), applied to the AR innovations: the bead right after a corner, where
// the extruded flow lags the commanded flow, is rougher than the steady bead. Scaling the
// innovations rather than the observations keeps the whitening one exact lower-triangular
// operator (the AR filter, then a diagonal), so the ring columns keep their closed-form whitening.

/** One line's fit window: the observed samples of the free ringdown. Its tS is the commanded
 *  time base; a depositTimeS (SampleTimes) moves the time-domain columns to the deposit times. */
export interface LineRecord extends SampleTimes {
  /** Scan pixels per commanded millimetre along the line (0 when unknown), locating patterns
   *  fixed in scan pixels. */
  alongPxPerMm: number
  /** The nominal centerline's image coordinate across the line per sample, px, and the image px
   *  per mm of lateral deviation along it (lineTracer.TracedLine). */
  acrossImagePx: Float64Array
  acrossAxisPxPerMm: number
  /** The trace's lateral sign relative to the run-up (lineTracer.TracedLine). */
  lateralTowardRunUp: 1 | -1
  /** Commanded time since the corner of each observed sample, seconds. */
  tS: Float64Array
  /** Sample-lattice index of each observed sample (consecutive except across unread samples). */
  lattice: Int32Array
  /** Lateral deviation of each observed sample, mm (raw, no detrend). */
  y: Float64Array
}

/** The parts of a line's model that depend on neither the noise model nor tau. */
export interface LineBasis {
  rec: LineRecord
  m: number
  /** The fixed null columns: the drift basis and the known arc-length-periodic columns. */
  fixedColumns: Float64Array[]
  /** Orthonormal basis of the unweighted fixed columns (ordinary least squares stages). */
  fixedQ: Float64Array[]
  /** The data with the fixed columns projected out (unweighted). */
  yFixedFree: Float64Array
  /** First observed sample at or after the end of the acceleration ramp: from here the sample
   *  times lie on a uniform grid of step dt (constant cruise speed, constant lattice step). */
  cruiseFrom: number
  dt: number
  /** The periods of the arc-length artifacts the fixed columns carry, mm. */
  artifactPeriodsMm: number[]
  /** The corner model of the null design; its scale (tauS in the functions taking one) is the
   *  flow-lag time constant in seconds or the bead-drag length in millimetres. */
  cornerModel: CornerModelKind
  /** The commanded arc length of each sample from the corner, mm. */
  sMm: Float64Array
}

/** A line's noise model: its AR fit, the whitening operator, the innovation scale of its
 *  variance function, and the whitened fixed columns. */
export interface LineNoise {
  fit: ArFit
  whitener: ArWhitener
  sigma: number
  /** Slope b of the variance function log sigma_t^2 = a + b g(t); 0 for a constant variance. */
  varianceSlope: number
  /** The covariate g(t) the slope applies to, the one it was estimated on; null for a constant
   *  variance. */
  covariate: VarianceCovariate | null
  /** Relative innovation standard deviation exp(b g(t) / 2) per observed sample, or null when
   *  the variance is constant. */
  scale: Float64Array | null
  /** Log determinant of the observations' covariance: the AR operator's plus 2 sum ln scale. */
  logDet: number
  /** Whitens a raw column given on the observed samples. */
  whiten(x: ArrayLike<number>): Float64Array
  /** Maps whitened values back to the raw column they came from. */
  unwhiten(e: ArrayLike<number>): Float64Array
  wY: Float64Array
  /** Orthonormal basis of the whitened drift columns. */
  wFixedQ: Float64Array[]
  /** The whitened data with the whitened drift columns projected out. */
  wYFixedFree: Float64Array
}

/** The whitened null design of a line at one tau. */
export interface NullDesign {
  /** Orthonormal basis of the whitened null columns, row-major m x k. */
  qRows: Float64Array
  k: number
  /** Whitened data with the null columns projected out. */
  yr: Float64Array
  /** Whitened residual sum of squares of the null model. */
  ssr: number
  /** The flow-lag columns (raw) at this tau. */
  lagRaw: Float64Array[]
  /** Further raw null columns (the ring columns of modes already fitted). */
  extraRaw: Float64Array[]
}

const DEPENDENT_COLUMN = 1e-10

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/**
 * A copy of a column divided by its largest absolute entry, or null for a zero column. The
 * coefficient of a least squares fit absorbs any column scale, so whether a column adds a
 * direction to a design depends on its direction alone. Scaling every column to a unit size
 * before the rank decision (column equilibration; A. van der Sluis, "Condition numbers and
 * equilibration of matrices", Numer. Math. 14, 1969, 14-23) makes that decision independent of
 * the scale, and keeps the norm of a column of tiny entries from underflowing. A column whose
 * scale moves with a nonlinear parameter, such as the flow-lag column decaying before the window
 * starts, then keeps its place in the design at every value of that parameter: the constant rank
 * the variable projection of Golub and Pereyra (1973) assumes near the solution.
 */
function equilibrated(column: ArrayLike<number>): { v: Float64Array; scale: number } | null {
  let largest = 0
  for (let i = 0; i < column.length; i++) largest = Math.max(largest, Math.abs(column[i]))
  if (!(largest > 0) || !Number.isFinite(largest)) return null
  return { v: Float64Array.from(column, (x) => x / largest), scale: largest }
}

/**
 * Orthonormal basis of the span of `columns` by modified Gram-Schmidt with one
 * reorthogonalization pass ("twice is enough", Giraud, Langou and Rozloznik 2005), each column
 * equilibrated first (equilibrated). A column is linearly dependent on the earlier ones, and
 * dropped, when its remainder falls below 1e-10 of its own norm. The design is `columns` after the
 * columns `start` is an orthonormal basis of.
 */
export function orthonormalBasis(columns: ArrayLike<number>[], start: Float64Array[] = []): Float64Array[] {
  const basis = start.slice()
  for (const column of columns) {
    const unit = equilibrated(column)
    if (!unit) continue
    const v = unit.v
    const norm0 = Math.sqrt(dot(v, v))
    for (let pass = 0; pass < 2; pass++) {
      for (const q of basis) {
        const c = dot(q, v)
        for (let i = 0; i < v.length; i++) v[i] -= c * q[i]
      }
    }
    const norm = Math.sqrt(dot(v, v))
    if (!(norm > DEPENDENT_COLUMN * norm0)) continue
    for (let i = 0; i < v.length; i++) v[i] /= norm
    basis.push(v)
  }
  return basis.slice(start.length)
}

/** x with its projection onto the orthonormal columns Q removed. */
function residualize(x: ArrayLike<number>, Q: Float64Array[]): Float64Array {
  const r = Float64Array.from(x)
  for (const q of Q) {
    const c = dot(q, r)
    for (let i = 0; i < r.length; i++) r[i] -= c * q[i]
  }
  return r
}

/** The fixed null columns of a record: the drift basis, then the cosine and sine columns of the
 *  given arc-length artifact periods. */
export function fixedNullColumns(rec: LineRecord, artifactPeriodsMm: number[] = []): Float64Array[] {
  const drift = driftBasis(rec.tS)
  if (artifactPeriodsMm.length === 0) return drift
  return [...drift, ...periodicColumns(arcLengthMm(rec.tS, rec), artifactPeriodsMm)]
}

/** A line's model parts that depend on neither the noise model nor the corner-model scale;
 *  `artifactPeriodsMm` are arc-length artifacts carried in the null design as fixed columns, and
 *  `extraFixedColumns` further fixed null columns. */
export function lineBasis(
  rec: LineRecord,
  artifactPeriodsMm: number[] = [],
  cornerModel: CornerModelKind = 'flow-lag',
  extraFixedColumns: Float64Array[] = [],
): LineBasis {
  const m = rec.tS.length
  const fixedColumns = [...fixedNullColumns(rec, artifactPeriodsMm), ...extraFixedColumns]
  const tRamp = Math.max(0, (rec.speedMmS - rec.cornerSpeedMmS) / rec.accelMmS2)
  let cruiseFrom = rec.tS.findIndex((t) => t >= tRamp)
  if (cruiseFrom < 0) cruiseFrom = m
  let dt = 0
  if (cruiseFrom < m - 1) {
    dt = (rec.tS[m - 1] - rec.tS[cruiseFrom]) / (rec.lattice[m - 1] - rec.lattice[cruiseFrom])
  }
  const fixedQ = orthonormalBasis(fixedColumns)
  return {
    rec,
    m,
    fixedColumns,
    fixedQ,
    yFixedFree: residualize(rec.y, fixedQ),
    cruiseFrom,
    dt,
    artifactPeriodsMm,
    cornerModel,
    sMm: arcLengthMm(rec.tS, rec),
  }
}

/** Residual sum of squares of the ordinary least squares null fit at tau. */
export function olsNullSsr(line: LineBasis, tauS: number): number {
  return ssrAfterLag(line.yFixedFree, orthonormalBasis(cornerColumns(line.rec, line.cornerModel, tauS), line.fixedQ))
}

/** Whitened residual sum of squares of the GLS null fit at tau. */
export function glsNullSsr(line: LineBasis, noise: LineNoise, tauS: number): number {
  const lag = cornerColumns(line.rec, line.cornerModel, tauS).map((c) => noise.whiten(c))
  return ssrAfterLag(noise.wYFixedFree, orthonormalBasis(lag, noise.wFixedQ))
}

/** ||r||^2 minus its projection on orthonormal columns that are orthogonal to the drift. */
function ssrAfterLag(driftFree: Float64Array, lag: Float64Array[]): number {
  let ssr = dot(driftFree, driftFree)
  for (const q of lag) {
    const c = dot(q, driftFree)
    ssr -= c * c
  }
  return ssr
}

/** Ordinary least squares fit of the null model at tau: residual sum of squares and residuals. */
export function olsNull(line: LineBasis, tauS: number): { ssr: number; residual: Float64Array } {
  const lag = orthonormalBasis(cornerColumns(line.rec, line.cornerModel, tauS), line.fixedQ)
  const yr = residualize(line.rec.y, line.fixedQ.concat(lag))
  return { ssr: dot(yr, yr), residual: yr }
}

/** A residual without measurable noise: no noise model can weight the ring model on it. The axis
 *  analysis turns it into a refusal. */
export class NoMeasurableNoiseError extends Error {
  constructor() {
    super('The traced lines of this axis have no measurable noise, so the ring model cannot be weighted.')
    this.name = 'NoMeasurableNoiseError'
  }
}

/**
 * The AR noise model of a residual: Burg's method over the runs of read samples (de Waele and
 * Broersen 2000), order by AICc (Hurvich and Tsai 1989) up to floor(10 log10 n). Throws
 * NoMeasurableNoiseError on a residual without noise.
 */
export function fitNoise(line: LineBasis, residual: Float64Array): LineNoise {
  const fit = selectOrderAiccSegments(latticeSegments(residual, line.rec.lattice))
  if (!(fit.noiseVariance > 0) || !Number.isFinite(fit.noiseVariance)) throw new NoMeasurableNoiseError()
  return noiseModel(line, fit)
}

/**
 * The noise model of a line for a given AR fit and variance function: its whitener and the
 * whitened fixed columns. `covariate` is the g(t) the slope was estimated on, given on the line's
 * observed samples; with a zero slope the innovation variance is constant. A nonzero slope
 * without its covariate, or a covariate of other samples, is a caller error and throws.
 */
export function noiseModel(
  line: LineBasis,
  fit: ArFit,
  varianceSlope = 0,
  covariate: VarianceCovariate | null = null,
): LineNoise {
  if (varianceSlope !== 0 && (covariate === null || covariate.values.length !== line.m)) {
    throw new Error('A variance slope needs the covariate it was estimated on, given on the samples of the same line.')
  }
  const whitener = arWhitener(fit, line.rec.lattice)
  const scale = varianceSlope !== 0 ? Float64Array.from(covariate!.values, (g) => Math.exp((varianceSlope * g) / 2)) : null
  let logDet = whitener.logDet
  if (scale) for (const v of scale) logDet += 2 * Math.log(v)
  const whiten = (x: ArrayLike<number>): Float64Array => {
    const w = whitener.whiten(x)
    if (scale) for (let i = 0; i < w.length; i++) w[i] /= scale[i]
    return w
  }
  const unwhiten = (e: ArrayLike<number>): Float64Array => {
    if (!scale) return whitener.unwhiten(e)
    return whitener.unwhiten(Float64Array.from(e, (v, i) => v * scale[i]))
  }
  const wY = whiten(line.rec.y)
  const wFixedQ = orthonormalBasis(line.fixedColumns.map((c) => whiten(c)))
  return {
    fit,
    whitener,
    sigma: Math.sqrt(fit.noiseVariance),
    varianceSlope: scale ? varianceSlope : 0,
    covariate: scale ? covariate : null,
    scale,
    logDet,
    whiten,
    unwhiten,
    wY,
    wFixedQ,
    wYFixedFree: residualize(wY, wFixedQ),
  }
}

/**
 * The variance-function slope b shared by an axis's lines (Harvey 1976): the maximum likelihood
 * estimate from each line's unit innovations e_l and flow-lag deficit g_l, every line's level
 * profiled out, i.e. the minimizer of sum_l [m_l ln(sum_t e^2 e^(-b g) / m_l) + b sum_t g], a
 * convex function of b, by Newton's method with step halving; and the likelihood ratio statistic
 * of b = 0, chi2_1 under a constant innovation variance. One slope for the axis, because the
 * starved bead after a corner is one mechanism of the print on every line; per line the slope is
 * not identified when the deficit is concentrated on a few samples.
 */
export function pooledVarianceSlope(
  innovations: ArrayLike<number>[],
  deficits: ArrayLike<number>[],
): { slope: number; statistic: number } {
  const objective = (b: number) => {
    let total = 0
    innovations.forEach((e, l) => {
      const g = deficits[l]
      let s0 = 0
      let G = 0
      for (let i = 0; i < e.length; i++) {
        s0 += e[i] * e[i] * Math.exp(-b * g[i])
        G += g[i]
      }
      total += e.length * Math.log(s0 / e.length) + b * G
    })
    return total
  }
  const anyDeficit = deficits.some((g) => Array.prototype.some.call(g, (v: number) => v !== 0))
  if (!anyDeficit) return { slope: 0, statistic: 0 }
  let b = 0
  let value = objective(0)
  const atZero = value
  for (let iter = 0; iter < 50; iter++) {
    let gradient = 0
    let curvature = 0
    innovations.forEach((e, l) => {
      const g = deficits[l]
      let s0 = 0
      let s1 = 0
      let s2 = 0
      let G = 0
      for (let i = 0; i < e.length; i++) {
        const w = e[i] * e[i] * Math.exp(-b * g[i])
        s0 += w
        s1 += w * g[i]
        s2 += w * g[i] * g[i]
        G += g[i]
      }
      const m = e.length
      gradient += G - (m * s1) / s0
      curvature += (m * (s2 * s0 - s1 * s1)) / (s0 * s0)
    })
    if (!(curvature > 0)) break
    let step = -gradient / curvature
    let next = b + step
    let nextValue = objective(next)
    while (!(nextValue <= value) && Math.abs(step) > 1e-12) {
      step /= 2
      next = b + step
      nextValue = objective(next)
    }
    if (!(nextValue <= value)) break
    const done = Math.abs(next - b) < 1e-10 * Math.max(1, Math.abs(b))
    b = next
    value = nextValue
    if (done) break
  }
  return { slope: b, statistic: Math.max(0, atZero - value) }
}

/** The whitened null design of a line at tau, with optional further raw null columns. */
export function nullDesign(line: LineBasis, noise: LineNoise, tauS: number, extraRaw: Float64Array[] = []): NullDesign {
  const lagRaw = cornerColumns(line.rec, line.cornerModel, tauS)
  const Q = noise.wFixedQ.concat(orthonormalBasis([...lagRaw, ...extraRaw].map((c) => noise.whiten(c)), noise.wFixedQ))
  const k = Q.length
  const m = line.m
  const qRows = new Float64Array(m * k)
  for (let j = 0; j < k; j++) for (let i = 0; i < m; i++) qRows[i * k + j] = Q[j][i]
  const yr = residualize(noise.wY, Q)
  return { qRows, k, yr, ssr: dot(yr, yr), lagRaw, extraRaw }
}

/** Scratch arrays for one line's ring columns (raw z and whitened w, real and imaginary). */
export interface RingScratch {
  zr: Float64Array
  zi: Float64Array
  wr: Float64Array
  wi: Float64Array
}

export function ringScratch(m: number): RingScratch {
  return {
    zr: new Float64Array(m),
    zi: new Float64Array(m),
    wr: new Float64Array(m),
    wi: new Float64Array(m),
  }
}

/** Samples between direct re-evaluations of the cruise recurrence, bounding rounding growth. */
const RECURRENCE_ANCHOR = 256

/**
 * The raw ring columns z = e^(s t) (real part a cos, imaginary part sin of the damped quadrature
 * pair, s = -zeta w + i w_d) at the line's deposit times, then their whitened versions. On the
 * commanded time base the cruise samples lie on a uniform grid, where z follows the exact
 * recurrence z_i = z_(i-1) e^(s dt), and a regular sample whose p predecessors are all on that
 * grid whitens in closed form: z_(i-j) = z_i e^(-s j dt), so
 * (z_i - sum_j phi_j z_(i-j)) / sigma = z_i (1 - sum_j phi_j e^(-s j dt)) / sigma. Every other
 * sample is whitened explicitly, by the AR predictor or by the operator's Kalman stretches.
 * Deposit times corrected for the along-line ring (alongTrackLag.ts) are not uniform, so their
 * columns are evaluated at every sample and whitened explicitly by the noise model.
 */
export function whitenedRing(
  line: LineBasis,
  noise: LineNoise,
  frequencyHz: number,
  dampingRatio: number,
  out: RingScratch,
): void {
  const omega = 2 * Math.PI * frequencyHz
  const sr = -omega * dampingRatio
  const si = omega * Math.sqrt(Math.max(0, 1 - dampingRatio * dampingRatio))
  const deposit = line.rec.depositTimeS
  if (!deposit) {
    whitenedExponential(line, noise, line.rec.tS, line.dt, sr, si, out)
    return
  }
  const { zr, zi } = out
  for (let i = 0; i < line.m; i++) {
    const e = Math.exp(sr * deposit[i])
    zr[i] = e * Math.cos(si * deposit[i])
    zi[i] = e * Math.sin(si * deposit[i])
  }
  out.wr.set(noise.whiten(zr))
  out.wi.set(noise.whiten(zi))
}

/**
 * The raw and whitened columns of the complex exponential e^((sr + i si) x) of a sample
 * coordinate x that steps uniformly by `step` over the cruise lattice (time with step dt for a
 * ring, commanded arc length with step v dt for an arc-length sinusoid): the closed-form
 * whitening of whitenedRing, which holds for any such coordinate.
 */
export function whitenedExponential(
  line: LineBasis,
  noise: LineNoise,
  coordinate: Float64Array,
  step: number,
  sr: number,
  si: number,
  out: RingScratch,
): void {
  const { rec, m, cruiseFrom } = line
  const dt = step
  const t = coordinate
  const lat = rec.lattice
  const { zr, zi, wr, wi } = out
  const stepMag = Math.exp(sr * dt)
  const stepR = stepMag * Math.cos(si * dt)
  const stepI = stepMag * Math.sin(si * dt)
  for (let i = 0; i < m; i++) {
    if (i > cruiseFrom && lat[i] === lat[i - 1] + 1 && (i - cruiseFrom) % RECURRENCE_ANCHOR !== 0) {
      const pr = zr[i - 1]
      const pi = zi[i - 1]
      zr[i] = pr * stepR - pi * stepI
      zi[i] = pr * stepI + pi * stepR
    } else {
      const e = Math.exp(sr * t[i])
      zr[i] = e * Math.cos(si * t[i])
      zi[i] = e * Math.sin(si * t[i])
    }
  }
  const phi = noise.fit.coefficients
  const p = phi.length
  const sigma = noise.sigma
  // Phi(s) / sigma = (1 - sum_j phi_j e^(-s j dt)) / sigma.
  let phR = 1
  let phI = 0
  {
    const backMag = Math.exp(-sr * dt)
    const backR = backMag * Math.cos(-si * dt)
    const backI = backMag * Math.sin(-si * dt)
    let powR = 1
    let powI = 0
    for (let j = 0; j < p; j++) {
      const nr = powR * backR - powI * backI
      const ni = powR * backI + powI * backR
      powR = nr
      powI = ni
      phR -= phi[j] * powR
      phI -= phi[j] * powI
    }
  }
  phR /= sigma
  phI /= sigma
  const regular = noise.whitener.regular
  const fastFrom = cruiseFrom + p
  for (let i = 0; i < m; i++) {
    if (!regular[i]) continue
    if (i >= fastFrom) {
      wr[i] = zr[i] * phR - zi[i] * phI
      wi[i] = zr[i] * phI + zi[i] * phR
    } else {
      let er = zr[i]
      let ei = zi[i]
      for (let j = 0; j < p; j++) {
        er -= phi[j] * zr[i - 1 - j]
        ei -= phi[j] * zi[i - 1 - j]
      }
      wr[i] = er / sigma
      wi[i] = ei / sigma
    }
  }
  noise.whitener.whitenIrregular(zr, wr)
  noise.whitener.whitenIrregular(zi, wi)
  const scale = noise.scale
  if (scale) {
    for (let i = 0; i < m; i++) {
      wr[i] /= scale[i]
      wi[i] /= scale[i]
    }
  }
}

/** The ring part of one line's GLS fit at one (f, zeta), by Frisch-Waugh-Lovell. */
export interface RingProjection {
  /** Whitened SSR reduction from adding the ring columns to the null design (chi2_2 under H0). */
  D: number
  /** Ring coefficients (a, b) of the raw columns e^(-zeta w t) cos / sin (w_d t). */
  a: number
  b: number
  /** Inner products of the residualized whitened ring columns with the residualized data. */
  gR: number
  gI: number
  /** Gram matrix of the residualized whitened ring columns. */
  G11: number
  G12: number
  G22: number
}

/**
 * Projects one line's whitened ring columns at (f, zeta) against its null design. With the null
 * columns orthonormal (Q) and the data already residualized (yr), the residualized ring columns
 * are w - Q (Q' w), their inner products with yr equal those of w, and the SSR reduction is
 * D = g' G^-1 g (the Frisch-Waugh-Lovell theorem; Davidson and MacKinnon 2004, s2.4). When
 * `residualOut` is given, the full model's whitened residual yr - C_r (a, b) is written to it.
 */
export function projectRing(
  line: LineBasis,
  noise: LineNoise,
  design: NullDesign,
  frequencyHz: number,
  dampingRatio: number,
  scratch: RingScratch,
  pr: Float64Array,
  pi: Float64Array,
  residualOut?: Float64Array,
): RingProjection {
  whitenedRing(line, noise, frequencyHz, dampingRatio, scratch)
  return projectWhitened(design, line.m, scratch.wr, scratch.wi, pr, pi, residualOut)
}

/**
 * Projects the arc-length sinusoid pair cos, sin(2 pi s / P) against a line's null design, its
 * columns whitened in closed form (whitenedExponential on the commanded arc length).
 */
export function projectPeriodic(
  line: LineBasis,
  noise: LineNoise,
  design: NullDesign,
  periodMm: number,
  scratch: RingScratch,
  pr: Float64Array,
  pi: Float64Array,
  residualOut?: Float64Array,
): RingProjection {
  whitenedExponential(line, noise, line.sMm, line.dt * line.rec.speedMmS, 0, (2 * Math.PI) / periodMm, scratch)
  return projectWhitened(design, line.m, scratch.wr, scratch.wi, pr, pi, residualOut)
}

/**
 * Projects a pair of raw columns (any shape) against a line's null design: projectRing for
 * columns without a closed-form whitening, which are whitened explicitly by the noise model.
 */
export function projectColumns(
  line: LineBasis,
  noise: LineNoise,
  design: NullDesign,
  rawR: Float64Array,
  rawI: Float64Array,
  residualOut?: Float64Array,
): RingProjection {
  return projectWhitened(design, line.m, noise.whiten(rawR), noise.whiten(rawI), new Float64Array(design.k), new Float64Array(design.k), residualOut)
}

/** The Frisch-Waugh-Lovell projection of two whitened columns against a whitened null design. */
function projectWhitened(
  design: NullDesign,
  m: number,
  wr: Float64Array,
  wi: Float64Array,
  pr: Float64Array,
  pi: Float64Array,
  residualOut?: Float64Array,
): RingProjection {
  const { qRows, k, yr } = design
  pr.fill(0)
  pi.fill(0)
  let gR = 0
  let gI = 0
  let rr = 0
  let ii = 0
  let ri = 0
  for (let i = 0; i < m; i++) {
    const a = wr[i]
    const b = wi[i]
    const y = yr[i]
    gR += y * a
    gI += y * b
    rr += a * a
    ii += b * b
    ri += a * b
    const row = i * k
    for (let j = 0; j < k; j++) {
      const q = qRows[row + j]
      pr[j] += q * a
      pi[j] += q * b
    }
  }
  let G11 = rr
  let G22 = ii
  let G12 = ri
  for (let j = 0; j < k; j++) {
    G11 -= pr[j] * pr[j]
    G22 -= pi[j] * pi[j]
    G12 -= pr[j] * pi[j]
  }
  const det = G11 * G22 - G12 * G12
  // Degenerate columns (collinear with each other or with the null design) carry no
  // two-dimensional direction: no reduction is credited.
  if (!(G11 > 0 && G22 > 0 && det > 1e-12 * G11 * G22)) {
    if (residualOut) residualOut.set(yr)
    return { D: 0, a: 0, b: 0, gR, gI, G11, G12, G22 }
  }
  const a = (G22 * gR - G12 * gI) / det
  const b = (G11 * gI - G12 * gR) / det
  const D = a * gR + b * gI
  if (residualOut) {
    for (let i = 0; i < m; i++) {
      let cr = wr[i]
      let ci = wi[i]
      const row = i * k
      for (let j = 0; j < k; j++) {
        cr -= qRows[row + j] * pr[j]
        ci -= qRows[row + j] * pi[j]
      }
      residualOut[i] = yr[i] - a * cr - b * ci
    }
  }
  return { D, a, b, gR, gI, G11, G12, G22 }
}

/**
 * The raw (unwhitened) residual of a line's full fit, for the noise model of the next feasible
 * GLS step: the null coefficients are the generalized least squares solution for the data with
 * the fitted ring removed, by QR on the whitened null columns.
 */
export function rawFullResidual(
  line: LineBasis,
  noise: LineNoise,
  design: NullDesign,
  frequencyHz: number,
  dampingRatio: number,
  ring: { a: number; b: number },
  scratch: RingScratch,
): Float64Array {
  whitenedRing(line, noise, frequencyHz, dampingRatio, scratch)
  const m = line.m
  const target = new Float64Array(m)
  for (let i = 0; i < m; i++) target[i] = noise.wY[i] - ring.a * scratch.wr[i] - ring.b * scratch.wi[i]
  const rawColumns = [...line.fixedColumns, ...design.lagRaw, ...design.extraRaw]
  const beta = generalizedLeastSquares(rawColumns.map((c) => noise.whiten(c)), target)
  const residual = new Float64Array(m)
  for (let i = 0; i < m; i++) {
    let fitted = ring.a * scratch.zr[i] + ring.b * scratch.zi[i]
    for (let j = 0; j < rawColumns.length; j++) fitted += beta[j] * rawColumns[j][i]
    residual[i] = line.rec.y[i] - fitted
  }
  return residual
}

/**
 * Least squares coefficients of target on columns by modified Gram-Schmidt QR and back
 * substitution on the equilibrated columns (as in orthonormalBasis), mapped back to the columns'
 * own scale; a column dependent on the earlier ones (remainder below 1e-10 of its norm) gets
 * coefficient 0.
 */
function generalizedLeastSquares(columns: Float64Array[], target: Float64Array): number[] {
  const n = columns.length
  const Q: (Float64Array | null)[] = []
  const scales = new Array<number>(n).fill(1)
  const R: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let j = 0; j < n; j++) {
    const unit = equilibrated(columns[j])
    if (!unit) {
      Q.push(null)
      continue
    }
    scales[j] = unit.scale
    const v = unit.v
    const norm0 = Math.sqrt(dot(v, v))
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < j; i++) {
        const q = Q[i]
        if (!q) continue
        const c = dot(q, v)
        R[i][j] += c
        for (let k = 0; k < v.length; k++) v[k] -= c * q[k]
      }
    }
    const norm = Math.sqrt(dot(v, v))
    if (!(norm > DEPENDENT_COLUMN * norm0)) {
      Q.push(null)
      continue
    }
    R[j][j] = norm
    for (let k = 0; k < v.length; k++) v[k] /= norm
    Q.push(v)
  }
  const qty = Q.map((q) => (q ? dot(q, target) : 0))
  const beta = new Array<number>(n).fill(0)
  for (let j = n - 1; j >= 0; j--) {
    if (!Q[j]) continue
    let s = qty[j]
    for (let k = j + 1; k < n; k++) s -= R[j][k] * beta[k]
    beta[j] = s / R[j][j]
  }
  return beta.map((b, j) => b / scales[j])
}

/**
 * Minimizes a function of tau on a log scale over [tauMin, tauMax]: a scan over 24 log-spaced
 * points brackets the global minimum (the profile need not be unimodal), and golden-section
 * search (J. Kiefer, "Sequential minimax search for a maximum", Proc. AMS 4, 1953) refines it
 * inside the bracket to 1e-4 in log tau.
 */
export function minimizeOverLogTau(
  objective: (tauS: number) => number,
  tauMinS: number,
  tauMaxS: number,
): number {
  const lo = Math.log(tauMinS)
  const hi = Math.log(tauMaxS)
  const SCAN = 24
  const xs = Array.from({ length: SCAN }, (_, i) => lo + ((hi - lo) * i) / (SCAN - 1))
  const fs = xs.map((x) => objective(Math.exp(x)))
  let best = 0
  for (let i = 1; i < SCAN; i++) if (fs[i] < fs[best]) best = i
  let a = xs[Math.max(0, best - 1)]
  let b = xs[Math.min(SCAN - 1, best + 1)]
  const g = (Math.sqrt(5) - 1) / 2
  let c = b - g * (b - a)
  let d = a + g * (b - a)
  let fc = objective(Math.exp(c))
  let fd = objective(Math.exp(d))
  while (b - a > 1e-4) {
    if (fc < fd) {
      b = d
      d = c
      fd = fc
      c = b - g * (b - a)
      fc = objective(Math.exp(c))
    } else {
      a = c
      c = d
      fc = fd
      d = a + g * (b - a)
      fd = objective(Math.exp(d))
    }
  }
  const x = fc < fd ? c : d
  return Math.exp(fs[best] < Math.min(fc, fd) ? xs[best] : x)
}

/** Result of a Levenberg-Marquardt fit of a residual vector. */
export interface LmResult {
  theta: number[]
  ssr: number
  /** Jacobian columns of the residual at theta, one per parameter (null for a parameter whose
   *  column vanished, which the covariance then treats as fixed). */
  jacobian: (Float64Array | null)[]
  /** Residual vector at theta. */
  residual: Float64Array
}

/**
 * Levenberg-Marquardt minimization of ||r(theta)||^2 inside box bounds (Levenberg 1944,
 * Marquardt 1963; multiplicative lambda control as in Madsen, Nielsen and Tingleff, "Methods for
 * Non-Linear Least Squares Problems", 2004), with a forward-difference Jacobian of the fully
 * re-solved projected residual: the variable projection Jacobian of Golub and Pereyra (1973),
 * evaluated numerically. A parameter whose Jacobian column vanishes is held fixed.
 */
export function levenbergMarquardt(
  theta0: number[],
  lower: number[],
  upper: number[],
  residual: (theta: number[]) => Float64Array,
  maxIterations = 60,
): LmResult {
  const n = theta0.length
  const clamp = (t: number[]) => t.map((v, j) => Math.min(upper[j], Math.max(lower[j], v)))
  let theta = clamp(theta0)
  let r = residual(theta)
  let cost = dot(r, r)
  let lambda = 1e-3
  const jacobianAt = (th: number[], base: Float64Array): (Float64Array | null)[] => {
    const cols: (Float64Array | null)[] = []
    let maxNorm = 0
    for (let j = 0; j < n; j++) {
      let h = Math.max(1e-6, Math.abs(th[j]) * 1e-5)
      if (th[j] + h > upper[j]) h = -h
      const shifted = th.slice()
      shifted[j] += h
      const rh = residual(shifted)
      const col = new Float64Array(base.length)
      for (let i = 0; i < base.length; i++) col[i] = (rh[i] - base[i]) / h
      cols.push(col)
      maxNorm = Math.max(maxNorm, dot(col, col))
    }
    return cols.map((c) => (c && dot(c, c) > 1e-18 * maxNorm ? c : null))
  }
  let J = jacobianAt(theta, r)
  for (let iter = 0; iter < maxIterations; iter++) {
    const active = J.map((c, j) => (c ? j : -1)).filter((j) => j >= 0)
    if (active.length === 0) break
    const A = active.map((a) => active.map((b) => dot(J[a]!, J[b]!)))
    const g = active.map((a) => dot(J[a]!, r))
    const damped = A.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) : v)))
    const step = solveSymmetric(damped, g.map((v) => -v))
    if (step === null) {
      lambda *= 10
      if (lambda > 1e12) break
      continue
    }
    const trial = theta.slice()
    active.forEach((j, k) => (trial[j] += step[k]))
    const clamped = clamp(trial)
    const rTrial = residual(clamped)
    const costTrial = dot(rTrial, rTrial)
    if (costTrial < cost) {
      const improvement = (cost - costTrial) / Math.max(cost, 1e-300)
      theta = clamped
      r = rTrial
      cost = costTrial
      lambda = Math.max(lambda / 10, 1e-12)
      J = jacobianAt(theta, r)
      if (improvement < 1e-12) break
    } else {
      lambda *= 10
      if (lambda > 1e12) break
    }
  }
  return { theta, ssr: cost, jacobian: J, residual: r }
}

/** Solves the symmetric positive definite system A x = b by Cholesky; null when not definite. */
export function solveSymmetric(A: number[][], b: number[]): number[] | null {
  const n = b.length
  const L: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j]
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k]
      if (i === j) {
        if (!(s > 0)) return null
        L[i][i] = Math.sqrt(s)
      } else {
        L[i][j] = s / L[j][j]
      }
    }
  }
  const z = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    let s = b[i]
    for (let k = 0; k < i; k++) s -= L[i][k] * z[k]
    z[i] = s / L[i][i]
  }
  const x = new Array<number>(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let s = z[i]
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]
    x[i] = s / L[i][i]
  }
  return x
}

/**
 * Asymptotic covariance sigma^2 (J'J)^-1 of the parameters of an LM fit on the whitened stacked
 * Jacobian (Seber and Wild, "Nonlinear Regression", 1989, s2.1); a parameter with a vanished
 * Jacobian column is treated as fixed (variance null). Null when J'J is not positive definite.
 */
export function parameterVariances(fit: LmResult, sigma2: number): (number | null)[] | null {
  const active = fit.jacobian.map((c, j) => (c ? j : -1)).filter((j) => j >= 0)
  const A = active.map((a) => active.map((b) => dot(fit.jacobian[a]!, fit.jacobian[b]!)))
  const variances: (number | null)[] = fit.jacobian.map(() => null)
  for (let k = 0; k < active.length; k++) {
    const e = active.map((_, i) => (i === k ? 1 : 0))
    const col = solveSymmetric(A, e)
    if (col === null) return null
    variances[active[k]] = sigma2 * col[k]
  }
  return variances
}
