import { describe } from 'vitest'
import { chiSquareCalibrationCase } from './chiSquareCalibration'
import { NOISE, TWO_TIER } from './statsSupport'

describe('S1 per-point chi-square calibration', () => {
  chiSquareCalibrationCase('iid noise', TWO_TIER, NOISE.iid, 1_000_000)
})
