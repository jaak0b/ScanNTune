// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  assessMeasurementBackdrop,
  MAX_BACKDROP_SPREAD_RATIO,
  MIN_BACKDROP_CONTRAST,
} from '../../src/engine/measurementBackdrop'

const repeat = (value: number, n: number) => Array.from({ length: n }, () => value)

describe('assessMeasurementBackdrop', () => {
  it('accepts a bright, even backdrop behind dark plastic', () => {
    const r = assessMeasurementBackdrop(repeat(26, 40), [248, 250, 252, 249, 251, 250])
    expect(r.failure).toBeNull()
    expect(r.contrast).toBeGreaterThan(MIN_BACKDROP_CONTRAST)
    expect(r.spreadRatio).toBeLessThan(MAX_BACKDROP_SPREAD_RATIO)
  })

  it('accepts the inverted polarity (bright plastic on a dark backdrop)', () => {
    const r = assessMeasurementBackdrop(repeat(245, 40), [40, 42, 38, 41, 40, 39])
    expect(r.failure).toBeNull()
  })

  it('refuses a backdrop too similar in brightness to the plastic', () => {
    const r = assessMeasurementBackdrop(repeat(26, 40), repeat(45, 40))
    expect(r.failure).toBe('low-contrast')
  })

  it('refuses an uneven backdrop (textured plate tones)', () => {
    // Tones spanning 40 to 116 against plastic at 26: the spread rivals the contrast.
    const backdrop = [40, 55, 70, 90, 110, 116, 48, 62, 85, 100, 45, 75]
    const r = assessMeasurementBackdrop(repeat(26, 40), backdrop)
    expect(r.failure).toBe('uneven')
    expect(r.spreadRatio).toBeGreaterThan(MAX_BACKDROP_SPREAD_RATIO)
  })

  it('reports low contrast when either tone set is empty', () => {
    expect(assessMeasurementBackdrop([], repeat(200, 5)).failure).toBe('low-contrast')
    expect(assessMeasurementBackdrop(repeat(26, 5), []).failure).toBe('low-contrast')
  })
})
