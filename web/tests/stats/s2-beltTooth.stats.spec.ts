import { describe } from 'vitest'
import { falseAcceptanceCase } from './falseAcceptance'
import { NOISE } from './statsSupport'

describe('S2 false acceptance', () => {
  // A GT2 belt-tooth pattern, 2 mm pitch, 0.002 mm on every line of both tiers.
  falseAcceptanceCase('a belt-tooth pattern', { noise: NOISE.iid, artifacts: { beltTooth: { periodMm: 2, ampMm: 0.002 } } }, 4_200_000)
})
