import { describe } from 'vitest'
import { dampingMixtureCase } from './dampingMixture'

describe('S6 damping test', () => {
  dampingMixtureCase(1_800_000)
})
