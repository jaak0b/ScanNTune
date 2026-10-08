import { describe } from 'vitest'
import { falseAcceptanceCase } from './falseAcceptance'
import { NOISE } from './statsSupport'

describe('S2 false acceptance', () => {
  falseAcceptanceCase('per-line noise levels', { noise: NOISE.perLine }, 4_000_000)
  // Unread samples at 5%, in runs of up to 4, over iid noise.
  falseAcceptanceCase('unread samples', { noise: NOISE.iid, gaps: { fraction: 0.05, maxRun: 4 } }, 4_100_000)
})
