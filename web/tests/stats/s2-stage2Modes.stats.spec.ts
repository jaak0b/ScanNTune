import { describe } from 'vitest'
import { falseAcceptanceCase } from './falseAcceptance'
import { NOISE } from './statsSupport'

describe('S2 false acceptance', () => {
  // The ring of the slower pedestal layer the measured bead follows: 30 Hz at 45 mm/s, damping
  // 0.02, 0.005 mm on every line, fixed in arc length (a 1.5 mm period).
  falseAcceptanceCase(
    'the ring of a slower pedestal layer',
    { noise: NOISE.iid, pedestalRing: { frequencyHz: 30, dampingRatio: 0.02, ampMm: 0.005, speedMmS: 45 } },
    5_500_000,
  )
  // A machine mode above the search band: 200 Hz, damping 0.05, 0.03 mm on the top rung.
  falseAcceptanceCase(
    'a mode above the band at 200 Hz',
    { noise: NOISE.iid, extraModes: [{ frequencyHz: 200, dampingRatio: 0.05, ampMm: 0.03 }] },
    5_600_000,
  )
})
