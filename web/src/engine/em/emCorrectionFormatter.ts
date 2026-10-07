import type { Firmware } from '../pa/types'

export interface EmCorrection {
  /** New slicer flow / extrusion multiplier percentage. */
  newFlowPercent: number
  /** Runtime command per firmware, e.g. 'M221 S97' (Marlin/RRF) or Klipper equivalent. */
  command: string
  /** One-line explanation for the UI. */
  summary: string
}

/**
 * The corrected flow percentage narrows the gap between the measured and nominal bead width:
 * a bead printed wider than nominal means too much flow, so the new flow is the nominal/measured
 * ratio, and vice versa. The coupon always prints at 100 percent flow, so the ratio is already
 * the absolute value to set: no current setting enters the arithmetic. This is the single
 * source for both the M221 command and the slicer flow shown to the user.
 */
export function emCorrection(firmware: Firmware, nominalWidthMm: number, wMm: number): EmCorrection {
  const newFlowPercent = Math.round(100 * (nominalWidthMm / wMm) * 10) / 10
  const command = `M221 S${newFlowPercent}`
  const summary =
    firmware === 'Klipper'
      ? `Set the slicer flow to ${newFlowPercent}% for a permanent fix; the M221 command above only changes the current session.`
      : `Set the slicer flow to ${newFlowPercent}% to make the correction permanent.`
  return { newFlowPercent, command, summary }
}

/**
 * Entered slicer flows above this value are read as a percentage; real flow factors live near 1
 * and real percentages near 100, so the two ranges cannot collide.
 */
const PERCENT_ENTRY_THRESHOLD = 5

/**
 * Formats the corrected slicer flow in the style the user entered their current setting in
 * (factor for an extrusion multiplier / flow ratio, percentage otherwise). The entered value
 * only chooses that style; it never changes the number shown. The uncertainty is the relative
 * standard error of the measured bead width applied to the shown value.
 */
export function formatSlicerFlow(
  newFlowPercent: number,
  relativeSe: number | null,
  enteredFlow: number,
): string {
  const uncertaintyPercent = relativeSe !== null ? relativeSe * newFlowPercent : null
  if (enteredFlow > PERCENT_ENTRY_THRESHOLD) {
    const ci = uncertaintyPercent !== null ? ` ± ${uncertaintyPercent.toFixed(1)}` : ''
    return `${newFlowPercent.toFixed(1)}${ci}%`
  }
  const ci = uncertaintyPercent !== null ? ` ± ${(uncertaintyPercent / 100).toFixed(3)}` : ''
  return `${(newFlowPercent / 100).toFixed(3)}${ci}`
}
