import { describe } from 'vitest'
import { falseAcceptanceCase } from './falseAcceptance'
import { NOISE } from './statsSupport'

describe('S9 pixel locking', () => {
  // The tracer's centroid locked toward pixel centres by 0.08 px on lines tilted 0.5, 1 and 2
  // degrees against the pixel grid: the sub-pixel phase sweeps along the line, so the bias reads
  // as a tone (periods 4.9, 2.4 and 1.2 mm at 600 dpi).
  falseAcceptanceCase('pixel locking at 0.5 degrees', { noise: NOISE.iid, artifacts: { pixelLock: { tiltDeg: 0.5, ampPx: 0.08 } } }, 5_200_000)
  falseAcceptanceCase('pixel locking at 1 degree', { noise: NOISE.iid, artifacts: { pixelLock: { tiltDeg: 1, ampPx: 0.08 } } }, 5_300_000)
  falseAcceptanceCase('pixel locking at 2 degrees', { noise: NOISE.iid, artifacts: { pixelLock: { tiltDeg: 2, ampPx: 0.08 } } }, 5_400_000)
})
