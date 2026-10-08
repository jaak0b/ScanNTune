import { describe } from 'vitest'
import { falseAcceptanceCase } from './falseAcceptance'
import { NOISE } from './statsSupport'

describe('S2 false acceptance', () => {
  // A 100 Hz tone fixed in time, 0.002 mm with a random phase on every line.
  falseAcceptanceCase('a forced tone', { noise: NOISE.iid, artifacts: { forcedTone: { frequencyHz: 100, ampMm: 0.002 } } }, 4_300_000)
})
