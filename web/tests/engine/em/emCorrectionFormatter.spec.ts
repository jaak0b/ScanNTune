import { describe, expect, it } from 'vitest'
import { emCorrection } from '../../../src/engine/em/emCorrectionFormatter'

describe('emCorrection', () => {
  it('computes the new flow percent from the ratio of nominal to measured width', () => {
    const result = emCorrection('Marlin', 95, 0.42, 0.437)
    expect(result.newFlowPercent).toBeCloseTo(91.3, 1)
  })

  it('emits an M221 command for Marlin', () => {
    const result = emCorrection('Marlin', 100, 0.45, 0.45)
    expect(result.command).toBe('M221 S100')
  })

  it('emits an M221 command for RepRapFirmware', () => {
    const result = emCorrection('RepRapFirmware', 100, 0.45, 0.45)
    expect(result.command).toBe('M221 S100')
  })

  it('emits an M221 command for Klipper and advises setting the slicer flow instead', () => {
    const result = emCorrection('Klipper', 95, 0.42, 0.437)
    expect(result.command).toBe('M221 S91.3')
    expect(result.summary.toLowerCase()).toContain('slicer flow')
  })

  it('mentions the slicer flow value in the summary for all firmwares', () => {
    for (const firmware of ['Marlin', 'RepRapFirmware', 'Klipper'] as const) {
      const result = emCorrection(firmware, 95, 0.42, 0.437)
      expect(result.summary).toContain('91.3')
    }
  })

  it('rounds newFlowPercent to one decimal', () => {
    const result = emCorrection('Marlin', 100, 0.4, 0.399)
    expect(result.newFlowPercent).toBe(100.3)
  })
})
