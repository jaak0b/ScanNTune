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
 * Entered slicer flows above this value are read as a percentage; real flow factors live near 1
 * and real percentages near 100, so the two ranges cannot collide.
 */
const PERCENT_ENTRY_THRESHOLD = 5

/** Whether an entered slicer flow is a percentage (96) rather than a factor (0.96). */
function isPercentEntry(enteredFlow: number): boolean {
  return enteredFlow > PERCENT_ENTRY_THRESHOLD
}

/** The entered slicer flow as a factor, whichever style it was entered in. */
function enteredFlowFactor(enteredFlow: number): number {
  return isPercentEntry(enteredFlow) ? enteredFlow / 100 : enteredFlow
}

/** Rounds a percentage once, to the one decimal both outputs show. */
function roundPercent(percent: number): number {
  return Math.round(percent * 10) / 10
}

/**
 * The measured flow ratio r = nominal / measured bead width is the single source of both
 * outputs. A bead printed wider than nominal means too much flow, so the new flow is the
 * nominal/measured ratio, and vice versa.
 *
 * The coupon always prints at flow 1.0, so r is already the absolute slicer flow to set: the
 * entered current flow never enters that value.
 *
 * M221 is different: the firmware multiplies whatever extrusion the slicer commands, so a part
 * sliced at the current flow needs the override r / current to print at r. Both percentages are
 * computed from the unrounded ratio and rounded once.
 */
export function emCorrection(
  firmware: Firmware,
  nominalWidthMm: number,
  wMm: number,
  enteredCurrentFlow: number,
): EmCorrection {
  const ratio = nominalWidthMm / wMm
  const newFlowPercent = roundPercent(100 * ratio)
  const m221Percent = roundPercent((100 * ratio) / enteredFlowFactor(enteredCurrentFlow))
  const command = `M221 S${m221Percent}`
  const summary =
    firmware === 'Klipper'
      ? `Set the slicer flow to ${newFlowPercent}% for a permanent fix; the M221 command above only changes the current session.`
      : `Set the slicer flow to ${newFlowPercent}% to make the correction permanent.`
  return { newFlowPercent, command, summary }
}

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
  if (isPercentEntry(enteredFlow)) {
    const ci = uncertaintyPercent !== null ? ` ± ${uncertaintyPercent.toFixed(1)}` : ''
    return `${newFlowPercent.toFixed(1)}${ci}%`
  }
  const ci = uncertaintyPercent !== null ? ` ± ${(uncertaintyPercent / 100).toFixed(3)}` : ''
  return `${(newFlowPercent / 100).toFixed(3)}${ci}`
}
