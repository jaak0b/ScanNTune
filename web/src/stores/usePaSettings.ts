import { createFlowSettingsStore, type FieldKinds } from './createFlowSettingsStore'

/**
 * User-adjustable test settings of the pressure advance flow; defaults come from
 * `defaultPaTestSpec` and, for the Klipper smooth time step, `defaultSmoothTimeTestSpec`. The
 * smooth time sweep range and its fixed pressure advance are the values that coupon is
 * generated with, so they persist like the main range: an already printed smooth time coupon
 * is analyzed against them after a reload.
 */
export type PaSettings = {
  paStart: number | null
  paEnd: number | null
  lineCount: number | null
  slowSpeedMmS: number | null
  fastSpeedMmS: number | null
  smoothTimeStart: number | null
  smoothTimeEnd: number | null
  smoothTimeFixedAdvance: number | null
}

const FIELDS: FieldKinds<PaSettings> = {
  paStart: { kind: 'nullableNumber' },
  paEnd: { kind: 'nullableNumber' },
  lineCount: { kind: 'nullableNumber' },
  slowSpeedMmS: { kind: 'nullableNumber' },
  fastSpeedMmS: { kind: 'nullableNumber' },
  // Added after PA entries were already stored: an older entry loads with these empty, and
  // the page falls back to the smooth time defaults.
  smoothTimeStart: { kind: 'nullableNumber', backfill: null },
  smoothTimeEnd: { kind: 'nullableNumber', backfill: null },
  smoothTimeFixedAdvance: { kind: 'nullableNumber', backfill: null },
}

export const usePaSettings = createFlowSettingsStore<PaSettings>({
  storeId: 'paSettings',
  storageKey: 'scanntune.settings.pa',
  shape: 'perProfile',
  fields: FIELDS,
})
