import { createFlowSettingsStore, SCAN_PLAN_FIELDS, type FieldKinds, type ScanPlanSettings } from './createFlowSettingsStore'

/** User-adjustable settings of the flow calibration; defaults come from `defaultEmTestSpec`. */
export type EmSettings = ScanPlanSettings & {
  pitchMinMm: number | null
  pitchMaxMm: number | null
  blockCount: number | null
  linesPerBlock: number | null
  printSpeedMmS: number | null
}

const FIELDS: FieldKinds<EmSettings> = {
  pitchMinMm: { kind: 'nullableNumber' },
  pitchMaxMm: { kind: 'nullableNumber' },
  blockCount: { kind: 'nullableNumber' },
  linesPerBlock: { kind: 'nullableNumber' },
  printSpeedMmS: { kind: 'nullableNumber' },
  ...SCAN_PLAN_FIELDS,
}

export const useEmSettings = createFlowSettingsStore<EmSettings>({
  storeId: 'emSettings',
  storageKey: 'scanntune.settings.em',
  shape: 'perProfile',
  fields: FIELDS,
})
