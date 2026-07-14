import { createFlowSettingsStore, SCAN_PLAN_FIELDS, type FieldKinds, type ScanPlanSettings } from './createFlowSettingsStore'

/** User-adjustable settings of the input shaper flow; defaults come from `defaultIsTestSpec`. */
export type IsSettings = ScanPlanSettings & {
  lineSpeedMmS: number | null
  cornerSpeedMmS: number | null
  linesPerSpeed: number | null
  measuredLineMm: number | null
  linePitchMm: number | null
  sweep: boolean
  sweepFromHz: number | null
  sweepToHz: number | null
  sweepCycles: number | null
}

const FIELDS: FieldKinds<IsSettings> = {
  lineSpeedMmS: { kind: 'nullableNumber' },
  cornerSpeedMmS: { kind: 'nullableNumber' },
  linesPerSpeed: { kind: 'nullableNumber' },
  measuredLineMm: { kind: 'nullableNumber' },
  linePitchMm: { kind: 'nullableNumber' },
  sweep: { kind: 'boolean' },
  sweepFromHz: { kind: 'nullableNumber' },
  sweepToHz: { kind: 'nullableNumber' },
  sweepCycles: { kind: 'nullableNumber' },
  ...SCAN_PLAN_FIELDS,
}

export const useIsSettings = createFlowSettingsStore<IsSettings>({
  storeId: 'isSettings',
  storageKey: 'scanntune.settings.is',
  shape: 'perProfile',
  fields: FIELDS,
})
