import { describe } from 'vitest'
import { falseAcceptanceCase } from './falseAcceptance'
import { NOISE } from './statsSupport'

describe('S2 false acceptance', () => {
  // Scan noise doubled in the starved bead of a 40 ms flow lag, with the lag's 0.03 mm lobe.
  falseAcceptanceCase(
    'early-noise inflation',
    { noise: NOISE.iid, flowLag: { tauS: 0.04, ampMm: 0.03 }, earlyNoise: { factor: 2, tauS: 0.04 } },
    4_800_000,
  )
  // 1% of the samples displaced by 0.025 to 0.075 mm (dust, hairs, voids).
  falseAcceptanceCase('1% impulse outliers', { noise: NOISE.iid, impulseOutliers: { fraction: 0.01, ampMm: 0.05 } }, 4_900_000)
})
