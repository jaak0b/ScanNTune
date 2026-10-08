import { describe } from 'vitest'
import { dampingMixtureCase } from './dampingMixture'

describe('S6 damping test', () => {
  dampingMixtureCase(2_800_000)
})
