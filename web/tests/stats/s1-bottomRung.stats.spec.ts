import { describe } from 'vitest'
import { chiSquareCalibrationCase } from './chiSquareCalibration'
import { BOTTOM_RUNG, NOISE } from './statsSupport'

describe('S1 per-point chi-square calibration', () => {
  // Every corner at the 20 mm/s bottom rung: the window opens inside the longest ramp chirp.
  chiSquareCalibrationCase('the 20 mm/s rung ramp chirp', BOTTOM_RUNG, NOISE.iid, 2_000_000)
})
