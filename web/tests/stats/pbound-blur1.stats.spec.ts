import { describe } from 'vitest'
import { pBoundCalibrationCase } from './pBoundCalibration'
import { NOISE } from './statsSupport'

describe('Detection bound calibration', () => {
  pBoundCalibrationCase('blur1 noise', NOISE.blur1, 3_000_000)
})
