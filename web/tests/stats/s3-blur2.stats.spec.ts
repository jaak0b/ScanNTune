import { describe } from 'vitest'
import { coverageCase } from './coverage'
import { NOISE } from './statsSupport'

describe('S3 coverage', () => {
  coverageCase('blur2 noise', NOISE.blur2, 5_000_000)
})
