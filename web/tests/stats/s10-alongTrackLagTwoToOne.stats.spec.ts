import { describe } from 'vitest'
import { alongTrackLagCase } from './alongTrackLag'

describe('S10 along-track lag', () => {
  // A pair two to one, as on a printer with a heavy moving bed: X at 35 Hz and Y at 70 Hz,
  // damping 0.05, each about c / w_d at the 100 mm/s top rung (0.455 and 0.227 mm). The 70 Hz
  // ring is phase modulated by up to about 1.9 rad, so uncorrected Y reads the sideband near
  // 105 Hz or is refused.
  alongTrackLagCase(
    'X 35 Hz and Y 70 Hz',
    { frequencyHz: 35, dampingRatio: 0.05, ampMm: 0.45, phaseRad: -Math.PI / 2 },
    { frequencyHz: 70, dampingRatio: 0.05, ampMm: 0.23, phaseRad: -Math.PI / 2 },
    'y',
    10_200_000,
  )
})
