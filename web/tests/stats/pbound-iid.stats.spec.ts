import { describe } from 'vitest'
import { pBoundCalibrationCase } from './pBoundCalibration'
import { NOISE } from './statsSupport'

describe('Detection bound calibration', () => {
  pBoundCalibrationCase('iid noise', NOISE.iid, 3_000_000)
})
