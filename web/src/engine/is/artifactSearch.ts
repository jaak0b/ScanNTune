import { chiSquareSurvivalEvenDof } from '../math'
import { F_MAX_HZ, F_MIN_HZ } from './types'
import { FREQUENCY_GRID_HZ, arcLengthMm, knownArtifactPeriodsMm, periodicColumns } from './ringRegressors'
import { projectColumns } from './ringGls'
import type { LineBasis } from './ringGls'
import { heldNoiseStatistic, ringLikelihoodRatio } from './ringLikelihood'
import type { NullFit } from './ringLikelihood'
import { proportionalityCheck } from './inputProportionality'

// Searches an axis's traced lines for stationary arc-length artifacts: patterns fixed along the
// printed path, such as the mesh of a GT2 belt's teeth, or fixed in the scan's pixels, such as
// JPEG blocks. In the time base of a line they read as undamped tones whose frequency changes in
// proportion to the line speed (the order tracking view of a Campbell diagram: W. Campbell, "The
// protection of steam-turbine disk wheels from axial vibration", 1924; computed order tracking,
// K. R. Fyfe and E. D. S. Munck, Mechanical Systems and Signal Processing 11(2), 1997), so in arc
// length they are one sinusoid shared by both speed tiers. A detected artifact joins every line's
// null design, the ring detection and the fits then carry it; it is not modelled when absent,
// because a sinusoid column fitted to noise removes noise power at its frequency and biases the
// noise model there.
//
// The search runs in two stages, each at half the flow's false-alarm level: the known periods
// first (ringRegressors.knownArtifactPeriodsMm: the GT2 pitch, its harmonic, the JPEG blocks),
// then a grid of spatial frequencies over the band the ring search covers on either tier,
// [F_MIN / v_max, F_MAX / v_min] cycles per mm, at the step FREQUENCY_GRID_HZ / v_max (the time
// grid's step on the fastest tier). Within a stage the statistic is the likelihood ratio of the
// sinusoid pair summed over all lines (ringLikelihood.ts, the noise model refitted under each
// hypothesis), its maximum over the stage's candidates paid for by the Bonferroni bound (Dunn
// 1961), and an artifact is detected only when each speed tier's own lines also show it at that
// period at the same level (closed testing, Marcus, Peritz and Gabriel 1976): a ring of the
// machine matches one spatial frequency on one tier only, unless two modes happen to stand in the
// tiers' speed ratio. So an artifact must also fail the input-proportionality test
// (inputProportionality.ts) at the same level: its amplitude does not grow with the corner speed,
// a ring's does. A detection is added to the null design and the stage repeats. With one tier an
// artifact cannot be told from a ring, so no search runs.

/** An arc-length artifact the search detected. */
export interface DetectedArtifact {
  /** Spatial period of the pattern along the printed line, mm. */
  periodMm: number
  /** True for a known period (GT2 pitch or harmonic, JPEG block), false for a period the
   *  spatial-frequency search found. */
  known: boolean
  /** Bonferroni bound of the detection over the stage's candidates. */
  detectionPBound: number
}

/** The known periods over an axis's lines, each once. */
export function knownCandidates(bases: LineBasis[]): number[] {
  const out: number[] = []
  for (const b of bases) {
    for (const p of knownArtifactPeriodsMm(b.rec, b.rec.alongPxPerMm)) {
      if (!out.some((q) => Math.abs(q - p) <= 1e-9 * p)) out.push(p)
    }
  }
  return out
}

/** The spatial-frequency grid of the search as periods, mm, for the coupon's speed tiers. */
export function gridCandidates(speedsMmS: number[]): number[] {
  const vMin = Math.min(...speedsMmS)
  const vMax = Math.max(...speedsMmS)
  const step = FREQUENCY_GRID_HZ / vMax
  const out: number[] = []
  for (let k = F_MIN_HZ / vMax; k <= F_MAX_HZ / vMin + 1e-12; k += step) out.push(1 / k)
  return out
}

/** The held-noise statistic of a periodic pair on one line. */
function heldStatistic(basis: LineBasis, h0: NullFit, periodMm: number): number {
  const [cos, sin] = periodicColumns(arcLengthMm(basis.rec.tS, basis.rec), [periodMm])
  const D = projectColumns(basis, h0.noise, h0.design, cos, sin).D
  return heldNoiseStatistic(h0, basis.m, D)
}

/**
 * One stage of the search over `candidates` (periods, mm) at level `alpha`: the detected period
 * and its bound, or null. `bases` and `fits` are the lines' bases and null fits with the
 * artifacts found so far in their null designs.
 */
export function searchStage(
  bases: LineBasis[],
  fits: NullFit[],
  candidates: number[],
  alpha: number,
): { periodMm: number; detectionPBound: number } | null {
  if (candidates.length === 0) return null
  const tiers = [...new Set(bases.map((b) => b.rec.speedMmS))]
  if (tiers.length < 2) return null
  // Held-noise statistics everywhere, the refitted ratio at the running maximum until the maximum
  // is a refitted value (each refit only raises a candidate's sum).
  const values = candidates.map((p) => bases.map((b, l) => heldStatistic(b, fits[l], p)))
  const refitted = new Map<number, number[]>()
  let best = 0
  for (;;) {
    best = 0
    let bestSum = -Infinity
    values.forEach((v, c) => {
      const sum = v.reduce((s, x) => s + x, 0)
      if (sum > bestSum) {
        bestSum = sum
        best = c
      }
    })
    if (refitted.has(best)) break
    const period = candidates[best]
    const ratios = bases.map((b, l) => ringLikelihoodRatio(b, fits[l], { periodMm: period }))
    refitted.set(best, ratios.map((r) => Math.hypot(r.fit.ring?.a ?? 0, r.fit.ring?.b ?? 0)))
    values[best] = values[best].map((held, l) => Math.max(held, ratios[l].statistic))
  }
  const statistics = values[best]
  const total = statistics.reduce((s, x) => s + x, 0)
  const pBound = Math.min(1, candidates.length * chiSquareSurvivalEvenDof(total, 2 * bases.length))
  if (!(pBound <= alpha)) return null
  for (const v of tiers) {
    const members = bases.map((b, l) => (b.rec.speedMmS === v ? l : -1)).filter((l) => l >= 0)
    const tierSum = members.reduce((s, l) => s + statistics[l], 0)
    if (!(chiSquareSurvivalEvenDof(tierSum, 2 * members.length) <= alpha)) return null
  }
  if (proportionalityCheck(bases, refitted.get(best)!) !== 'failed') return null
  return { periodMm: candidates[best], detectionPBound: pBound }
}
