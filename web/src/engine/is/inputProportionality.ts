import { noncentralTPower, tCdf, tQuantile } from '../studentT'
import { noncentralityForPower } from '../math'
import { DETECTION_ALPHA, SPEED_CHECK_POWER } from './types'
import { DETECTION_GRID } from './ringRegressors'
import { solveSymmetric } from './ringGls'
import type { LineBasis } from './ringGls'
import type { CheckState } from './resultTypes'

/**
 * The forced tone the gate must reject with the flow's design power (SPEED_CHECK_POWER): a tone
 * each line detects on its own, at the per-line detection threshold. A line's ring statistic is
 * chi2_2 without a ring, its Bonferroni critical value over the grid is 2 ln(|G| / alpha) (the
 * chi2_2 tail is e^(-x/2)), and the threshold is the noncentrality lambda that exceeds it with the
 * design power. A tone of that strength stands sqrt(lambda) standard errors high in every line's
 * amplitude (6.92 at the default grid and level).
 */
const TONE_AMPLITUDE_SE = Math.sqrt(
  noncentralityForPower(2, 2 * Math.log(DETECTION_GRID.length / DETECTION_ALPHA), SPEED_CHECK_POWER),
)

/**
 * Input proportionality: the ring is the linear response to the corner's velocity step, so each
 * line's ring amplitude at the corner is proportional to its corner speed, one scale per speed
 * tier, and the regression of the amplitudes on the corner speeds passes through zero. The
 * ordinary least squares fit amplitude = b0 + b_T c (one slope per tier, one shared intercept)
 * and the two-sided Student t test of b0 = 0 with K - 1 - T degrees of freedom (Seber and Lee,
 * "Linear Regression Analysis", 2003, s4.4) use the residual scatter of the lines themselves as
 * the error, so a misfit of the same order on every line widens the test instead of rejecting a
 * real ring, and the corner-time phase, which a corner position error of hundredths of a
 * millimetre at a slow corner shifts by tenths of a radian, does not enter. A forced tone keeps
 * its amplitude on every rung, so its intercept carries the whole amplitude and the test rejects:
 * 'failed'.
 *
 * The test is the only gate against a forced tone, so a pass counts only where the test could
 * have failed: its power against a tone at the per-line detection threshold (TONE_AMPLITUDE_SE
 * standard errors on every line, so the intercept's t is noncentral with
 * delta = TONE_AMPLITUDE_SE / sqrt([(X'X)^-1]_00), set by the lines' corner speeds and tiers alone)
 * must reach the design power. Fewer lines, or corner speeds too close together to extrapolate to
 * zero, give 'not-assessed', as does a fit without residual degrees of freedom.
 */
export function proportionalityCheck(bases: LineBasis[], amplitude: number[]): CheckState {
  const tiers = [...new Set(bases.map((b) => b.rec.speedMmS))]
  const K = bases.length
  const dof = K - 1 - tiers.length
  if (dof < 1) return 'not-assessed'
  // Columns: intercept, then one corner-speed column per tier.
  const columns = [bases.map(() => 1), ...tiers.map((v) => bases.map((b) => (b.rec.speedMmS === v ? b.rec.cornerSpeedMmS : 0)))]
  const n = columns.length
  const A = columns.map((ci) => columns.map((cj) => ci.reduce((s, v, k) => s + v * cj[k], 0)))
  const g = columns.map((ci) => ci.reduce((s, v, k) => s + v * amplitude[k], 0))
  const beta = solveSymmetric(A, g)
  const e0 = solveSymmetric(A, columns.map((_, i) => (i === 0 ? 1 : 0)))
  if (beta === null || e0 === null) return 'not-assessed'
  let ssr = 0
  for (let k = 0; k < K; k++) {
    let fitted = 0
    for (let j = 0; j < n; j++) fitted += beta[j] * columns[j][k]
    ssr += (amplitude[k] - fitted) ** 2
  }
  const se = Math.sqrt((ssr / dof) * e0[0])
  if (!(se > 0)) return beta[0] === 0 ? 'passed' : 'failed'
  const p = 2 * (1 - tCdf(Math.abs(beta[0]) / se, dof))
  if (!(p > DETECTION_ALPHA)) return 'failed'
  const power = noncentralTPower(TONE_AMPLITUDE_SE / Math.sqrt(e0[0]), dof, tQuantile(1 - DETECTION_ALPHA / 2, dof))
  return power >= SPEED_CHECK_POWER ? 'passed' : 'not-assessed'
}
