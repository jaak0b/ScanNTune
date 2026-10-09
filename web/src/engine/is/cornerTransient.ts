import { mulberry32, normalQuantile } from '../math'
import { DETECTION_ALPHA } from './types'
import type { LineRecord, RingProjection } from './ringGls'

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
// Corner locking: each line's ring amplitude z_l = (a_l, b_l) at the corner (the coefficients of
// the cos and sin columns, time measured from the corner) is turned toward the line's run-up by its
// lateral sign s_l, the convention of alongTrackLag.ts. Its noise has the covariance P_l^-1, P_l the
// 2 x 2 precision matrix of (a_l, b_l), which a short or strongly damped window leaves anisotropic,
// so each amplitude is whitened first: u_l = P_l^(1/2) s_l z_l, with the symmetric square root, the
// whitening closest to the identity, which leaves a phase shared by the lines as nearly intact as any
// whitening can (A. Kessy, A. Lewin and K. Strimmer, "Optimal whitening and decorrelation", The
// American Statistician 72, 2018). The statistic is the weighted least squares score of one response
// R per unit corner speed through the origin, the output-error model of the corner's linear response
// z_l = c_l s_l R + noise (L. Ljung, "System Identification: Theory for the User", 2nd ed., Prentice
// Hall 1999, s4.2): S = sum_l c_l P_l s_l z_l = sum_l c_l P_l^(1/2) u_l, in its own metric,
// T = S' F^-1 S with F = sum_l c_l^2 P_l. Under the null hypothesis the whitened amplitudes'
// directions are independent and uniform, whatever their lengths (exactly so for the lines' noise,
// whose whitened law is isotropic), so the test is the randomization test of uniform directions
// conditional on the lengths: the observed T against T for u_l rotated by independent uniform angles,
// computed as a Monte Carlo test (G. A. Barnard, discussion of Bartlett, JRSS B 25, 1963; A. C. A.
// Hope, "A simplified Monte Carlo significance test procedure", JRSS B 30, 1968). With isotropic
// noise, P_l = p_l I, it is the test of the length of sum_l c_l p_l s_l z_l.

/** One line's fitted amplitude of a ring or pattern for the corner-locking test. */
export interface CornerPhasor {
  /** Coefficients of the raw cos and sin columns, mm, their argument measured from the corner. */
  a: number
  b: number
  /** Precision matrix of (a, b), 1/mm^2: the inverse of their noise covariance, symmetric. */
  precision: { aa: number; ab: number; bb: number }
  cornerSpeedMmS: number
  /** The trace's lateral sign relative to the run-up (lineTracer.TracedLine). */
  lateralTowardRunUp: 1 | -1
}

/**
 * A line's fitted ring (or pattern) as a phasor of the corner-locking test: the precision of its
 * coefficients is the Gram matrix of their whitened columns over the noise variance `variance` of
 * the whitened data. No ring gives a zero amplitude of zero precision.
 */
export function ringPhasor(rec: LineRecord, ring: RingProjection | null, variance = 1): CornerPhasor {
  return {
    a: ring?.a ?? 0,
    b: ring?.b ?? 0,
    precision: ring ? { aa: ring.G11 / variance, ab: ring.G12 / variance, bb: ring.G22 / variance } : { aa: 0, ab: 0, bb: 0 },
    cornerSpeedMmS: rec.cornerSpeedMmS,
    lateralTowardRunUp: rec.lateralTowardRunUp,
  }
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
  // Per line, the whitened amplitude u and the map M = c P^(1/2) from it into the score.
  const lines = phasors.map((p) => {
    const root = symmetricSqrt(p.precision)
    const u = apply(root, [p.lateralTowardRunUp * p.a, p.lateralTowardRunUp * p.b])
    const map = scale(root, p.cornerSpeedMmS)
    return { u, map }
  })
  const fisher = phasors.reduce<Sym2>((f, p) => add(f, scale(p.precision, p.cornerSpeedMmS ** 2)), { aa: 0, ab: 0, bb: 0 })
  // The metric F^-1 as F^(-1/2) applied to the score, so T is a squared length.
  const metric = inverseSqrt(fisher)
  if (metric === null) return false
  let sx = 0
  let sy = 0
  for (const { u, map } of lines) {
    const [x, y] = apply(metric, apply(map, u))
    sx += x
    sy += y
  }
  const observed = sx * sx + sy * sy
  // A replicate rotates u by an angle t: its contribution is |u| (cos t col1 + sin t col2), with
  // col1, col2 the columns of F^(-1/2) M.
  const columns = lines.map(({ u, map }) => {
    const length = Math.hypot(u[0], u[1])
    const [c1x, c1y] = apply(metric, [map.aa, map.ab])
    const [c2x, c2y] = apply(metric, [map.ab, map.bb])
    return [length * c1x, length * c1y, length * c2x, length * c2y]
  })
  // The p-value stays at or below the level while the exceedances stay below this count.
  const allowed = Math.floor(level * (CORNER_LOCKING_REPLICATES + 1))
  const uniform = mulberry32(CORNER_LOCKING_SEED)
  let exceedances = 0
  for (let r = 0; r < CORNER_LOCKING_REPLICATES; r++) {
    let rx = 0
    let ry = 0
    for (const [c1x, c1y, c2x, c2y] of columns) {
      const angle = 2 * Math.PI * uniform()
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      rx += cos * c1x + sin * c2x
      ry += cos * c1y + sin * c2y
    }
    if (rx * rx + ry * ry >= observed && ++exceedances >= allowed) return false
  }
  return true
}

/** A symmetric 2 x 2 matrix. */
type Sym2 = { aa: number; ab: number; bb: number }

function apply(m: Sym2, v: [number, number]): [number, number] {
  return [m.aa * v[0] + m.ab * v[1], m.ab * v[0] + m.bb * v[1]]
}

function scale(m: Sym2, k: number): Sym2 {
  return { aa: k * m.aa, ab: k * m.ab, bb: k * m.bb }
}

function add(m: Sym2, n: Sym2): Sym2 {
  return { aa: m.aa + n.aa, ab: m.ab + n.ab, bb: m.bb + n.bb }
}

/** The symmetric square root of a positive semidefinite 2 x 2 matrix, (M + sqrt(det) I) /
 *  sqrt(tr + 2 sqrt(det)) by the Cayley-Hamilton theorem; zero for the zero matrix. */
function symmetricSqrt(m: Sym2): Sym2 {
  const rootDet = Math.sqrt(Math.max(0, m.aa * m.bb - m.ab * m.ab))
  const denominator = Math.sqrt(m.aa + m.bb + 2 * rootDet)
  if (!(denominator > 0)) return { aa: 0, ab: 0, bb: 0 }
  return { aa: (m.aa + rootDet) / denominator, ab: m.ab / denominator, bb: (m.bb + rootDet) / denominator }
}

/** The inverse of the symmetric square root of a positive definite 2 x 2 matrix; null when it is
 *  singular. */
function inverseSqrt(m: Sym2): Sym2 | null {
  const root = symmetricSqrt(m)
  const det = root.aa * root.bb - root.ab * root.ab
  if (!(det > 0)) return null
  return { aa: root.bb / det, ab: -root.ab / det, bb: root.aa / det }
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
