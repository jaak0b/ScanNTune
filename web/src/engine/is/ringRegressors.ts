import { F_MAX_HZ, F_MIN_HZ } from './types'

// The regressor columns of the input shaper ring model, as functions of a line's sample times
// (seconds since the ringing corner). Pure functions, shared by the detection field and the
// estimation stages so both use identical columns.

/** Frequency step of the detection grid, Hz. */
export const FREQUENCY_GRID_HZ = 1
/** Damping grid of the detection field and the estimation seed (log-spaced over the physical
 *  range of machine damping). */
export const ZETA_GRID = [0.001, 0.002, 0.005, 0.01, 0.02, 0.035, 0.05, 0.075, 0.1, 0.15, 0.22, 0.3, 0.4]
/** Upper bound of the damping ratio: the top of the grid. */
export const ZETA_MAX = ZETA_GRID[ZETA_GRID.length - 1]

export interface GridPoint {
  frequencyHz: number
  dampingRatio: number
}

/** The detection grid G: every FREQUENCY_GRID_HZ from F_MIN_HZ to F_MAX_HZ, times ZETA_GRID,
 *  frequency-major. */
export const DETECTION_GRID: readonly GridPoint[] = (() => {
  const grid: GridPoint[] = []
  for (let f = F_MIN_HZ; f <= F_MAX_HZ; f += FREQUENCY_GRID_HZ) {
    for (const zeta of ZETA_GRID) grid.push({ frequencyHz: f, dampingRatio: zeta })
  }
  return grid
})()

/**
 * Upper edge of the drift band, Hz: a factor 3 below the lowest search frequency, the separation
 * this flow's Gaussian detrend has always used, so the drift model cannot absorb the ring band.
 */
export const DRIFT_CUTOFF_HZ = F_MIN_HZ / 3

/**
 * The drift basis of a record: the discrete cosine basis cos(pi k (t - t0) / T), k = 0..K-1, over
 * the record [t0, t0 + T], with K = floor(2 T W) + 1 regressors for the drift band W =
 * DRIFT_CUTOFF_HZ: the highest regressor completes W cycles per second, so the basis spans the
 * waviness below the cutoff. This is the standard regression high-pass of SPM (K. J. Friston et
 * al., "Statistical Parametric Mapping", Academic Press 2007, ch. 14; spm_filter's
 * K = fix(2 n RT / cutoff + 1)). Never fewer than two regressors, so the constant and the linear
 * trend of the design's drift term are always represented.
 */
export function driftBasis(tS: Float64Array): Float64Array[] {
  const n = tS.length
  const t0 = tS[0]
  const T = tS[n - 1] - t0
  const count = Math.max(2, Math.floor(2 * T * DRIFT_CUTOFF_HZ) + 1)
  const basis: Float64Array[] = []
  for (let k = 0; k < count; k++) {
    const col = new Float64Array(n)
    for (let i = 0; i < n; i++) col[i] = T > 0 ? Math.cos((Math.PI * k * (tS[i] - t0)) / T) : k === 0 ? 1 : 0
    basis.push(col)
  }
  return basis
}

/**
 * The raw ring columns of a mode at each sample time: e^(-zeta w t) cos(w_d t) and
 * e^(-zeta w t) sin(w_d t), w = 2 pi f, w_d = w sqrt(1 - zeta^2). A fitted mode enters another
 * mode's null design through them.
 */
export function ringColumns(tS: Float64Array, frequencyHz: number, dampingRatio: number): Float64Array[] {
  const omega = 2 * Math.PI * frequencyHz
  const sr = -omega * dampingRatio
  const si = omega * Math.sqrt(Math.max(0, 1 - dampingRatio * dampingRatio))
  const re = new Float64Array(tS.length)
  const im = new Float64Array(tS.length)
  for (let i = 0; i < tS.length; i++) {
    const e = Math.exp(sr * tS[i])
    re[i] = e * Math.cos(si * tS[i])
    im[i] = e * Math.sin(si * tS[i])
  }
  return [re, im]
}

/** The commanded motion after a line's corner: corner speed c, tier speed v, acceleration a. */
export interface CommandedMotion {
  cornerSpeedMmS: number
  speedMmS: number
  accelMmS2: number
}

/**
 * A line's two time bases. tS is the commanded time since the corner of each sample: it maps one
 * to one to the commanded arc length, so everything fixed in the print or the scan (drift, belt
 * and scan patterns, the bead dragged at the corner) is a function of it. depositTimeS is when the
 * nozzle actually deposited each sample: the axis along the line rings after the corner too, so
 * the nozzle runs behind and ahead of its commanded position, and everything that happens in
 * time (the ring of the measured axis, the extruded flow) is a function of the deposit time.
 * Absent, the two are the same.
 */
export interface SampleTimes extends CommandedMotion {
  tS: Float64Array
  depositTimeS?: Float64Array
}

/** The deposit time of each sample (SampleTimes), seconds since the corner. */
export function depositTimes(rec: SampleTimes): Float64Array {
  return rec.depositTimeS ?? rec.tS
}

/**
 * The commanded arc length from the corner at each sample time, mm: c t + a t^2 / 2 on the
 * trapezoid ramp, then the tier speed (the inverse of couponGeometry.timeAtDistance).
 */
export function arcLengthMm(tS: Float64Array, motion: CommandedMotion): Float64Array {
  const c = motion.cornerSpeedMmS
  const v = motion.speedMmS
  const a = motion.accelMmS2
  const tRamp = Math.max(0, (v - c) / a)
  const sRamp = c * tRamp + 0.5 * a * tRamp * tRamp
  return tS.map((t) => (t <= tRamp ? c * t + 0.5 * a * t * t : sRamp + v * (t - tRamp)))
}

/** Pitch of a GT2 timing belt, mm (the GT2 tooth profile): its tooth mesh repeats along the
 *  belt's travel, so the print carries it fixed in arc length. */
export const GT2_PITCH_MM = 2
/** The JPEG 8 x 8 pixel DCT block (ITU-T T.81) and the 16 px minimum coded unit of 4:2:0 chroma
 *  subsampling: a compressed scan carries them fixed in scan pixels. */
export const JPEG_BLOCK_PX = [8, 16]

/**
 * The known periods of arc-length-stationary patterns on a line, mm: the GT2 pitch and its first
 * harmonic, and the JPEG blocks through the scan's pixels per millimetre along the line (none
 * when that is unknown). Only periods whose frequency at the line's cruise speed lies inside the
 * search band are kept: a sinusoid outside the band is nearly orthogonal to every ring column.
 */
export function knownArtifactPeriodsMm(motion: CommandedMotion, alongPxPerMm: number): number[] {
  const periods = [GT2_PITCH_MM, GT2_PITCH_MM / 2]
  if (alongPxPerMm > 0) for (const px of JPEG_BLOCK_PX) periods.push(px / alongPxPerMm)
  return periods.filter((p) => {
    const f = motion.speedMmS / p
    return f >= F_MIN_HZ && f <= F_MAX_HZ
  })
}

/** The cosine and sine columns of arc-length periods at each sample, two per period. */
export function periodicColumns(sMm: Float64Array, periodsMm: number[]): Float64Array[] {
  return periodsMm.flatMap((p) => [
    sMm.map((s) => Math.cos((2 * Math.PI * s) / p)),
    sMm.map((s) => Math.sin((2 * Math.PI * s) / p)),
  ])
}

/**
 * The flow-lag columns of a line at tau: the particular solution of the lag for a steady run-up
 * (flowLagRegressor) and the homogeneous solution c e^(-t / tau) / v(t). The lag equation
 * tau q' = v(t) - q has the general solution particular + C e^(-t / tau); the free coefficient C
 * is the extruded flow's state at the corner, which the corner itself disturbs, so it is
 * estimated rather than assumed. Both enter the relative flow deficit q / v - 1 divided by the
 * commanded speed, scaled by the corner speed c to stay dimensionless.
 */
export function flowLagColumns(
  tS: Float64Array,
  motion: CommandedMotion,
  tauS: number,
): Float64Array[] {
  const c = motion.cornerSpeedMmS
  const homogeneous = new Float64Array(tS.length)
  for (let i = 0; i < tS.length; i++) {
    homogeneous[i] = (c * Math.exp(-tS[i] / tauS)) / commandedSpeedMmS(tS[i], motion)
  }
  return [flowLagRegressor(tS, motion, tauS), homogeneous]
}

/**
 * The flow-lag deficit 1 - q_tau(t) / v(t) at each sample time: the relative shortfall of the
 * extruded flow behind the commanded flow (see flowLagRegressor), zero in steady flow.
 */
export function flowDeficit(tS: Float64Array, motion: CommandedMotion, tauS: number): Float64Array {
  return flowLagRegressor(tS, motion, tauS).map((v) => -v)
}

/**
 * The corner models of a line's null design: the first-order flow lag of the commanded flow
 * (flowLagColumns; its scale is the time constant tau, seconds) and the bead dragged at the
 * corner, a lobe decaying in commanded arc length exp(-s / lambda) (its scale is lambda, mm). An
 * axis takes the one with the lower pooled AICc.
 */
export type CornerModelKind = 'flow-lag' | 'bead-drag'

/** The corner model's columns of a line for its scale: the flow lag at the deposit times, the
 *  bead drag at the commanded arc length. */
export function cornerColumns(rec: SampleTimes, kind: CornerModelKind, scale: number): Float64Array[] {
  if (kind === 'flow-lag') return flowLagColumns(depositTimes(rec), rec, scale)
  return [arcLengthMm(rec.tS, rec).map((s) => Math.exp(-s / scale))]
}

/**
 * The covariate of the innovation variance function for the corner model: the flow-lag deficit
 * for the flow lag, the lobe's own shape exp(-s / lambda) for the bead drag (the dragged bead is
 * the disturbed one).
 */
export function cornerDeficit(rec: SampleTimes, kind: CornerModelKind, scale: number): Float64Array {
  if (kind === 'flow-lag') return flowDeficit(depositTimes(rec), rec, scale)
  return arcLengthMm(rec.tS, rec).map((s) => Math.exp(-s / scale))
}

/** The commanded speed at time t after the corner on the trapezoid ramp. */
function commandedSpeedMmS(t: number, motion: CommandedMotion): number {
  return Math.min(motion.speedMmS, motion.cornerSpeedMmS + motion.accelMmS2 * Math.max(0, t))
}

/**
 * The flow-lag regressor q_tau(t) / v(t) - 1 at each sample time. The commanded flow is
 * proportional to the commanded speed v(t): the run-up cruises at the corner speed c, the corner
 * keeps it, and the trapezoid ramp accelerates at a to the tier speed v. The extruded flow q
 * follows it through a first-order lag, tau q' = v(t) - q with q = c before the corner (the
 * linear nozzle model behind pressure advance). On the ramp the input is c + a t and the lagged
 * response is c + a (t - tau) + a tau e^(-t / tau); after the ramp it relaxes exponentially
 * toward the tier speed. The regressor is the relative flow deficit the lag leaves in the bead.
 */
export function flowLagRegressor(
  tS: Float64Array,
  motion: CommandedMotion,
  tauS: number,
): Float64Array {
  const c = motion.cornerSpeedMmS
  const v = motion.speedMmS
  const a = motion.accelMmS2
  const tRamp = Math.max(0, (v - c) / a)
  const atRampEnd = c + a * (tRamp - tauS) + a * tauS * Math.exp(-tRamp / tauS)
  const out = new Float64Array(tS.length)
  for (let i = 0; i < tS.length; i++) {
    const t = tS[i]
    if (t <= tRamp) {
      const q = c + a * (t - tauS) + a * tauS * Math.exp(-t / tauS)
      out[i] = q / (c + a * t) - 1
    } else {
      out[i] = (v + (atRampEnd - v) * Math.exp(-(t - tRamp) / tauS)) / v - 1
    }
  }
  return out
}
