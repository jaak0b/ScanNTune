// Median of a list (average of the two central values for even length). Returns 0 for an empty list.
export function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  const n = sorted.length
  if (n === 0) return 0
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
}

/** Normal-consistency factor for the MAD (sigma = 1.4826 * MAD for Gaussian data). */
export const MAD_TO_SIGMA = 1.4826
/** Asymptotic standard error of the median is 1.2533 * sigma / sqrt(n) for Gaussian data. */
export const MEDIAN_EFFICIENCY = 1.2533

/** Median absolute deviation of a list about its own median. Returns 0 for an empty list. */
export function mad(values: number[]): number {
  const center = median(values)
  return median(values.map((v) => Math.abs(v - center)))
}

/**
 * Asymptotic standard error of the median of a list, with the spread estimated robustly:
 * 1.2533 * 1.4826 * MAD / sqrt(n). Returns 0 for an empty list.
 */
export function medianStandardError(values: number[]): number {
  if (values.length === 0) return 0
  return (MEDIAN_EFFICIENCY * MAD_TO_SIGMA * mad(values)) / Math.sqrt(values.length)
}

/**
 * Hampel identifier (moving-window median/MAD outlier detector): a sample is flagged when it
 * deviates from the median of its window by more than nSigma robust sigmas (1.4826 * MAD).
 * Returns a boolean mask, true where the sample is an outlier. Non-finite samples pass through
 * unflagged (they are gaps, not outliers) but are excluded from every window. Windows with fewer
 * than 5 finite samples flag nothing (the local statistics are meaningless there). The sigma
 * floor of 0.005 guards the degenerate zero-MAD case (a locally constant signal), where any
 * deviation at all would otherwise be infinite sigmas out.
 */
export function hampelOutliers(values: number[], halfWindow: number, nSigma: number): boolean[] {
  const rejected = new Array<boolean>(values.length).fill(false)
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) continue
    const local: number[] = []
    for (let j = Math.max(0, i - halfWindow); j <= Math.min(values.length - 1, i + halfWindow); j++) {
      if (Number.isFinite(values[j])) local.push(values[j])
    }
    if (local.length < 5) continue
    const center = median(local)
    const sigma = Math.max(MAD_TO_SIGMA * median(local.map((v) => Math.abs(v - center))), 0.005)
    if (Math.abs(values[i] - center) > nSigma * sigma) rejected[i] = true
  }
  return rejected
}

/**
 * Seedable deterministic PRNG (mulberry32, Tommy Ettinger's public-domain generator): a 32-bit
 * state hashed through two rounds of multiply-xorshift per draw, returning uniform floats in
 * [0, 1). Used wherever a reproducible random stream is needed (bootstrap resampling, synthetic
 * fixtures).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
