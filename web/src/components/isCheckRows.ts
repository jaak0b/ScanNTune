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

/** Where a detected print or scan pattern comes from (its known source, or none), and which
 *  harmonic of that source it is where the source has harmonics. */
function patternSource(artifact: DetectedArtifact): { source: string; harmonic: number | null } {
  if (!artifact.known) return { source: 'not a known period', harmonic: null }
  if (artifact.periodMm === GT2_PITCH_MM) return { source: 'GT2 belt pitch', harmonic: 1 }
  if (artifact.periodMm === GT2_PITCH_MM / 2) return { source: 'GT2 belt pitch', harmonic: 2 }
  return { source: 'JPEG block of the scan', harmonic: null }
}

/** Why the along-track lag correction was not applied, naming the other axis where it is the
 *  reason; null when it was applied. */
function alongTrackLagReason(state: AlongTrackLagState, otherAxis: string): string | null {
  if (state === 'corrected') return null
  if (state === 'other-axis-not-measured') return `${otherAxis} axis ringing not measured`
  return 'joint fit of both axes failed'
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
    { label: 'Locked to the corner', value: yesNo(a.cornerLocked) },
    { label: 'Speed independence', value: SPEED_CHECK_TEXT[a.speedCheck.state] },
    ...a.speedCheck.tiers.map((t) => ({ label: `Frequency at ${t.speedMmS} mm/s`, value: `${t.frequencyHz.toFixed(1)} Hz` })),
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
    const reason = alongTrackLagReason(a.alongTrackLag, other)
    rows.push({ label: `Corrected for ${other} axis ringing along the lines`, value: reason === null ? 'yes' : 'no' })
    if (reason !== null) rows.push({ label: 'Reason not corrected', value: reason })
  }
  rows.push({ label: 'Layer shift detected', value: yesNo(a.layerShiftDetected) })
  if (a.secondModePBound !== null) {
    rows.push({ label: 'Second mode p-value bound', value: pBoundText(a.secondModePBound) })
  }
  if (a.secondMode !== null) {
    rows.push(
      { label: 'Second mode frequency', value: `${a.secondMode.frequencyHz.toFixed(1)} Hz` },
      { label: 'Second mode damping ratio', value: a.secondMode.dampingRatio.toFixed(3) },
      { label: 'Second mode locked to the corner', value: yesNo(a.secondMode.cornerLocked) },
    )
  }
  a.artifacts.forEach((artifact, i) => {
    rows.push({ label: `Print or scan pattern ${i + 1} period`, value: `${artifact.periodMm.toFixed(2)} mm` })
    const { source, harmonic } = patternSource(artifact)
    rows.push({ label: `Print or scan pattern ${i + 1} source`, value: source })
    if (harmonic !== null) rows.push({ label: `Print or scan pattern ${i + 1} harmonic`, value: String(harmonic) })
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
