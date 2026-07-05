import { describe, it, expect } from 'vitest'
import { combineScans } from '../../src/engine/scanCombiner'
import { reconcileScans } from '../../src/engine/multiPlaneCombiner'
import { applyReference } from '../../src/engine/couponAnalyzer'
import { alignedResult } from '../helpers/results'
import type { AlignedResult } from '../../src/engine/types'

// Mirrors ScanNTune.Tests/CombinerGuardTests.cs.
function scan(xAxisAngleDegrees: number, flipped: boolean): AlignedResult {
  const rad = (xAxisAngleDegrees * Math.PI) / 180.0
  return alignedResult({
    measuredPxPerMmX: 23.6,
    measuredPxPerMmY: 23.6,
    rmsResidualPx: 0.5,
    orientation: { flipped, originX: 0.0, originY: 0.0, xAxisX: Math.cos(rad), xAxisY: Math.sin(rad) },
  })
}

describe('combiner guards', () => {
  it('flip mismatch invalidates the pair', () => {
    const r = combineScans(scan(0.0, false), scan(90.0, true))
    expect(r.flipMismatch).toBe(true)
    expect(r.rotationLooksValid).toBe(false)
  })

  it('same flip state on both scans is accepted', () => {
    const r = combineScans(scan(0.0, true), scan(90.0, true))
    expect(r.flipMismatch).toBe(false)
    expect(r.rotationLooksValid).toBe(true)
  })

  it.each([70.0, 110.0, 250.0])('far-off quarter-turn is invalid (%s)', (turn) => {
    const r = combineScans(scan(0.0, false), scan(turn, false))
    expect(r.rotationLooksValid).toBe(false)
  })

  it.each([87.0, 93.0, 273.0])('near quarter-turn is valid (%s)', (turn) => {
    const r = combineScans(scan(0.0, false), scan(turn, false))
    expect(r.rotationLooksValid).toBe(true)
  })

  it('the combined detection carries the weaker scan consistently', () => {
    const a = alignedResult({ plane: 'XY', ringsDetected: 23 })
    const b = alignedResult({ plane: 'XY', ringsDetected: 22 })
    const r = combineScans(a, b)
    expect(r.combined.ringsDetected).toBe(22)
    expect(r.combined.rings).toBe(b.rings)
  })
})

describe('reconcile input guards', () => {
  it('rejects a scan without a plane instead of dropping it', () => {
    expect(() => reconcileScans([alignedResult({ plane: null })], null)).toThrow(/plane/)
  })

  it('rejects a plane that is not a pair instead of dropping it', () => {
    expect(() => reconcileScans([alignedResult({ plane: 'XY' })], null)).toThrow(/exactly two/)
  })

  it('rejects a non-positive px/mm reference', () => {
    expect(() => applyReference(alignedResult(), 0)).toThrow(/positive/)
    expect(() => applyReference(alignedResult(), -1)).toThrow(/positive/)
  })
})
