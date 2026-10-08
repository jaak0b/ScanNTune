/**
 * The moving-block bootstrap for serially dependent samples: block-length selection and block
 * resampling. Pure functions on plain number arrays, shared by every flow that bootstraps
 * along-line samples whose noise is correlated from one sample to the next.
 *
 * The samples come as segments: runs of consecutive, evenly spaced positions of one process
 * (for example the transition windows of one printed line, split wherever a sample was rejected).
 * Neighbours inside a segment are serially dependent; nothing is assumed across a segment
 * boundary, so no autocovariance pair and no resampled block ever straddles one.
 */

/** Runs of consecutive, evenly spaced samples of one process. */
export type Segments = readonly (readonly number[])[]

function totalLength(segments: Segments): number {
  return segments.reduce((s, x) => s + x.length, 0)
}

/**
 * Sample autocovariance R(0..maxLag) of segmented samples around their overall mean, with the
 * usual 1/n normalization (Brockwell and Davis 1991, s7.2) over the pairs that lie inside one
 * segment. A lag no segment spans has no pairs and reads 0.
 */
function sampleAutocovariance(segments: Segments, maxLag: number): number[] {
  const n = totalLength(segments)
  const mean = segments.reduce((s, x) => s + x.reduce((t, v) => t + v, 0), 0) / n
  const r: number[] = []
  for (let k = 0; k <= maxLag; k++) {
    let sum = 0
    for (const x of segments) {
      for (let t = 0; t + k < x.length; t++) sum += (x[t] - mean) * (x[t + k] - mean)
    }
    r.push(sum / n)
  }
  return r
}

/** The flat-top (trapezoidal) lag window of D. N. Politis and J. P. Romano (1995). */
function flatTop(t: number): number {
  const a = Math.abs(t)
  if (a <= 0.5) return 1
  if (a <= 1) return 2 * (1 - a)
  return 0
}

/**
 * The block length of the moving-block bootstrap for the mean of the segmented samples, by the
 * automatic selection of D. N. Politis and H. White ("Automatic block-length selection for the
 * dependent bootstrap", Econometric Reviews 23(1), 2004, 53-70) as corrected by A. Patton,
 * D. N. Politis and H. White (Econometric Reviews 28(4), 2009, 372-375). The correction changes
 * only the stationary bootstrap's constant; the moving-block and circular bootstraps share
 * b = (2 G^2 / D)^(1/3) n^(1/3) with D = (4/3) g(0)^2, where g(0) = sum_k R(k) and
 * G = sum_k |k| R(k) are estimated with the flat-top lag window over |k| <= M. The bandwidth is
 * M = 2 m, m the smallest positive lag after which K_N = max(5, ceil(sqrt(log10 n)))
 * consecutive sample autocorrelations all stay below c sqrt(log10 n / n) with c = 2, searched up
 * to the published cap ceil(sqrt(n)) + K_N. The result is rounded to a whole number of samples
 * and held within [1, min(ceil(min(3 sqrt(n), n / 3)), longest segment)], the published upper
 * bound and the longest block the segments can supply. Independent samples give about 1; a
 * constant series gives 1.
 */
export function politisWhiteBlockLength(segments: Segments): number {
  const n = totalLength(segments)
  if (n < 2) return 1
  const longest = segments.reduce((m, x) => Math.max(m, x.length), 0)
  const kN = Math.max(5, Math.ceil(Math.sqrt(Math.log10(n))))
  const lagCap = Math.ceil(Math.sqrt(n)) + kN
  const upperBound = Math.min(Math.ceil(Math.min(3 * Math.sqrt(n), n / 3)), longest)
  const r = sampleAutocovariance(segments, lagCap)
  if (!(r[0] > 0)) return 1
  const critical = 2 * Math.sqrt(Math.log10(n) / n)
  const insignificant = (lag: number) => Math.abs(r[lag] / r[0]) < critical
  let mHat = -1
  for (let m = 1; mHat < 0 && m + kN <= lagCap; m++) {
    let quiet = true
    for (let k = 1; quiet && k <= kN; k++) quiet = insignificant(m + k)
    if (quiet) mHat = m
  }
  const bandwidth = mHat < 0 ? lagCap : Math.min(2 * mHat, lagCap)
  let g0 = 0
  let g = 0
  for (let k = -bandwidth; k <= bandwidth; k++) {
    const weighted = flatTop(k / bandwidth) * r[Math.abs(k)]
    g0 += weighted
    g += Math.abs(k) * weighted
  }
  const d = (4 / 3) * g0 * g0
  if (!(d > 0)) return 1
  const b = Math.cbrt((2 * g * g) / d) * Math.cbrt(n)
  return Math.max(1, Math.min(Math.round(b), upperBound))
}

/**
 * One moving-block bootstrap resample (H. R. Kunsch, "The jackknife and the bootstrap for general
 * stationary observations", Annals of Statistics 17(3), 1989, 1217-1241): blocks of
 * `blockLength` consecutive samples are drawn uniformly, with replacement, from every block that
 * lies inside one segment, and concatenated until the resample holds as many samples as the
 * segments, the last block cut short. Each block costs one draw of `rand` (uniform on [0, 1)).
 * Block length 1 is the ordinary bootstrap of B. Efron (1979). Throws when the block length is not
 * a positive integer or no segment is long enough to hold one block.
 */
export function movingBlockResample(
  segments: Segments,
  blockLength: number,
  rand: () => number,
): number[] {
  if (!(Number.isInteger(blockLength) && blockLength >= 1)) {
    throw new Error(`The block length must be a positive integer, got ${blockLength}`)
  }
  const starts: { segment: number; offset: number }[] = []
  segments.forEach((x, segment) => {
    for (let offset = 0; offset + blockLength <= x.length; offset++) starts.push({ segment, offset })
  })
  if (starts.length === 0) {
    throw new Error(`No segment is long enough to hold a block of ${blockLength} samples`)
  }
  const n = totalLength(segments)
  const out: number[] = []
  while (out.length < n) {
    const { segment, offset } = starts[Math.floor(rand() * starts.length)]
    const x = segments[segment]
    for (let j = 0; j < blockLength && out.length < n; j++) out.push(x[offset + j])
  }
  return out
}
