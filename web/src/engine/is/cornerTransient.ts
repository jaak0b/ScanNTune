import { mulberry32, normalQuantile } from '../math'
import { DETECTION_ALPHA } from './types'

// The corner-transient gate: a response is accepted as ringing of the machine only when it is
// shown to be the transient the corner's velocity step starts. Ringing is the free response of a
// linear system to that step, so it is locked to the corner (on every line it starts at the
// corner with the same phase, its amplitude proportional to the corner speed) and it decays. A
// forced tone, such as a fan's imbalance, runs on through the corner with a phase the corner
// does not set and keeps its amplitude. Either property shows the transient: corner locking
// shown OR decay shown, each tested at half the flow's level, so the union keeps the acceptance
// of a forced tone at most DETECTION_ALPHA (the Bonferroni bound of a union, O. J. Dunn,
// "Multiple comparisons among means", JASA 56, 1961). A lightly damped ring (zeta 0.03 decays
// little over a line) is shown by its locking, a weak ring whose phases scatter is often shown
// by its decay.
//
// Corner locking: each line's complex ring amplitude z_l = a_l - i b_l at the corner (the
// coefficients of the cos and sin columns, time measured from the corner) is turned toward the
// line's run-up, the lateral sign convention of alongTrackLag.ts. The statistic is the length of
// the weighted sum S = sum_l w_l s_l z_l with w_l = c_l P_l, c_l the corner speed and P_l the
// precision of z_l: the weighted least squares estimate of one response per unit corner speed
// through the origin, the output-error model of the corner's linear response (L. Ljung, "System
// Identification: Theory for the User", 2nd ed., Prentice Hall 1999, s4.2). Under the null
// hypothesis the per-line phases are independent and uniform, the magnitudes whatever they are,
// so the test is the randomization test of uniform phases conditional on the magnitudes: the
// observed |S| against |sum_l w_l |z_l| e^(i u_l)| for independent uniform u_l, computed as a
// Monte Carlo test (G. A. Barnard, discussion of Bartlett, JRSS B 25, 1963; A. C. A. Hope, "A
// simplified Monte Carlo significance test procedure", JRSS B 30, 1968).

/** One line's fitted amplitude of a ring or pattern for the corner-locking test. */
export interface CornerPhasor {
  /** Coefficients of the raw cos and sin columns, mm, their argument measured from the corner. */
  a: number
  b: number
  /** Precision of (a, b), 1/mm^2: the mean of the diagonal of their information matrix (the
   *  isotropic part, which a rotation of the phase leaves unchanged). */
  precision: number
  cornerSpeedMmS: number
  /** The trace's lateral sign relative to the run-up (lineTracer.TracedLine). */
  lateralTowardRunUp: 1 | -1
}

/** Level of each of the gate's two tests, half the flow's: the union of the two keeps a forced
 *  tone's acceptance at most DETECTION_ALPHA. */
export const CORNER_TRANSIENT_ALPHA = DETECTION_ALPHA / 2

/** Critical value of the boundary likelihood ratio test of zeta = 0 at CORNER_TRANSIENT_ALPHA
 *  (Self and Liang 1987): P(0.5 chi2_0 + 0.5 chi2_1 > c) = alpha / 2 gives c = z_(1-alpha/2)^2,
 *  10.83 at alpha 0.001. */
export const DECAY_CRITICAL = normalQuantile(1 - CORNER_TRANSIENT_ALPHA) ** 2

/**
 * Monte Carlo replicates N of the corner-locking test. The Monte Carlo p-value (1 + #{replicate
 * >= observed}) / (N + 1) is exact at a level alpha when alpha (N + 1) is an integer (Hope 1968);
 * at CORNER_TRANSIENT_ALPHA, (N + 1) alpha = 50. The power lost against the exact randomization
 * test shrinks as (N + 1) alpha grows and is small from about 10 on (F. H. C. Marriott, "Barnard's
 * Monte Carlo tests: how many simulations?", Applied Statistics 28, 1979), so 50 leaves it
 * negligible, at a few milliseconds per test.
 */
export const CORNER_LOCKING_REPLICATES = 99_999

/** Fixed seed of the Monte Carlo replicates, so the same traces always give the same decision. */
const CORNER_LOCKING_SEED = 0x5eed

/**
 * True when the lines' amplitudes are shown to be locked to the corner at `level` (the
 * randomization test of the header). The decision is made once the count of replicates at or
 * above the observed statistic settles it, so a forced tone ends the run early. Fewer than two
 * lines show nothing: one amplitude has no phase to agree with.
 */
export function cornerLockingShown(phasors: CornerPhasor[], level = CORNER_TRANSIENT_ALPHA): boolean {
  if (phasors.length < 2) return false
  const weights = phasors.map((p) => p.cornerSpeedMmS * p.precision)
  let x = 0
  let y = 0
  phasors.forEach((p, l) => {
    x += weights[l] * p.lateralTowardRunUp * p.a
    y += weights[l] * p.lateralTowardRunUp * p.b
  })
  const observed = x * x + y * y
  const lengths = phasors.map((p, l) => weights[l] * Math.hypot(p.a, p.b))
  // The p-value stays at or below the level while the exceedances stay below this count.
  const allowed = Math.floor(level * (CORNER_LOCKING_REPLICATES + 1))
  const uniform = mulberry32(CORNER_LOCKING_SEED)
  let exceedances = 0
  for (let r = 0; r < CORNER_LOCKING_REPLICATES; r++) {
    let rx = 0
    let ry = 0
    for (const length of lengths) {
      const phase = 2 * Math.PI * uniform()
      rx += length * Math.cos(phase)
      ry += length * Math.sin(phase)
    }
    if (rx * rx + ry * ry >= observed && ++exceedances >= allowed) return false
  }
  return true
}

/** True when the boundary likelihood ratio statistic of zeta = 0 shows the decay at
 *  CORNER_TRANSIENT_ALPHA. */
export function decayShown(decayStatistic: number): boolean {
  return decayStatistic > DECAY_CRITICAL
}

/** The gate itself: a mode is the corner's transient when its corner locking OR its decay is
 *  shown, each at CORNER_TRANSIENT_ALPHA. */
export function cornerTransientShown(mode: { cornerLocked: boolean | null; decayDemonstrated: boolean | null }): boolean {
  return mode.cornerLocked === true || mode.decayDemonstrated === true
}
