import { describe } from 'vitest'
import { alongTrackLagCase } from './alongTrackLag'

describe('S10 along-track lag', () => {
  // A CoreXY-like pair, X at 45 Hz and Y at 60 Hz, damping 0.05, each about the free response
  // c / w_d of the 100 mm/s top-rung corner (0.354 and 0.266 mm). Uncorrected, X reads about 1% high.
  alongTrackLagCase(
    'X 45 Hz and Y 60 Hz',
    { frequencyHz: 45, dampingRatio: 0.05, ampMm: 0.35, phaseRad: -Math.PI / 2 },
    { frequencyHz: 60, dampingRatio: 0.05, ampMm: 0.27, phaseRad: -Math.PI / 2 },
    'x',
    10_100_000,
  )
})
