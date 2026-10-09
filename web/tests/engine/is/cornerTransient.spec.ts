import { describe, expect, it } from 'vitest'
import { cornerLockingShown } from '../../../src/engine/is/cornerTransient'
import type { CornerPhasor } from '../../../src/engine/is/cornerTransient'
import { mulberry32 } from '../../../src/engine/math'

// Eight lines with the default ladder's corner speeds on both tiers, alternating lateral signs and
// two anisotropic precision matrices (standard errors of about 0.0005 and 0.001 mm along their
// axes, correlated), so the test runs through the whitening of every line's amplitude.
const CORNER_SPEEDS = [20, 22.6, 25.5, 60, 20, 22.6, 25.5, 60]
const PRECISIONS = [
  { aa: 4e6, ab: 1.5e6, bb: 1e6 },
  { aa: 1e6, ab: -0.5e6, bb: 3e6 },
]

function lines(amplitude: (l: number, c: number) => [number, number]): CornerPhasor[] {
  return CORNER_SPEEDS.map((c, l) => {
    const sign = l % 2 === 0 ? 1 : -1
    const [a, b] = amplitude(l, c)
    return { a: sign * a, b: sign * b, precision: PRECISIONS[l % 2], cornerSpeedMmS: c, lateralTowardRunUp: sign }
  })
}

describe('cornerLockingShown', () => {
  it('shows a response proportional to the corner speed as locked and a forced tone as not', () => {
    // Locked: every line rings with one response per unit corner speed, (1e-4, -0.6e-4) mm per
    // mm/s, turned toward its run-up. Forced tone: 0.003 mm on every line, its phase at the corner
    // drawn uniformly per line (seeded), whatever the corner speed.
    const locked = lines((_, c) => [1e-4 * c, -0.6e-4 * c])
    const phase = mulberry32(7)
    const tone = lines(() => {
      const angle = 2 * Math.PI * phase()
      return [0.003 * Math.cos(angle), 0.003 * Math.sin(angle)]
    })
    expect(cornerLockingShown(locked)).toBe(true)
    expect(cornerLockingShown(tone)).toBe(false)
  })
})
