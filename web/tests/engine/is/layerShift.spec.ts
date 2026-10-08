import { describe, expect, it } from 'vitest'
import { layerShiftDetected } from '../../../src/engine/is/layerShift'

// Offsets in mm, in print order, with the lines' field slots as positions. The scatter of about
// 2 um stands for the line-to-line placement of a real print.
const POSITIONS = [0, 1, 3, 2, 4, 5, 7, 6, 8, 9]
const SCATTER = [0.001, -0.002, 0.0015, 0, -0.001, 0.002, -0.0015, 0.0005, -0.0005, 0.001]

describe('layerShiftDetected', () => {
  it('detects a 0.2 mm step after the sixth printed line', () => {
    const offsets = SCATTER.map((v, i) => v + (i >= 6 ? 0.2 : 0))
    expect(layerShiftDetected(offsets, POSITIONS)).toBe(true)
  })
  it('detects a step on the last printed line alone, where the fastest corners print', () => {
    const offsets = SCATTER.map((v, i) => v + (i === 9 ? 0.2 : 0))
    expect(layerShiftDetected(offsets, POSITIONS)).toBe(true)
  })
  it('reports no shift for scatter alone', () => {
    expect(layerShiftDetected(SCATTER, POSITIONS)).toBe(false)
  })
  it('reports no shift for a smooth lateral bow across the line field', () => {
    // A 0.1 mm linear trend across the nine slots: a bowed coupon, not a skipped step.
    const offsets = SCATTER.map((v, i) => v + 0.1 * (POSITIONS[i] / 9))
    expect(layerShiftDetected(offsets, POSITIONS)).toBe(false)
  })
  it('is not assessed with fewer than five lines', () => {
    expect(layerShiftDetected([0, 0.2, 0.2, 0.2], [0, 1, 2, 3])).toBeNull()
  })
})
