import { tCdf } from '../studentT'
import { DETECTION_ALPHA } from './types'

/** Fewest lines the test needs: two residual degrees of freedom after intercept, trend and step. */
const MIN_LINES = 5

/**
 * Layer-shift diagnostic: a stepper that skips during the measured layer moves every line printed
 * after the skip sideways by the same amount, so the lines' lateral offsets from their nominal
 * centerlines, taken in print order, show a step. A smooth lateral bow across the coupon is no
 * shift, and because the print order runs across the line field it would otherwise read as one,
 * so the offsets are modeled as a linear trend in the lines' field positions plus a step. The test
 * is the likelihood-ratio test for a change point in simple linear regression (H.-J. Kim and
 * D. Siegmund, "The likelihood ratio test for a change-point in simple linear regression",
 * Biometrika 76(3), 1989, 409-423): for every split of the K lines into those printed before and
 * after it, the t statistic of the step coefficient in the least squares fit of
 * offset = a + b position + delta step (K - 3 degrees of freedom), its two-sided Student-t tail,
 * and a Bonferroni bound over the K - 1 splits. A shift is reported at the flow's false-alarm
 * level. Null when fewer than MIN_LINES lines are available.
 */
export function layerShiftDetected(
  offsetsInPrintOrder: number[],
  positionsInPrintOrder: number[],
): boolean | null {
  const K = offsetsInPrintOrder.length
  if (K < MIN_LINES || positionsInPrintOrder.length !== K) return null
  let best = 1
  for (let k = 1; k < K; k++) {
    const p = stepPValue(offsetsInPrintOrder, positionsInPrintOrder, k)
    if (p !== null) best = Math.min(best, p)
  }
  return Math.min(1, (K - 1) * best) <= DETECTION_ALPHA
}

/** Two-sided p-value of the step at split k in offset = a + b x + delta [i >= k]; null when the
 *  three columns are linearly dependent. */
function stepPValue(y: number[], x: number[], k: number): number | null {
  const K = y.length
  const cols = [y.map(() => 1), x, y.map((_, i) => (i >= k ? 1 : 0))]
  // Normal equations of the three-column least squares fit.
  const A = cols.map((a) => cols.map((b) => a.reduce((s, v, i) => s + v * b[i], 0)))
  const g = cols.map((a) => a.reduce((s, v, i) => s + v * y[i], 0))
  const inv = invert3(A)
  if (inv === null) return null
  const beta = inv.map((row) => row.reduce((s, v, j) => s + v * g[j], 0))
  let ssr = 0
  for (let i = 0; i < K; i++) {
    const fitted = beta[0] + beta[1] * x[i] + beta[2] * cols[2][i]
    ssr += (y[i] - fitted) ** 2
  }
  const variance = ssr / (K - 3)
  const se = Math.sqrt(variance * inv[2][2])
  if (!(se > 0)) return beta[2] !== 0 ? 0 : 1
  return 2 * (1 - tCdf(Math.abs(beta[2]) / se, K - 3))
}

/** Inverse of a symmetric 3 x 3 matrix by cofactors; null when it is singular. */
function invert3(m: number[][]): number[][] | null {
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  const scale = Math.max(...m.flat().map(Math.abs))
  if (!(Math.abs(det) > 1e-12 * scale ** 3)) return null
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ]
}
