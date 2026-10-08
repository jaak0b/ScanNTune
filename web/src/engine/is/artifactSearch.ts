import { chiSquareSurvivalEvenDof } from '../math'
import { F_MAX_HZ, F_MIN_HZ } from './types'
import { FREQUENCY_GRID_HZ, arcLengthMm, knownArtifactPeriodsMm, periodicColumns } from './ringRegressors'
import { projectColumns, projectPeriodic, ringScratch } from './ringGls'
import type { LineBasis } from './ringGls'
import { heldNoiseStatistic, ringLikelihoodRatio } from './ringLikelihood'
import type { NullFit, TestedComponent } from './ringLikelihood'
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
// The search runs in two stages, each at half the flow's false-alarm level: the known patterns
// first (ringRegressors.knownArtifactPeriodsMm: the GT2 pitch, its harmonic, the JPEG blocks;
// and the tracer's pixel locking, ArtifactCandidate),
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

/**
 * A candidate pattern of the search: an arc-length sinusoid of a period, or the pixel locking of
 * the centroid tracer at a harmonic. The tracer's centroid is pulled toward pixel centres as a
 * periodic function of the bead's sub-pixel position across the line (peak locking, J.
 * Westerweel, Measurement Science and Technology 8(12), 1997; A. K. Prasad et al. 1992), so it
 * is modelled by sin and cos of 2 pi m phi, m = 1, 2, phi the sub-pixel phase of the bead's slow
 * position: the nominal centerline's image coordinate plus the null model's fitted lateral
 * motion (drift, corner term and carried artifacts, no ring), taken from the null fit the search
 * starts from (one pass). On a line tilted against the pixel grid the phase sweeps along the line
 * and the pattern reads as a tone like any arc-length pattern (G. Roth and J. Katz, Measurement
 * Science and Technology 12(2), 2001, on the bias's dependence on the sub-pixel displacement).
 */
export interface ArtifactCandidate {
  /** Spatial period along the line, mm; null for pixel locking. */
  periodMm: number | null
  /** Pixel-locking harmonic m; null for an arc-length period. */
  pixelLockHarmonic: number | null
  /** True for a known period or the pixel locking, false for a grid period. */
  known: boolean
}

/** A pattern the search detected. */
export interface DetectedArtifact extends ArtifactCandidate {
  /** Bonferroni bound of the detection over the stage's candidates. */
  detectionPBound: number
}

/** The known periods over an axis's lines, each once, and the two pixel-locking harmonics. */
export function knownCandidates(bases: LineBasis[]): ArtifactCandidate[] {
  const periods: number[] = []
  for (const b of bases) {
    for (const p of knownArtifactPeriodsMm(b.rec, b.rec.alongPxPerMm)) {
      if (!periods.some((q) => Math.abs(q - p) <= 1e-9 * p)) periods.push(p)
    }
  }
  return [
    ...periods.map((periodMm) => ({ periodMm, pixelLockHarmonic: null, known: true })),
    ...[1, 2].map((m) => ({ periodMm: null, pixelLockHarmonic: m, known: true })),
  ]
}

/** The spatial-frequency grid of the search as period candidates, for the coupon's speed tiers. */
export function gridCandidates(speedsMmS: number[]): ArtifactCandidate[] {
  const vMin = Math.min(...speedsMmS)
  const vMax = Math.max(...speedsMmS)
  const step = FREQUENCY_GRID_HZ / vMax
  const out: ArtifactCandidate[] = []
  for (let k = F_MIN_HZ / vMax; k <= F_MAX_HZ / vMin + 1e-12; k += step) {
    out.push({ periodMm: 1 / k, pixelLockHarmonic: null, known: false })
  }
  return out
}

/** The raw column pair of a candidate on one line, given the line's null fit. */
export function candidateColumns(candidate: ArtifactCandidate, basis: LineBasis, fit: NullFit): Float64Array[] {
  const rec = basis.rec
  if (candidate.periodMm !== null) return periodicColumns(arcLengthMm(rec.tS, rec), [candidate.periodMm])
  const m = candidate.pixelLockHarmonic!
  const cos = new Float64Array(basis.m)
  const sin = new Float64Array(basis.m)
  for (let i = 0; i < basis.m; i++) {
    const slow = rec.y[i] - fit.residual[i]
    const position = rec.acrossImagePx[i] + rec.acrossAxisPxPerMm * slow
    const phase = 2 * Math.PI * m * (position - Math.floor(position))
    cos[i] = Math.cos(phase)
    sin[i] = Math.sin(phase)
  }
  return [cos, sin]
}

/** The held-noise statistic of a candidate on one line: an arc-length period by the closed-form
 *  whitening, pixel locking by its explicit columns. */
function heldStatistic(basis: LineBasis, h0: NullFit, candidate: ArtifactCandidate): number {
  const D =
    candidate.periodMm !== null
      ? projectPeriodic(basis, h0.noise, h0.design, candidate.periodMm, ringScratch(basis.m), new Float64Array(h0.design.k), new Float64Array(h0.design.k)).D
      : (() => {
          const [cos, sin] = candidateColumns(candidate, basis, h0)
          return projectColumns(basis, h0.noise, h0.design, cos, sin).D
        })()
  return heldNoiseStatistic(h0, basis.m, D)
}

/** The component the likelihood ratio of a candidate tests on one line. */
function testedComponent(candidate: ArtifactCandidate, basis: LineBasis, h0: NullFit): TestedComponent {
  return candidate.periodMm !== null ? { periodMm: candidate.periodMm } : { columns: candidateColumns(candidate, basis, h0) }
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
    const ratios = bases.map((b, l) => ringLikelihoodRatio(b, fits[l], testedComponent(candidates[best], b, fits[l])))
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
  return {
    artifact: { ...candidates[best], detectionPBound: pBound },
    columns: bases.map((b, l) => candidateColumns(candidates[best], b, fits[l])),
  }
}
