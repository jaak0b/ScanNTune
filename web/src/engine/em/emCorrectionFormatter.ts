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
 * a bead printed wider than nominal means too much flow, so the new flow scales down by the
 * nominal/measured ratio, and vice versa.
 */
export function emCorrection(
  firmware: Firmware,
  currentFlowPercent: number,
  nominalWidthMm: number,
  wMm: number,
): EmCorrection {
  const newFlowPercent = Math.round((currentFlowPercent * (nominalWidthMm / wMm)) * 10) / 10
  const command = `M221 S${newFlowPercent}`
  const summary =
    firmware === 'Klipper'
      ? `Set the slicer flow to ${newFlowPercent}% for a permanent fix; the M221 command above only changes the current session.`
      : `Set the slicer flow to ${newFlowPercent}% to make the correction permanent.`
  return { newFlowPercent, command, summary }
}
