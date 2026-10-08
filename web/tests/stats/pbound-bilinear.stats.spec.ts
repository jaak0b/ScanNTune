import { describe } from 'vitest'
import { pBoundCalibrationCase } from './pBoundCalibration'
import { NOISE } from './statsSupport'

describe('Detection bound calibration', () => {
  pBoundCalibrationCase('bilinear noise', NOISE.bilinear, 3_000_000)
})
