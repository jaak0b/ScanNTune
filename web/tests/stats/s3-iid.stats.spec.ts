import { describe } from 'vitest'
import { coverageCase } from './coverage'
import { NOISE } from './statsSupport'

describe('S3 coverage', () => {
  coverageCase('iid noise', NOISE.iid, 5_000_000)
})
