import { describe } from 'vitest'
import { coverageCase } from './coverage'
import { NOISE } from './statsSupport'

describe('S3 coverage', () => {
  // The rings and scan noise of the iid case with 1% of the samples displaced by 0.025 to 0.075 mm
  // (dust, hairs). Set aside as additive outliers, they leave the interval honest: without that,
  // they inflated the standard error beyond the spread of the estimates.
  coverageCase('iid noise with 1% impulse outliers', NOISE.iid, 5_000_000, { impulseOutliers: { fraction: 0.01, ampMm: 0.05 } })
})
