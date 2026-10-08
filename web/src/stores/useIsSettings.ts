import { createFlowSettingsStore, SCAN_PLAN_FIELDS, type FieldKinds, type ScanPlanSettings } from './createFlowSettingsStore'

/** User-adjustable settings of the input shaper flow; defaults come from `defaultIsTestRequest`. */
export type IsSettings = ScanPlanSettings & {
  lineSpeedMmS: number | null
  cornerSpeedMmS: number | null
  /** Speed tiers: 1 or 2; null means the default, two tiers. */
  speedTiers: number | null
  /** An explicit lines per speed; null means the derived count. */
  linesPerSpeedOverride: number | null
  measuredLineMm: number | null
  linePitchMm: number | null
}

const FIELDS: FieldKinds<IsSettings> = {
  lineSpeedMmS: { kind: 'nullableNumber' },
  cornerSpeedMmS: { kind: 'nullableNumber' },
  // Both added after entries were stored. An older entry's lines per speed was chosen for a
  // one-tier coupon, so it is not carried over: the stored key is no longer declared and
  // drops, and the override starts empty (the derived count).
  speedTiers: { kind: 'nullableNumber', backfill: null },
  linesPerSpeedOverride: { kind: 'nullableNumber', backfill: null },
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
