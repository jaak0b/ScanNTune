import { beadCrossSectionMm2, roundedBeadCrossSectionMm2 } from '../gcode/emitter'
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
 * The flow ratio to set, expressed in the bead model PrusaSlicer, OrcaSlicer and SuperSlicer
 * slice with. The scan measures the bead's outer width w; those slicers model a bead of that
 * width as the rounded cross-section (a rectangle with semicircular ends), so the volume the
 * printer deposited per millimetre is the rounded cross-section at w. That is k times the
 * cross-section the coupon commanded at the nominal width, and a slicer must command 1 / k as
 * much to deposit the intended bead. The ratio applies to every bead the slicer emits, so it
 * does not depend on the line width or layer height of the part being sliced.
 */
export function measuredFlowRatio(nominalWidthMm: number, layerHeightMm: number, wMm: number): number {
  return beadCrossSectionMm2(nominalWidthMm, layerHeightMm) / roundedBeadCrossSectionMm2(wMm, layerHeightMm)
}

/**
 * The relative standard error of the flow ratio, by first-order error propagation from the
 * measured bead width's standard error. The ratio varies as 1 / A(w), whose logarithmic
 * sensitivity to w is w * h / A(w) for the rounded cross-section A, so the width's relative
 * standard error is scaled by that factor.
 */
export function flowRatioRelativeSe(wMm: number, seMm: number, layerHeightMm: number): number {
  const sensitivity = (wMm * layerHeightMm) / roundedBeadCrossSectionMm2(wMm, layerHeightMm)
  return (seMm / wMm) * sensitivity
}

/**
 * The measured flow ratio (see measuredFlowRatio) is the single source of both outputs. A bead
 * printed wider than nominal means too much flow, so the ratio falls below 1, and vice versa.
 *
 * The coupon always prints at flow 1.0, so the ratio is already the absolute slicer flow to set:
 * the entered current flow never enters that value.
 *
 * M221 is different: the firmware multiplies whatever extrusion the slicer commands, so a part
 * sliced at the current flow needs the override ratio / current to print at the ratio. Both
 * percentages are computed from the unrounded ratio and rounded once.
 */
export function emCorrection(
  firmware: Firmware,
  nominalWidthMm: number,
  layerHeightMm: number,
  wMm: number,
  enteredCurrentFlow: number,
): EmCorrection {
  const ratio = measuredFlowRatio(nominalWidthMm, layerHeightMm, wMm)
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
 * only chooses that style; it never changes the number shown. The uncertainty is the flow
 * ratio's relative standard error (see flowRatioRelativeSe) applied to the shown value.
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
