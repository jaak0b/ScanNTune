import { describe, expect, it } from 'vitest'
import {
  emCorrection,
  flowRatioRelativeSe,
  formatSlicerFlow,
} from '../../../src/engine/em/emCorrectionFormatter'

/** The percentage an M221 command sets. */
const m221Percent = (command: string): number => Number(command.replace('M221 S', ''))

// Hand derivations below use the slicers' rounded bead cross-section,
// A(w, h) = h * (w - h * (1 - pi / 4)), where h * (1 - pi / 4) = 0.2 * 0.2146018 = 0.0429204
// at h = 0.2 mm. The coupon commands the rounded bead at the nominal width, so the flow ratio is
// A(nominal) / A(measured).

describe('emCorrection', () => {
  it('expresses the flow in the rounded bead model: nominal 0.42 measured 0.437 at 0.2 mm reads 95.7 percent', () => {
    // A(0.42) = 0.2 x (0.42 - 0.0429204) = 0.0754159. A(0.437) = 0.2 x (0.437 - 0.0429204) =
    // 0.0788159. 0.0754159 / 0.0788159 = 0.956861, rounded once to 95.7.
    const result = emCorrection(0.42, 0.2, 0.437, 1)
    expect(result.newFlowPercent).toBe(95.7)
  })

  it('reads a bead wider than nominal as too much flow: nominal 0.435 measured 0.5 reads 85.8 percent', () => {
    // A(0.435) = 0.2 x (0.435 - 0.0429204) = 0.0784159. A(0.5) = 0.2 x (0.5 - 0.0429204) =
    // 0.0914159. 0.0784159 / 0.0914159 = 0.857793, rounded once to 85.8.
    const result = emCorrection(0.435, 0.2, 0.5, 1)
    expect(result.newFlowPercent).toBe(85.8)
    expect(result.command).toBe('M221 S85.8')
  })

  it('reads a bead printed at its nominal width as exactly 100 percent', () => {
    const result = emCorrection(0.45, 0.2, 0.45, 1)
    expect(result.newFlowPercent).toBe(100)
    expect(result.command).toBe('M221 S100')
  })

  it('divides the M221 override by the current slicer flow, leaving the slicer flow absolute', () => {
    // A(0.4378) = 0.2 x (0.4378 - 0.0429204) = 0.0789759; 0.0754159 / 0.0789759 = 0.954923, so
    // the slicer flow is 95.5. A part sliced at flow 0.925 needs the firmware to multiply it by
    // 0.954923 / 0.925 = 1.032349 to print at 0.954923: S103.2.
    const result = emCorrection(0.42, 0.2, 0.4378, 0.925)
    expect(result.newFlowPercent).toBe(95.5)
    expect(result.command).toBe('M221 S103.2')
  })

  it('emits an M221 equal to the slicer percentage when the current slicer flow is 1.0', () => {
    for (const widthMm of [0.4, 0.41, 0.437, 0.45, 0.4813, 0.5, 0.512]) {
      const c = emCorrection(0.45, 0.2, widthMm, 1)
      expect(m221Percent(c.command)).toBe(c.newFlowPercent)
    }
  })

  it('reads a percentage-style current flow the same as the equivalent factor', () => {
    expect(emCorrection(0.42, 0.2, 0.4378, 92.5).command).toBe(
      emCorrection(0.42, 0.2, 0.4378, 0.925).command,
    )
    expect(emCorrection(0.42, 0.2, 0.4378, 92.5).command).toBe('M221 S103.2')
  })

  it('rounds the M221 percentage once from the unrounded ratio', () => {
    // A(0.401) = 0.2 x (0.401 - 0.0429204) = 0.0716159; 0.0754159 / 0.0716159 = 1.053061. Over a
    // 0.963 current flow the raw ratio gives 109.3521 percent (S109.4), while dividing the
    // already rounded 105.3 would give 109.3458 (S109.3).
    expect(emCorrection(0.42, 0.2, 0.401, 0.963).command).toBe('M221 S109.4')
  })

  it('emits the M221 command for the measured flow', () => {
    expect(emCorrection(0.42, 0.2, 0.437, 1).command).toBe('M221 S95.7')
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
      const c = emCorrection(0.45, 0.2, widthMm, 1)
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
