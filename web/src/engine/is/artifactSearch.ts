import { chiSquareSurvivalEvenDof } from '../math'
import { F_MAX_HZ, F_MIN_HZ } from './types'
import { FREQUENCY_GRID_HZ, arcLengthMm, knownArtifactPeriodsMm, periodicColumns } from './ringRegressors'
import { projectPeriodic, ringScratch } from './ringGls'
import type { LineBasis, RingProjection } from './ringGls'
import { heldNoiseStatistic, ringLikelihoodRatio } from './ringLikelihood'
import type { NullFit } from './ringLikelihood'
import { cornerLockingShown, ringPhasor } from './cornerTransient'
import type { CornerPhasor } from './cornerTransient'

// Searches an axis's traced lines for stationary arc-length artifacts: patterns fixed along the
// printed path, such as the mesh of a GT2 belt's teeth, or fixed in the scan's pixels, such as
// JPEG blocks or the tracer's pixel locking on a line tilted against the pixel grid. In the time
// base of a line they read as undamped tones whose frequency changes in
// proportion to the line speed (the order tracking view of a Campbell diagram: W. Campbell, "The
// protection of steam-turbine disk wheels from axial vibration", 1924; computed order tracking,
// K. R. Fyfe and E. D. S. Munck, Mechanical Systems and Signal Processing 11(2), 1997), so in arc
// length they are one sinusoid shared by both speed tiers. A detected artifact joins every line's
// null design, the ring detection and the fits then carry it; it is not modelled when absent,
// because a sinusoid column fitted to noise removes noise power at its frequency and biases the
// noise model there.
//
// The search runs in two stages, each at half the flow's false-alarm level: the known patterns
// first (ringRegressors.knownArtifactPeriodsMm: the GT2 pitch, its harmonic, the JPEG blocks),
// then a grid of spatial frequencies over the band the ring search covers on either tier,
// [F_MIN / v_max, F_MAX / v_min] cycles per mm, at the step FREQUENCY_GRID_HZ / v_max (the time
// grid's step on the fastest tier). Within a stage the statistic is the likelihood ratio of the
// sinusoid pair summed over all lines (ringLikelihood.ts, the noise model refitted under each
// hypothesis), its maximum over the stage's candidates paid for by the Bonferroni bound (Dunn
// 1961), and an artifact is detected only when each speed tier's own lines also show it at that
// period at the same level (closed testing, Marcus, Peritz and Gabriel 1976): a ring of the
// machine matches one spatial frequency on one tier only, unless two modes happen to stand in the
// tiers' speed ratio. A known period, whose source is named, is labelled by that significance
// alone. A grid period must also not be shown locked to the corner at the same level
// (cornerTransient.ts): a ring the candidate's columns pick up starts at the corner with one phase
// on every line, while a pattern of unknown origin is taken to sit wherever the line falls on it.
// The known periods are exempt because a belt pattern is locked to a motor, and on this coupon also
// to the corner: each group's corners lie on a 45 degree diagonal, so one CoreXY motor (position
// x + y) stands at the same position at every corner, and its belt's pattern has the same phase on
// every line. The corner-locking test would call that pattern a ring; the closed test over the
// tiers tells them apart, a ring matching a known period on one tier only. A detection is added to
// the null design and the stage repeats. With one tier an artifact
// cannot be told from a ring, so no search runs.

/** A candidate pattern of the search: an arc-length sinusoid of a period. */
export interface ArtifactCandidate {
  /** Spatial period along the line, mm. */
  periodMm: number
  /** True for a known period, false for a grid period. */
  known: boolean
}

/** A pattern the search detected. */
export interface DetectedArtifact extends ArtifactCandidate {
  /** Bonferroni bound of the detection over the stage's candidates. */
  detectionPBound: number
}

/** The known periods over an axis's lines, each once. */
export function knownCandidates(bases: LineBasis[]): ArtifactCandidate[] {
  const periods: number[] = []
  for (const b of bases) {
    for (const p of knownArtifactPeriodsMm(b.rec, b.rec.alongPxPerMm)) {
      if (!periods.some((q) => Math.abs(q - p) <= 1e-9 * p)) periods.push(p)
    }
  }
  return periods.map((periodMm) => ({ periodMm, known: true }))
}

/** The spatial-frequency grid of the search as period candidates, for the coupon's speed tiers. */
export function gridCandidates(speedsMmS: number[]): ArtifactCandidate[] {
  const vMin = Math.min(...speedsMmS)
  const vMax = Math.max(...speedsMmS)
  const step = FREQUENCY_GRID_HZ / vMax
  const out: ArtifactCandidate[] = []
  for (let k = F_MIN_HZ / vMax; k <= F_MAX_HZ / vMin + 1e-12; k += step) {
    out.push({ periodMm: 1 / k, known: false })
  }
  return out
}

/** The raw column pair of a candidate on one line. */
export function candidateColumns(candidate: ArtifactCandidate, basis: LineBasis): Float64Array[] {
  return periodicColumns(arcLengthMm(basis.rec.tS, basis.rec), [candidate.periodMm])
}

/** The held-noise statistic of a candidate on one line, by the closed-form whitening. */
function heldStatistic(basis: LineBasis, h0: NullFit, candidate: ArtifactCandidate): number {
  const k = h0.design.k
  const D = projectPeriodic(basis, h0.noise, h0.design, candidate.periodMm, ringScratch(basis.m), new Float64Array(k), new Float64Array(k)).D
  return heldNoiseStatistic(h0, basis.m, D)
}

/** A line's refitted amplitude of a candidate for the corner-locking test. The alternative's
 *  noise model has unit innovation variance with the variance profiled out, so the noise variance
 *  of the whitened data is the estimate ssr / m. */
function candidatePhasor(basis: LineBasis, ring: RingProjection | null, ssr: number): CornerPhasor {
  return ringPhasor(basis.rec, ring, ssr / basis.m)
}

/**
 * One stage of the search over `candidates` at level `alpha`: the detected candidate with its
 * bound and each line's column pair, or null. `bases` and `fits` are the lines' bases and null
 * fits with the patterns found so far in their null designs.
 */
export function searchStage(
  bases: LineBasis[],
  fits: NullFit[],
  candidates: ArtifactCandidate[],
  alpha: number,
): { artifact: DetectedArtifact; columns: Float64Array[][] } | null {
  if (candidates.length === 0) return null
  const tiers = [...new Set(bases.map((b) => b.rec.speedMmS))]
  if (tiers.length < 2) return null
  // Held-noise statistics everywhere, the refitted ratio at the running maximum until the maximum
  // is a refitted value (each refit only raises a candidate's sum).
  const values = candidates.map((c) => bases.map((b, l) => heldStatistic(b, fits[l], c)))
  const refitted = new Map<number, CornerPhasor[]>()
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
    const ratios = bases.map((b, l) => ringLikelihoodRatio(b, fits[l], { periodMm: candidates[best].periodMm }))
    refitted.set(best, ratios.map((r, l) => candidatePhasor(bases[l], r.fit.ring, r.fit.ssr)))
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
  if (!candidates[best].known && cornerLockingShown(refitted.get(best)!, alpha)) return null
  return {
    artifact: { ...candidates[best], detectionPBound: pBound },
    columns: bases.map((b) => candidateColumns(candidates[best], b)),
  }
}
