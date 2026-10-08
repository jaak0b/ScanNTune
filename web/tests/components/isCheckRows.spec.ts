import { describe, expect, it } from 'vitest'
import { isCheckRows } from '../../src/components/isCheckRows'
import type { IsAxisResult } from '../../src/engine/is/resultTypes'

function axis(overrides: Partial<IsAxisResult>): IsAxisResult {
  return {
    axis: 'y',
    accepted: true,
    refusals: [],
    frequencyHz: 60.8,
    dampingRatio: 0.05,
    frequencyCi95Hz: 0.3,
    frequencySeHz: 0.15,
    detectionPBound: 2.1e-14,
    linesDetected: 7,
    decayDemonstrated: true,
    proportionality: 'passed',
    speedCheck: {
      state: 'confirmed',
      tiers: [
        { speedMmS: 106, detected: true, detectionPBound: 1e-9, frequencyHz: 60.84, frequencySeHz: 0.2 },
        { speedMmS: 150, detected: true, detectionPBound: 1e-8, frequencyHz: 61.06, frequencySeHz: 0.2 },
      ],
    },
    replicateCheck: 'not-assessed',
    influenceCheck: 'not-assessed',
    layerShiftDetected: false,
    amplitudeMm: 0.05,
    secondModePBound: null,
    secondMode: null,
    zvSecondModeResidual: null,
    artifacts: [],
    linesUsed: 10,
    linesTraced: 10,
    scanIndex: 0,
    lines: [],
    shapers: null,
    recommended: null,
    ...overrides,
  }
}

describe('isCheckRows', () => {
  it('lists every check of a two-tier axis as its own labeled raw value', () => {
    expect(isCheckRows(axis({}))).toEqual([
      { label: 'Lines with ringing detected', value: '7 of 10' },
      { label: 'Detection p-value bound', value: '2.1e-14' },
      { label: 'Decay demonstrated', value: 'yes' },
      { label: 'Grows with corner speed', value: 'yes' },
      { label: 'Speed independence', value: 'confirmed' },
      { label: 'Frequency at 106 mm/s', value: '60.8 Hz' },
      { label: 'Frequency at 150 mm/s', value: '61.1 Hz' },
      { label: 'Replicate check', value: 'not assessed' },
      { label: 'Layer shift detected', value: 'no' },
    ])
  })

  it('names a tier without ringing and the changed-with-speed state', () => {
    const rows = isCheckRows(
      axis({
        speedCheck: {
          state: 'not-confirmed',
          tiers: [
            { speedMmS: 106, detected: false, detectionPBound: 0.4, frequencyHz: null, frequencySeHz: null },
            { speedMmS: 150, detected: true, detectionPBound: 1e-8, frequencyHz: 61.06, frequencySeHz: 0.2 },
          ],
        },
      }),
    )
    expect(rows).toContainEqual({ label: 'Speed independence', value: 'not confirmed' })
    expect(rows).toContainEqual({ label: 'Frequency at 106 mm/s', value: 'no ringing detected' })
    expect(isCheckRows(axis({ speedCheck: { state: 'changed', tiers: [] } }))).toContainEqual({
      label: 'Speed independence',
      value: 'changed with speed',
    })
  })

  it('adds the single-line row only where a one-tier coupon assessed it', () => {
    const rows = isCheckRows(axis({ speedCheck: { state: 'not-assessed', tiers: [] }, influenceCheck: 'failed' }))
    expect(rows).toContainEqual({ label: 'Speed independence', value: 'not assessed' })
    expect(rows).toContainEqual({ label: 'Detection without any single line', value: 'no' })
    expect(isCheckRows(axis({})).map((r) => r.label)).not.toContain('Detection without any single line')
  })

  it('shows a bound above 0.001 in plain digits and an unassessed axis as not assessed', () => {
    const rows = isCheckRows(axis({ detectionPBound: 0.068, decayDemonstrated: null, layerShiftDetected: null }))
    expect(rows).toContainEqual({ label: 'Detection p-value bound', value: '0.068' })
    expect(rows).toContainEqual({ label: 'Decay demonstrated', value: 'not assessed' })
    expect(rows).toContainEqual({ label: 'Layer shift detected', value: 'not assessed' })
  })
})
