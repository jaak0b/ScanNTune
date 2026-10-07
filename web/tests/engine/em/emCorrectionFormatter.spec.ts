import { describe, expect, it } from 'vitest'
import { emCorrection, formatSlicerFlow } from '../../../src/engine/em/emCorrectionFormatter'

/** The percentage an M221 command sets. */
const m221Percent = (command: string): number => Number(command.replace('M221 S', ''))

describe('emCorrection', () => {
  it('computes the absolute flow percent from the ratio of nominal to measured width', () => {
    const result = emCorrection('Marlin', 0.42, 0.437, 1)
    expect(result.newFlowPercent).toBeCloseTo(96.1, 1)
  })

  it('reads a ratio of 0.870 as 87.0 percent, the flow to set because the coupon prints at 100 percent', () => {
    const result = emCorrection('Marlin', 0.435, 0.5, 1)
    expect(result.newFlowPercent).toBe(87)
    expect(result.command).toBe('M221 S87')
  })

  it('divides the M221 override by the current slicer flow, leaving the slicer flow absolute', () => {
    // A part sliced at flow 0.925 needs the firmware to multiply it by 0.870 / 0.925 to print
    // at 0.870: 94.054 percent, rounded once to 94.1. The slicer flow stays the measured 0.870.
    const result = emCorrection('Marlin', 0.435, 0.5, 0.925)
    expect(result.newFlowPercent).toBe(87)
    expect(result.command).toBe('M221 S94.1')
  })

  it('emits an M221 equal to the slicer percentage when the current slicer flow is 1.0', () => {
    for (const widthMm of [0.4, 0.41, 0.437, 0.45, 0.4813, 0.5, 0.512]) {
      const c = emCorrection('Marlin', 0.45, widthMm, 1)
      expect(m221Percent(c.command)).toBe(c.newFlowPercent)
    }
  })

  it('reads a percentage-style current flow the same as the equivalent factor', () => {
    expect(emCorrection('Marlin', 0.435, 0.5, 92.5).command).toBe(
      emCorrection('Marlin', 0.435, 0.5, 0.925).command,
    )
    expect(emCorrection('Marlin', 0.435, 0.5, 92.5).command).toBe('M221 S94.1')
  })

  it('rounds the M221 percentage once from the unrounded ratio', () => {
    // r = 0.4 / 0.437 = 0.915332. Over a 0.963 current flow the raw ratio gives 95.0500
    // percent (S95.1), while dividing the already rounded 91.5 would give 95.0156 (S95.0).
    expect(emCorrection('Marlin', 0.4, 0.437, 0.963).command).toBe('M221 S95.1')
  })

  it('emits an M221 command for Marlin', () => {
    const result = emCorrection('Marlin', 0.45, 0.45, 1)
    expect(result.command).toBe('M221 S100')
  })

  it('emits an M221 command for RepRapFirmware', () => {
    const result = emCorrection('RepRapFirmware', 0.45, 0.45, 1)
    expect(result.command).toBe('M221 S100')
  })

  it('emits an M221 command for Klipper and advises setting the slicer flow instead', () => {
    const result = emCorrection('Klipper', 0.42, 0.437, 1)
    expect(result.command).toBe('M221 S96.1')
    expect(result.summary.toLowerCase()).toContain('slicer flow')
  })

  it('mentions the slicer flow value in the summary for all firmwares', () => {
    for (const firmware of ['Marlin', 'RepRapFirmware', 'Klipper'] as const) {
      const result = emCorrection(firmware, 0.42, 0.437, 0.925)
      expect(result.summary).toContain('96.1')
    }
  })

  it('rounds newFlowPercent to one decimal', () => {
    const result = emCorrection('Marlin', 0.4, 0.399, 1)
    expect(result.newFlowPercent).toBe(100.3)
  })
})

describe('formatSlicerFlow', () => {
  const ratio087 = emCorrection('Klipper', 0.435, 0.5, 1).newFlowPercent

  it('shows 0.870 for an entered factor of 0.925, never the product of the two', () => {
    expect(formatSlicerFlow(ratio087, null, 0.925)).toBe('0.870')
  })

  it('shows 87.0% for an entered percentage of 92.5, never the product of the two', () => {
    expect(formatSlicerFlow(ratio087, null, 92.5)).toBe('87.0%')
  })

  it('shows the same number whatever value is entered in the same style', () => {
    expect(formatSlicerFlow(ratio087, null, 0.5)).toBe(formatSlicerFlow(ratio087, null, 1.4))
    expect(formatSlicerFlow(ratio087, null, 50)).toBe(formatSlicerFlow(ratio087, null, 140))
  })

  it('reads entered values above 5 as a percentage and values up to 5 as a factor', () => {
    expect(formatSlicerFlow(ratio087, null, 5)).toBe('0.870')
    expect(formatSlicerFlow(ratio087, null, 5.01)).toBe('87.0%')
  })

  it('applies the relative standard error to the shown value in either style', () => {
    expect(formatSlicerFlow(ratio087, 0.02, 0.925)).toBe('0.870 ± 0.017')
    expect(formatSlicerFlow(ratio087, 0.02, 92.5)).toBe('87.0 ± 1.7%')
  })

  it('agrees with the M221 command at a current flow of 1.0 for every rounded percentage in both styles', () => {
    for (const widthMm of [0.4, 0.41, 0.437, 0.45, 0.4813, 0.5, 0.512]) {
      const c = emCorrection('Marlin', 0.45, widthMm, 1)
      const commandPercent = m221Percent(c.command)
      expect(Number(formatSlicerFlow(c.newFlowPercent, null, 96).replace('%', ''))).toBeCloseTo(
        commandPercent,
        6,
      )
      expect(Number(formatSlicerFlow(c.newFlowPercent, null, 0.96))).toBeCloseTo(
        commandPercent / 100,
        6,
      )
    }
  })
})
