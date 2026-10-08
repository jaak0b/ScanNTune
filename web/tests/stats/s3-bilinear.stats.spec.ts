import { describe } from 'vitest'
import { coverageCase } from './coverage'
import { NOISE } from './statsSupport'

describe('S3 coverage', () => {
  coverageCase('bilinear noise', NOISE.bilinear, 5_000_000)
})
