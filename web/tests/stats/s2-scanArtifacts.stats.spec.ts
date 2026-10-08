import { describe } from 'vitest'
import { falseAcceptanceCase } from './falseAcceptance'
import { NOISE } from './statsSupport'

describe('S2 false acceptance', () => {
  // JPEG 8 px block pattern, 0.003 mm; pixel locking of a line tilted 1 degree, 0.08 px.
  falseAcceptanceCase('a JPEG block pattern', { noise: NOISE.iid, artifacts: { jpegBlock: { periodPx: 8, ampMm: 0.003 } } }, 4_400_000)
  falseAcceptanceCase('pixel locking', { noise: NOISE.iid, artifacts: { pixelLock: { tiltDeg: 1, ampPx: 0.08 } } }, 4_500_000)
})
