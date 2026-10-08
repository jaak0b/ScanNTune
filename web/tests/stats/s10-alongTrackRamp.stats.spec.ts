import { describe } from 'vitest'
import { defaultIsTestRequest, fitSpecToPrinter } from '../../src/engine/is/types'
import { defaultPrinterProfile } from '../../src/engine/gcode/profileTypes'
import { alongTrackLagCase } from './alongTrackLag'

// A fast Klipper printer, 10,000 mm/s^2: the ramp after each corner drives the axis along the line
// as strongly as the corner does or more. Its lag is near a / w^2 (0.125 mm at 45 Hz) against the
// corner's c / w (0.07 mm on the 20 mm/s bottom rung, 0.35 mm on the top rung), and a correction
// without the ramp's term leaves a spurious second mode near the sum of the two frequencies on
// every axis.
const profile = { ...defaultPrinterProfile(), printAccelMmS2: 10_000 }
const FAST = fitSpecToPrinter(defaultIsTestRequest(profile), profile).spec

describe('S10 along-track lag', () => {
  alongTrackLagCase(
    'with the post-corner ramp at 10,000 mm/s^2, X 45 Hz and Y 60 Hz',
    { frequencyHz: 45, dampingRatio: 0.05, ampMm: 0.35, phaseRad: -Math.PI / 2 },
    { frequencyHz: 60, dampingRatio: 0.05, ampMm: 0.27, phaseRad: -Math.PI / 2 },
    'x',
    10_400_000,
    FAST,
  )
})
