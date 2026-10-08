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

/** The commanded motion after a line's corner: corner speed c, tier speed v, acceleration a. */
export interface CommandedMotion {
  cornerSpeedMmS: number
  speedMmS: number
  accelMmS2: number
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
