import { createFlowSettingsStore, SCAN_PLAN_FIELDS, type FieldKinds, type ScanPlanSettings } from './createFlowSettingsStore'

/** User-adjustable settings of the input shaper flow; defaults come from `defaultIsTestRequest`. */
export type IsSettings = ScanPlanSettings & {
  lineSpeedMmS: number | null
  cornerSpeedMmS: number | null
  measuredLineMm: number | null
  linePitchMm: number | null
}

// Retired fields are no longer declared, so their stored keys drop when an older entry loads:
// the speed tier count, the lines per speed override, and the lines per speed of the earlier
// one-tier coupon. The tiers and the line count are always derived now (fitSpecToPrinter).
const FIELDS: FieldKinds<IsSettings> = {
  lineSpeedMmS: { kind: 'nullableNumber' },
  cornerSpeedMmS: { kind: 'nullableNumber' },
  measuredLineMm: { kind: 'nullableNumber' },
  linePitchMm: { kind: 'nullableNumber' },
  ...SCAN_PLAN_FIELDS,
}

export const useIsSettings = createFlowSettingsStore<IsSettings>({
  storeId: 'isSettings',
  storageKey: 'scanntune.settings.is',
  shape: 'perProfile',
  fields: FIELDS,
})
