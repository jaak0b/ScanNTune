import { describe, expect, it } from 'vitest'
import {
  emCorrection,
  flowRatioRelativeSe,
  formatSlicerFlow,
} from '../../../src/engine/em/emCorrectionFormatter'

/** The percentage an M221 command sets. */
const m221Percent = (command: string): number => Number(command.replace('M221 S', ''))

// Hand derivations below use the coupon's commanded cross-section, nominal width x layer
// height, and the slicers' rounded bead cross-section of the measured width w,
// A(w, h) = h * (w - h * (1 - pi / 4)), where h * (1 - pi / 4) = 0.2 * 0.2146018 = 0.0429204
// at h = 0.2 mm.

describe('emCorrection', () => {
  it('expresses the flow in the rounded bead model: nominal 0.42 measured 0.437 at 0.2 mm reads 106.6 percent', () => {
    // Commanded 0.42 x 0.2 = 0.084 mm^2. A(0.437) = 0.2 x (0.437 - 0.0429204) = 0.0788159.
    // 0.084 / 0.0788159 = 1.065774, rounded once to 106.6.
    const result = emCorrection('Marlin', 0.42, 0.2, 0.437, 1)
    expect(result.newFlowPercent).toBe(106.6)
  })

  it('reads a bead wider than its rounded nominal as too much flow: nominal 0.435 measured 0.5 reads 95.2 percent', () => {
    // Commanded 0.435 x 0.2 = 0.087 mm^2. A(0.5) = 0.2 x (0.5 - 0.0429204) = 0.0914159.
    // 0.087 / 0.0914159 = 0.951694, rounded once to 95.2.
    const result = emCorrection('Marlin', 0.435, 0.2, 0.5, 1)
    expect(result.newFlowPercent).toBe(95.2)
    expect(result.command).toBe('M221 S95.2')
  })

  it('divides the M221 override by the current slicer flow, leaving the slicer flow absolute', () => {
    // A(0.4827) = 0.2 x (0.4827 - 0.0429204) = 0.0879559; 0.084 / 0.0879559 = 0.955026, so the
    // slicer flow is 95.5. A part sliced at flow 0.925 needs the firmware to multiply it by
    // 0.955026 / 0.925 = 1.032461 to print at 0.955026: S103.2.
    const result = emCorrection('Marlin', 0.42, 0.2, 0.4827, 0.925)
    expect(result.newFlowPercent).toBe(95.5)
    expect(result.command).toBe('M221 S103.2')
  })

  it('emits an M221 equal to the slicer percentage when the current slicer flow is 1.0', () => {
    for (const widthMm of [0.4, 0.41, 0.437, 0.45, 0.4813, 0.5, 0.512]) {
      const c = emCorrection('Marlin', 0.45, 0.2, widthMm, 1)
      expect(m221Percent(c.command)).toBe(c.newFlowPercent)
    }
  })

  it('reads a percentage-style current flow the same as the equivalent factor', () => {
    expect(emCorrection('Marlin', 0.42, 0.2, 0.4827, 92.5).command).toBe(
      emCorrection('Marlin', 0.42, 0.2, 0.4827, 0.925).command,
    )
    expect(emCorrection('Marlin', 0.42, 0.2, 0.4827, 92.5).command).toBe('M221 S103.2')
  })

  it('rounds the M221 percentage once from the unrounded ratio', () => {
    // A(0.4) = 0.2 x (0.4 - 0.0429204) = 0.0714159; 0.084 / 0.0714159 = 1.176208. Over a 0.925
    // current flow the raw ratio gives 127.1576 percent (S127.2), while dividing the already
    // rounded 117.6 would give 127.1351 (S127.1).
    expect(emCorrection('Marlin', 0.42, 0.2, 0.4, 0.925).command).toBe('M221 S127.2')
  })

  it('emits the same M221 command for Marlin, RepRapFirmware and Klipper', () => {
    for (const firmware of ['Marlin', 'RepRapFirmware', 'Klipper'] as const) {
      expect(emCorrection(firmware, 0.42, 0.2, 0.437, 1).command).toBe('M221 S106.6')
    }
  })

  it('advises setting the slicer flow instead of M221 on Klipper', () => {
    const result = emCorrection('Klipper', 0.42, 0.2, 0.437, 1)
    expect(result.summary.toLowerCase()).toContain('slicer flow')
  })

  it('mentions the slicer flow value in the summary for all firmwares', () => {
    for (const firmware of ['Marlin', 'RepRapFirmware', 'Klipper'] as const) {
      const result = emCorrection(firmware, 0.42, 0.2, 0.437, 0.925)
      expect(result.summary).toContain('106.6')
    }
  })
})

describe('flowRatioRelativeSe', () => {
  it('scales the width relative standard error by the rounded bead width sensitivity', () => {
    // w = 0.5, h = 0.2: sensitivity w x h / A(w) = 0.1 / 0.0914159 = 1.093901. A standard error of
    // 0.01 mm is 0.02 relative, so the flow ratio's relative standard error is 0.0218780.
    expect(flowRatioRelativeSe(0.5, 0.01, 0.2)).toBeCloseTo(0.021878, 6)
  })
})

describe('formatSlicerFlow', () => {
  const flow87 = 87

  it('shows 0.870 for an entered factor of 0.925, never the product of the two', () => {
    expect(formatSlicerFlow(flow87, null, 0.925)).toBe('0.870')
  })

  it('shows 87.0% for an entered percentage of 92.5, never the product of the two', () => {
    expect(formatSlicerFlow(flow87, null, 92.5)).toBe('87.0%')
  })

  it('shows the same number whatever value is entered in the same style', () => {
    expect(formatSlicerFlow(flow87, null, 0.5)).toBe(formatSlicerFlow(flow87, null, 1.4))
    expect(formatSlicerFlow(flow87, null, 50)).toBe(formatSlicerFlow(flow87, null, 140))
  })

  it('reads entered values above 5 as a percentage and values up to 5 as a factor', () => {
    expect(formatSlicerFlow(flow87, null, 5)).toBe('0.870')
    expect(formatSlicerFlow(flow87, null, 5.01)).toBe('87.0%')
  })

  it('applies the relative standard error to the shown value in either style', () => {
    expect(formatSlicerFlow(flow87, 0.02, 0.925)).toBe('0.870 ± 0.017')
    expect(formatSlicerFlow(flow87, 0.02, 92.5)).toBe('87.0 ± 1.7%')
  })

  it('agrees with the M221 command at a current flow of 1.0 for every rounded percentage in both styles', () => {
    for (const widthMm of [0.4, 0.41, 0.437, 0.45, 0.4813, 0.5, 0.512]) {
      const c = emCorrection('Marlin', 0.45, 0.2, widthMm, 1)
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
