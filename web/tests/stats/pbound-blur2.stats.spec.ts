import { describe } from 'vitest'
import { pBoundCalibrationCase } from './pBoundCalibration'
import { NOISE } from './statsSupport'

describe('Detection bound calibration', () => {
  pBoundCalibrationCase('blur2 noise', NOISE.blur2, 3_000_000)
})
