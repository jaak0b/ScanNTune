import { describe } from 'vitest'
import { falseAcceptanceCase } from './falseAcceptance'
import { NOISE } from './statsSupport'

describe('S2 false acceptance', () => {
  // The first-order flow lag of the commanded flow at both ends of its 20 to 60 ms range.
  falseAcceptanceCase('a 20 ms flow-lag lobe', { noise: NOISE.iid, flowLag: { tauS: 0.02, ampMm: 0.03 } }, 4_600_000)
  falseAcceptanceCase('a 60 ms flow-lag lobe', { noise: NOISE.iid, flowLag: { tauS: 0.06, ampMm: 0.03 } }, 4_700_000)
})
