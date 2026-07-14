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
