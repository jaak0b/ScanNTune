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

  // The least-squares separation only needs the angles to differ (modulo 180); turns equal modulo
  // 180, or too close to it, leave the scanner terms inseparable from the printer's.
  it.each([0.0, 5.0, 176.0, 184.0, 355.0])('a degenerate turn is invalid (%s)', (turn) => {
    const r = combineScans(scan(0.0, false), scan(turn, false))
    expect(r.rotationLooksValid).toBe(false)
    expect(r.failureReason).toMatch(/quarter turn/)
  })

  it.each([45.0, 70.0, 90.0, 110.0, 250.0, 273.0])('a well-spread turn is valid (%s)', (turn) => {
    const r = combineScans(scan(0.0, false), scan(turn, false))
    expect(r.rotationLooksValid).toBe(true)
    expect(r.failureReason).toBeNull()
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
  // A full skew-flow scan at a given px/mm and placement angle, for the resolution-gate cases.
  function scanAt(pxPerMm: number, angleDegrees: number): AlignedResult {
    const rad = (angleDegrees * Math.PI) / 180.0
    return alignedResult({
      plane: 'XY',
      measuredPxPerMmX: pxPerMm,
      measuredPxPerMmY: pxPerMm,
      orientation: { flipped: false, originX: 0, originY: 0, xAxisX: Math.cos(rad), xAxisY: Math.sin(rad) },
    })
  }

  it('rejects a scan without a plane instead of dropping it', () => {
    expect(() => reconcileScans([alignedResult({ plane: null })], null)).toThrow(/plane/)
  })

  it('rejects a plane with a single scan instead of dropping it', () => {
    expect(() => reconcileScans([alignedResult({ plane: 'XY' })], null)).toThrow(/at least two/)
  })

  it('refuses a set mixing 150 and 300 dpi class scans and identifies the outlier', () => {
    const scans = [scanAt(150 / 25.4, 0), scanAt(150 / 25.4, 90), scanAt(300 / 25.4, 45)]
    expect(() => reconcileScans(scans, null)).toThrow(
      /about 300 dpi while the other scans measure about 150 dpi/,
    )
  })

  it('refuses scans mismatching the expected calibration resolution', () => {
    const scans = [scanAt(150 / 25.4, 0), scanAt(150 / 25.4, 90)]
    expect(() => reconcileScans(scans, 300 / 25.4, 300)).toThrow(/expected resolution is 300 dpi/)
  })

  it('accepts a same-resolution set matching the expected resolution', () => {
    const scans = [scanAt(300 / 25.4, 0), scanAt(300 / 25.4, 90)]
    expect(() => reconcileScans(scans, 300 / 25.4, 300)).not.toThrow()
  })

  it('rejects a non-positive px/mm reference', () => {
    expect(() => applyReference(alignedResult(), 0)).toThrow(/positive/)
    expect(() => applyReference(alignedResult(), -1)).toThrow(/positive/)
  })
})
