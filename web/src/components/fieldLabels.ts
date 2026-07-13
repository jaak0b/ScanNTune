import type { FIELD_KINDS } from '../engine/pa/slicerImport'

/** Short, human-readable label for each importable field, keyed by its raw camelCase name.
 *  UI-side only: the engine stays presentation-free (see FIELD_KINDS). */
export const FIELD_LABELS: Record<keyof typeof FIELD_KINDS, string> = {
  firmware: 'Firmware',
  bedWidthMm: 'Bed width',
  bedDepthMm: 'Bed depth',
  nozzleDiameterMm: 'Nozzle diameter',
  retractMm: 'Retraction',
  retractSpeedMmS: 'Retract speed',
  printAccelMmS2: 'Acceleration',
  squareCornerVelocityMmS: 'Corner velocity',
  startGcode: 'Start G-code',
  pauseGcode: 'Pause G-code',
  endGcode: 'End G-code',
  filamentType: 'Filament type',
  filamentDiameterMm: 'Filament diameter',
  nozzleTempC: 'Nozzle temp',
  bedTempC: 'Bed temp',
  chamberTempC: 'Chamber temp',
  extrusionMultiplier: 'Extrusion multiplier',
  maxVolumetricFlowMm3S: 'Max volumetric flow',
}

/** Falls back to the raw field name if it is somehow not in FIELD_LABELS (should not happen for
 *  any field the engine reports, but keeps the UI from throwing on an unrecognized key). */
export function fieldLabel(field: string): string {
  return FIELD_LABELS[field as keyof typeof FIELD_LABELS] ?? field
}
