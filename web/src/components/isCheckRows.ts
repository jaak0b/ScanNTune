import type { AlongTrackLagState, CheckState, IsAxisResult, SpeedCheckState } from '../engine/is/resultTypes'
import type { DetectedArtifact } from '../engine/is/artifactSearch'
import { GT2_PITCH_MM } from '../engine/is/ringRegressors'

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

/** Where a detected print or scan pattern comes from: its known source, or none. */
function patternSource(artifact: DetectedArtifact): string {
  if (artifact.pixelLockHarmonic !== null) return `pixel locking of the tracer, harmonic ${artifact.pixelLockHarmonic}`
  if (!artifact.known) return 'not a known period'
  if (artifact.periodMm === GT2_PITCH_MM) return 'GT2 belt pitch'
  if (artifact.periodMm === GT2_PITCH_MM / 2) return 'GT2 belt pitch, second harmonic'
  return 'JPEG block of the scan'
}

/** The along-track lag correction's state, naming the other axis where it is the reason. */
function alongTrackLagText(state: AlongTrackLagState, otherAxis: string): string {
  if (state === 'corrected') return 'yes'
  if (state === 'other-axis-not-measured') return `not possible, ${otherAxis} axis ringing not measured`
  return 'not possible, the joint fit of both axes failed'
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
  // The other axis's ring shifts the nozzle along this axis's lines; only a fitted ring has a
  // correction to report.
  if (a.alongTrackLag !== null) {
    const other = a.axis === 'x' ? 'Y' : 'X'
    rows.push({ label: `Corrected for ${other} axis ringing along the lines`, value: alongTrackLagText(a.alongTrackLag, other) })
  }
  rows.push({ label: 'Layer shift detected', value: yesNo(a.layerShiftDetected) })
  if (a.secondModePBound !== null) {
    rows.push({ label: 'Second mode p-value bound', value: pBoundText(a.secondModePBound) })
  }
  if (a.secondMode !== null) {
    rows.push(
      { label: 'Second mode frequency', value: `${a.secondMode.frequencyHz.toFixed(1)} Hz` },
      { label: 'Second mode damping ratio', value: a.secondMode.dampingRatio.toFixed(3) },
      { label: 'Second mode grows with corner speed', value: stateYesNo(a.secondMode.proportionality) },
    )
  }
  if (a.zvSecondModeResidual !== null) {
    rows.push({ label: 'ZV shaper residual vibration at the second mode', value: `${(100 * a.zvSecondModeResidual).toFixed(1)}%` })
  }
  a.artifacts.forEach((artifact, i) => {
    if (artifact.periodMm !== null) {
      rows.push({ label: `Print or scan pattern ${i + 1} period`, value: `${artifact.periodMm.toFixed(2)} mm` })
    }
    rows.push({ label: `Print or scan pattern ${i + 1} source`, value: patternSource(artifact) })
  })
  if (a.cornerModel !== null) {
    const extrusion = a.cornerModel.kind === 'flow-lag'
    rows.push(
      { label: 'Corner model', value: extrusion ? 'extrusion lag' : 'bead drag' },
      extrusion
        ? { label: 'Extrusion lag time constant', value: `${(1000 * a.cornerModel.scale).toFixed(0)} ms` }
        : { label: 'Bead drag length', value: `${a.cornerModel.scale.toFixed(2)} mm` },
    )
  }
  return rows
}
