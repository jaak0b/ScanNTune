import { describe } from 'vitest'
import { pBoundCalibrationCase } from './pBoundCalibration'
import { NOISE } from './statsSupport'

describe('Detection bound calibration', () => {
  pBoundCalibrationCase('redAr2 noise', NOISE.redAr2, 3_000_000)
})
