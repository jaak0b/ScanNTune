import { createFlowSettingsStore, type FieldKinds } from './createFlowSettingsStore'

/**
 * The smooth time step of the pressure advance flow: the smooth time sweep and the fixed
 * pressure advance its coupon is printed with. They are the values that coupon is generated
 * with, so they persist: an already printed smooth time coupon is analyzed against them after a
 * reload. They are stored apart from the test range (`usePaSettings`), so resetting the test
 * range never touches them.
 */
export type PaSmoothTimeSettings = {
  smoothTimeStart: number | null
  smoothTimeEnd: number | null
  pressureAdvance: number | null
}

const FIELDS: FieldKinds<PaSmoothTimeSettings> = {
  smoothTimeStart: { kind: 'nullableNumber' },
  smoothTimeEnd: { kind: 'nullableNumber' },
  pressureAdvance: { kind: 'nullableNumber' },
}

export const usePaSmoothTimeSettings = createFlowSettingsStore<PaSmoothTimeSettings>({
  storeId: 'paSmoothTimeSettings',
  storageKey: 'scanntune.settings.paSmoothTime',
  shape: 'perProfile',
  fields: FIELDS,
})
