// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { analyzeFixture } from '../helpers/cv'
import { applyReference } from '../../src/engine/couponAnalyzer'
import type { AlignedResult } from '../../src/engine/types'

// The per-scan pass defers the pxPerMm reference to combine time, so a DPI change re-prices a cached
// result without re-running any CV. This proves that deferral is faithful: analysing with a reference
// baked in must equal analysing reference-free and applying the same reference afterwards.
const PX_PER_MM = 23.62

let withRef: AlignedResult
let repriced: AlignedResult

beforeAll(async () => {
  withRef = await analyzeFixture([], { pxPerMm: PX_PER_MM })
  const referenceFree = await analyzeFixture([], { pxPerMm: null })
  repriced = applyReference(referenceFree, PX_PER_MM)
}, 60000)

describe('applyReference deferral', () => {
  it('reproduces the baked-in scale errors exactly', () => {
    expect(repriced.xScalePercent).toBeCloseTo(withRef.xScalePercent, 9)
    expect(repriced.yScalePercent).toBeCloseTo(withRef.yScalePercent, 9)
  })

  it('leaves the reference-independent measurements untouched', () => {
    expect(repriced.measuredPxPerMmX).toBe(withRef.measuredPxPerMmX)
    expect(repriced.skewDegrees).toBe(withRef.skewDegrees)
  })
})
