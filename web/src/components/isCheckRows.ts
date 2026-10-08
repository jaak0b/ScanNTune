import type { CheckState, IsAxisResult, SpeedCheckState } from '../engine/is/resultTypes'

// The input shaper axis checks as raw diagnostic rows: one fact per labeled row, booleans as
// yes/no, states by their own name, numbers with their unit.

const SPEED_CHECK_TEXT: Record<SpeedCheckState, string> = {
  confirmed: 'confirmed',
  changed: 'changed with speed',
  'not-confirmed': 'not confirmed',
  'not-assessed': 'not assessed',
}

const CHECK_TEXT: Record<CheckState, string> = {
  passed: 'passed',
  failed: 'failed',
  'not-assessed': 'not assessed',
}

function yesNo(value: boolean | null): string {
  return value === null ? 'not assessed' : value ? 'yes' : 'no'
}

function stateYesNo(state: CheckState): string {
  return state === 'not-assessed' ? 'not assessed' : state === 'passed' ? 'yes' : 'no'
}

/** A probability bound with two significant digits, in exponent form below 0.001. */
function pBoundText(p: number | null): string {
  if (p === null) return 'not assessed'
  return p >= 0.001 ? p.toPrecision(2) : p.toExponential(1)
}

export interface CheckRow {
  label: string
  value: string
}

export function isCheckRows(a: IsAxisResult): CheckRow[] {
  const rows: CheckRow[] = [
    { label: 'Lines with ringing detected', value: `${a.linesDetected} of ${a.linesTraced}` },
    { label: 'Detection p-value bound', value: pBoundText(a.detectionPBound) },
    { label: 'Decay demonstrated', value: yesNo(a.decayDemonstrated) },
    { label: 'Grows with corner speed', value: stateYesNo(a.proportionality) },
    { label: 'Speed independence', value: SPEED_CHECK_TEXT[a.speedCheck.state] },
    ...a.speedCheck.tiers.map((t) => ({
      label: `Frequency at ${t.speedMmS} mm/s`,
      value: t.frequencyHz !== null ? `${t.frequencyHz.toFixed(1)} Hz` : 'no ringing detected',
    })),
    { label: 'Replicate check', value: CHECK_TEXT[a.replicateCheck] },
  ]
  // Only a one-tier coupon assesses the leave-one-line-out check.
  if (a.influenceCheck !== 'not-assessed') {
    rows.push({ label: 'Detection without any single line', value: stateYesNo(a.influenceCheck) })
  }
  rows.push({ label: 'Layer shift detected', value: yesNo(a.layerShiftDetected) })
  return rows
}
