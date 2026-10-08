import { describe } from 'vitest'
import { alongTrackLagCase } from './alongTrackLag'

describe('S10 along-track lag', () => {
  // The CoreXY-like pair of s10-alongTrackLag at 0.03 mm on the top rung, about a tenth of the
  // free response: the field regime of faint rings, where the joint path must stay calibrated.
  alongTrackLagCase(
    'faint rings, X 45 Hz and Y 60 Hz at 0.03 mm',
    { frequencyHz: 45, dampingRatio: 0.05, ampMm: 0.03, phaseRad: -Math.PI / 2 },
    { frequencyHz: 60, dampingRatio: 0.05, ampMm: 0.03, phaseRad: -Math.PI / 2 },
    null,
    10_300_000,
  )
})
