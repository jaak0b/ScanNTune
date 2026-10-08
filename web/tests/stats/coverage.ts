import { expect, it } from 'vitest'
import type { SimNoise } from '../helpers/isTraceSim'
import { thresholdAmplitudeMm } from './powerSupport'
import { TWO_TIER, analyzeCase } from './statsSupport'
import type { CaseOptions } from './statsSupport'

/**
 * S3, coverage: a 60 Hz ring at damping 0.05, three times the detection threshold amplitude.
 * Of 200 fixed seeds, at least 180 intervals f +/- 1.96 SE must cover 60 Hz (a 0.0012 tail for
 * exact 95% coverage), and the spread of the estimates must match the reported standard error:
 * SD over mean SE within [0.85, 1.15] (three standard errors of an SD ratio at n = 200). `extra`
 * adds mechanisms beyond the scan noise; the amplitude stays three times the scan noise's threshold.
 */
export function coverageCase(
  name: string,
  noise: SimNoise,
  seedBase: number,
  extra: Omit<CaseOptions, 'noise' | 'ring'> = {},
): void {
  it(`covers the true frequency with the reported interval under ${name}`, () => {
    const amp = 3 * thresholdAmplitudeMm(TWO_TIER, noise, 60, 0.05, seedBase)
    let cover = 0
    const estimates: number[] = []
    const errors: number[] = []
    for (let seed = 1; seed <= 200; seed++) {
      const ring = { frequencyHz: 60, dampingRatio: 0.05, ampMm: amp }
      const pool = analyzeCase(TWO_TIER, { noise, ring, ...extra }, seedBase + 1000 + seed)
      if (pool.frequencyHz === null || pool.frequencySeHz === null) continue
      estimates.push(pool.frequencyHz)
      errors.push(pool.frequencySeHz)
      if (Math.abs(pool.frequencyHz - 60) <= 1.959964 * pool.frequencySeHz) cover++
    }
    const mean = estimates.reduce((s, v) => s + v, 0) / estimates.length
    const sd = Math.sqrt(estimates.reduce((s, v) => s + (v - mean) ** 2, 0) / (estimates.length - 1))
    const meanSe = errors.reduce((s, v) => s + v, 0) / errors.length
    console.log(
      `S3 ${name}: amplitude ${amp.toFixed(5)} mm, covered ${cover} of 200, fitted ` +
        `${estimates.length}, SD ${sd.toFixed(4)} Hz, mean SE ${meanSe.toFixed(4)} Hz, ratio ` +
        `${(sd / meanSe).toFixed(3)}`,
    )
    expect(cover).toBeGreaterThanOrEqual(180)
    expect(sd / meanSe).toBeGreaterThanOrEqual(0.85)
    expect(sd / meanSe).toBeLessThanOrEqual(1.15)
  })
}
