import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../../src/engine/math'
import { movingBlockResample, politisWhiteBlockLength } from '../../src/engine/blockBootstrap'

// Synthetic ground truth for the block-length rule: an AR(1) series x_t = 0.6 x_{t-1} + e_t with
// unit innovation variance has gamma(0) = 1 / (1 - 0.36) = 1.5625, long-run variance
// sum_k gamma(k) = 1 / (1 - 0.6)^2 = 6.25 and sum_k |k| gamma(k) = 2 gamma(0) 0.6 / 0.4^2 = 11.72,
// so the Politis and White optimum for the moving-block bootstrap at n = 2000 is
// (2 x 11.72^2 / ((4 / 3) x 6.25^2))^(1/3) x 2000^(1/3) = 1.741 x 12.60 = 21.9 samples, and the
// standard error of the mean is sqrt(6.25 / 2000) = 0.0559, twice the sqrt(1.5625 / 2000) = 0.0280
// that independent resampling reports (all hand-computed).

/** Standard normal draws by the Box-Muller transform over a seeded mulberry32 stream. */
function gaussianStream(seed: number): () => number {
  const uniform = mulberry32(seed)
  return () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform())
}

/** n samples of a unit-innovation AR(1) process, after a burn-in that forgets the zero start. */
function simulateAr1(phi: number, n: number, seed: number, burnIn = 1000): number[] {
  const noise = gaussianStream(seed)
  const x: number[] = []
  let prev = 0
  for (let t = 0; t < burnIn + n; t++) {
    prev = phi * prev + noise()
    if (t >= burnIn) x.push(prev)
  }
  return x
}

/** A rand stand-in that returns the given uniforms in order. */
function scriptedRand(values: number[]): () => number {
  let i = 0
  return () => values[i++]
}

describe('movingBlockResample', () => {
  it('draws whole blocks from inside one segment', () => {
    const segments = [
      [1, 2, 3],
      [10, 20, 30],
    ]

    const resample = movingBlockResample(segments, 3, scriptedRand([0.9, 0.1]))

    expect(resample).toEqual([10, 20, 30, 1, 2, 3])
  })

  it('cuts the last block short to keep the sample count', () => {
    // Block starts 0, 1, 2, 3; the uniforms pick starts 0, 2 and 3.
    const resample = movingBlockResample([[1, 2, 3, 4, 5]], 2, scriptedRand([0, 0.5, 0.99]))

    expect(resample).toEqual([1, 2, 3, 4, 4])
  })

  it('draws single samples from every segment at block length 1', () => {
    const resample = movingBlockResample([[1, 2], [3]], 1, scriptedRand([0.5, 0, 0.9]))

    expect(resample).toEqual([2, 1, 3])
  })

  it('throws when no segment can hold one block', () => {
    expect(() => movingBlockResample([[1, 2], [3, 4]], 3, scriptedRand([0]))).toThrow(
      'No segment is long enough to hold a block of 3 samples',
    )
  })

  it('throws on a block length that is not a positive integer', () => {
    expect(() => movingBlockResample([[1, 2, 3]], 1.5, scriptedRand([0]))).toThrow(
      'The block length must be a positive integer, got 1.5',
    )
  })

  it('reports the long-run standard error of an AR(1) mean that independent resampling halves', () => {
    const x = simulateAr1(0.6, 2000, 1)
    const blockLength = politisWhiteBlockLength([x])
    const rand = mulberry32(7)
    const means: number[] = []
    for (let b = 0; b < 400; b++) {
      const resample = movingBlockResample([x], blockLength, rand)
      means.push(resample.reduce((a, v) => a + v, 0) / resample.length)
    }

    const mean = means.reduce((a, v) => a + v, 0) / means.length
    const se = Math.sqrt(means.reduce((a, v) => a + (v - mean) ** 2, 0) / (means.length - 1))

    // Truth 0.0559; the moving-block estimate runs a little low (its bias is of order 1 / b) and
    // over 30 seeds spread from 0.044 to 0.059, so 25 percent either side holds every seed while
    // independent resampling (0.028, at most 0.032 over those seeds) falls far outside.
    expect(se).toBeGreaterThan(0.042)
    expect(se).toBeLessThan(0.07)
  })
})

describe('politisWhiteBlockLength', () => {
  it('selects about 22 samples for an AR(1) series with phi 0.6 over 2000 samples', () => {
    const blockLength = politisWhiteBlockLength([simulateAr1(0.6, 2000, 1)])

    // Optimum 21.9; over 200 seeds the selection's 5th to 95th percentile is 16 to 25.
    expect(blockLength).toBeGreaterThanOrEqual(16)
    expect(blockLength).toBeLessThanOrEqual(28)
  })

  it('selects at most 4 samples for independent samples', () => {
    const blockLength = politisWhiteBlockLength([simulateAr1(0, 2000, 3)])

    // With independent samples the bandwidth is 2 and the rule reduces to
    // (6 n r1^2)^(1/3), n r1^2 chi-square with 1 degree of freedom; its 99.9 percent point 10.83
    // gives 4.0, so a larger block means dependence was invented.
    expect(blockLength).toBeLessThanOrEqual(4)
  })

  it('returns 1 for a constant series', () => {
    expect(politisWhiteBlockLength([[2, 2, 2, 2, 2, 2, 2, 2]])).toBe(1)
  })

  it('never exceeds the longest segment', () => {
    // A strongly dependent series cut into runs of 5 would want blocks of about 19.
    const x = simulateAr1(0.95, 2000, 5)
    const segments: number[][] = []
    for (let i = 0; i < x.length; i += 5) segments.push(x.slice(i, i + 5))

    expect(politisWhiteBlockLength(segments)).toBe(5)
  })
})
