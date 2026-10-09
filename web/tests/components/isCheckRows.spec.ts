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
        { speedMmS: 90, detected: true, detectionPBound: 1e-9, frequencyHz: 60.84, frequencySeHz: 0.2 },
        { speedMmS: 150, detected: true, detectionPBound: 1e-8, frequencyHz: 61.06, frequencySeHz: 0.2 },
      ],
    },
    replicateCheck: 'not-assessed',
    influenceCheck: 'not-assessed',
    layerShiftDetected: false,
    amplitudeMm: 0.05,
    secondModePBound: null,
    secondMode: null,
    artifacts: [],
    cornerModel: null,
    alongTrackLag: null,
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
      { label: 'Frequency at 90 mm/s', value: '60.8 Hz' },
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
            { speedMmS: 90, detected: false, detectionPBound: 0.4, frequencyHz: null, frequencySeHz: null },
            { speedMmS: 150, detected: true, detectionPBound: 1e-8, frequencyHz: 61.06, frequencySeHz: 0.2 },
          ],
        },
      }),
    )
    expect(rows).toContainEqual({ label: 'Speed independence', value: 'not confirmed' })
    expect(rows).toContainEqual({ label: 'Frequency at 90 mm/s', value: 'no ringing detected' })
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

  it('lists a second mode, the found patterns and the corner model as raw rows', () => {
    const rows = isCheckRows(
      axis({
        secondModePBound: 3.2e-9,
        secondMode: { frequencyHz: 62.04, dampingRatio: 0.047, frequencySeHz: 0.4, amplitudeMm: 0.004, proportionality: 'passed' },
        artifacts: [
          { periodMm: 2, pixelLockHarmonic: null, known: true, detectionPBound: 1e-20 },
          { periodMm: 1.7051, pixelLockHarmonic: null, known: false, detectionPBound: 1e-12 },
          { periodMm: null, pixelLockHarmonic: 1, known: true, detectionPBound: 1e-9 },
        ],
        cornerModel: { kind: 'flow-lag', scale: 0.0412 },
      }),
    )
    expect(rows).toContainEqual({ label: 'Second mode p-value bound', value: '3.2e-9' })
    expect(rows).toContainEqual({ label: 'Second mode frequency', value: '62.0 Hz' })
    expect(rows).toContainEqual({ label: 'Second mode damping ratio', value: '0.047' })
    expect(rows).toContainEqual({ label: 'Second mode grows with corner speed', value: 'yes' })
    expect(rows).toContainEqual({ label: 'Print or scan pattern 1 period', value: '2.00 mm' })
    expect(rows).toContainEqual({ label: 'Print or scan pattern 1 source', value: 'GT2 belt pitch' })
    expect(rows).toContainEqual({ label: 'Print or scan pattern 1 harmonic', value: '1' })
    expect(rows).toContainEqual({ label: 'Print or scan pattern 2 period', value: '1.71 mm' })
    expect(rows).toContainEqual({ label: 'Print or scan pattern 2 source', value: 'not a known period' })
    expect(rows).toContainEqual({ label: 'Print or scan pattern 3 source', value: 'pixel locking of the tracer' })
    expect(rows).toContainEqual({ label: 'Print or scan pattern 3 harmonic', value: '1' })
    expect(rows.map((r) => r.label)).not.toContain('Print or scan pattern 2 harmonic')
    expect(rows.map((r) => r.label)).not.toContain('Print or scan pattern 3 period')
    expect(rows).toContainEqual({ label: 'Corner model', value: 'extrusion lag' })
    expect(rows).toContainEqual({ label: 'Extrusion lag time constant', value: '41 ms' })
  })

  it('names the GT2 second harmonic and a JPEG block as separate source and harmonic rows', () => {
    const rows = isCheckRows(
      axis({
        artifacts: [
          { periodMm: 1, pixelLockHarmonic: null, known: true, detectionPBound: 1e-15 },
          { periodMm: 0.3387, pixelLockHarmonic: null, known: true, detectionPBound: 1e-11 },
        ],
      }),
    )
    expect(rows).toContainEqual({ label: 'Print or scan pattern 1 period', value: '1.00 mm' })
    expect(rows).toContainEqual({ label: 'Print or scan pattern 1 source', value: 'GT2 belt pitch' })
    expect(rows).toContainEqual({ label: 'Print or scan pattern 1 harmonic', value: '2' })
    expect(rows).toContainEqual({ label: 'Print or scan pattern 2 period', value: '0.34 mm' })
    expect(rows).toContainEqual({ label: 'Print or scan pattern 2 source', value: 'JPEG block of the scan' })
    expect(rows.map((r) => r.label)).not.toContain('Print or scan pattern 2 harmonic')
  })

  it('reports an applied along-track lag correction as yes with no reason row', () => {
    const rows = isCheckRows(axis({ alongTrackLag: 'corrected' }))
    expect(rows).toContainEqual({ label: 'Corrected for X axis ringing along the lines', value: 'yes' })
    expect(rows.map((r) => r.label)).not.toContain('Reason not corrected')
  })

  it('reports a missing along-track lag correction as no with the reason in its own row', () => {
    const unmeasured = isCheckRows(axis({ axis: 'x', alongTrackLag: 'other-axis-not-measured' }))
    expect(unmeasured).toContainEqual({ label: 'Corrected for Y axis ringing along the lines', value: 'no' })
    expect(unmeasured).toContainEqual({ label: 'Reason not corrected', value: 'Y axis ringing not measured' })
    const failed = isCheckRows(axis({ alongTrackLag: 'joint-fit-failed' }))
    expect(failed).toContainEqual({ label: 'Corrected for X axis ringing along the lines', value: 'no' })
    expect(failed).toContainEqual({ label: 'Reason not corrected', value: 'joint fit of both axes failed' })
  })

  it('omits the along-track lag rows before a joint fit', () => {
    const labels = isCheckRows(axis({})).map((r) => r.label)
    expect(labels).not.toContain('Corrected for X axis ringing along the lines')
    expect(labels).not.toContain('Reason not corrected')
  })

  it('shows the bead drag length for the bead-drag corner model', () => {
    const rows = isCheckRows(axis({ cornerModel: { kind: 'bead-drag', scale: 1.064 } }))
    expect(rows).toContainEqual({ label: 'Corner model', value: 'bead drag' })
    expect(rows).toContainEqual({ label: 'Bead drag length', value: '1.06 mm' })
  })

  it('shows a bound above 0.001 in plain digits and an unassessed axis as not assessed', () => {
    const rows = isCheckRows(axis({ detectionPBound: 0.068, decayDemonstrated: null, layerShiftDetected: null }))
    expect(rows).toContainEqual({ label: 'Detection p-value bound', value: '0.068' })
    expect(rows).toContainEqual({ label: 'Decay demonstrated', value: 'not assessed' })
    expect(rows).toContainEqual({ label: 'Layer shift detected', value: 'not assessed' })
  })
})
