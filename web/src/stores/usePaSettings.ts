import { createFlowSettingsStore, type FieldKinds } from './createFlowSettingsStore'

/** User-adjustable test range of the pressure advance flow; defaults come from `defaultPaTestSpec`. */
export type PaSettings = {
  paStart: number | null
  paEnd: number | null
  lineCount: number | null
  slowSpeedMmS: number | null
  fastSpeedMmS: number | null
}

const FIELDS: FieldKinds<PaSettings> = {
  paStart: { kind: 'nullableNumber' },
  paEnd: { kind: 'nullableNumber' },
  lineCount: { kind: 'nullableNumber' },
  slowSpeedMmS: { kind: 'nullableNumber' },
  fastSpeedMmS: { kind: 'nullableNumber' },
}

export const usePaSettings = createFlowSettingsStore<PaSettings>({
  storeId: 'paSettings',
  storageKey: 'scanntune.settings.pa',
  shape: 'perProfile',
  fields: FIELDS,
})
