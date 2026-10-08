import { describe } from 'vitest'
import { chiSquareCalibrationCase } from './chiSquareCalibration'
import { NOISE, TWO_TIER } from './statsSupport'

describe('S1 per-point chi-square calibration', () => {
  chiSquareCalibrationCase('blur2 noise', TWO_TIER, NOISE.blur2, 1_000_000)
})
