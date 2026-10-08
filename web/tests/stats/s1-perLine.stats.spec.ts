import { describe } from 'vitest'
import { chiSquareCalibrationCase } from './chiSquareCalibration'
import { NOISE, TWO_TIER } from './statsSupport'

describe('S1 per-point chi-square calibration', () => {
  chiSquareCalibrationCase('perLine noise', TWO_TIER, NOISE.perLine, 1_000_000)
})
