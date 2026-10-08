import { describe } from 'vitest'
import { falseAcceptanceCase } from './falseAcceptance'
import { NOISE } from './statsSupport'

describe('S2 false acceptance', () => {
  // The bead dragged at the corner: a lobe decaying over two and three bead widths (0.42 mm),
  // 0.03 mm on the top rung and growing with the rung.
  falseAcceptanceCase('a bead-drag lobe over two bead widths', { noise: NOISE.iid, spatialLobe: { ampMm: 0.03, lambdaMm: 0.84 } }, 5_000_000)
  falseAcceptanceCase('a bead-drag lobe over three bead widths', { noise: NOISE.iid, spatialLobe: { ampMm: 0.03, lambdaMm: 1.26 } }, 5_100_000)
})
