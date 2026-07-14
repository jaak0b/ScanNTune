import { defineStore } from 'pinia'
import { computed, shallowRef } from 'vue'
import { usePrinterProfiles } from './usePrinterProfiles'
import { PART_COLORS, SCAN_PLACES, type PartColors, type ScanPlace } from '../model/scanPlan'

/**
 * The scan-place / part-colors fields shared by every flow that scans a printed coupon off the
 * glass. Pressure advance legitimately lacks these: its coupon is scanned photo-side up on a
 * contrasting base with no scan-place or part-color choice, so `usePaSettings` does not spread
 * this fragment.
 */
export type ScanPlanSettings = {
  scanPlace: ScanPlace
  partColors: PartColors
}

export const SCAN_PLAN_FIELDS: FieldKinds<ScanPlanSettings> = {
  scanPlace: { kind: 'enum', values: SCAN_PLACES },
  partColors: { kind: 'enum', values: PART_COLORS },
}

/** How a stored settings field is validated when it is loaded back from localStorage. */
export type FieldKind =
  | { kind: 'nullableNumber' }
  | { kind: 'boolean' }
  | { kind: 'enum'; values: readonly string[] }

export type FieldKinds<S> = { readonly [K in keyof S & string]: FieldKind }

/** Storage shape of a flow's settings: one flat entry, or one entry per printer profile. */
export type FlowSettingsShape = 'flat' | 'perProfile'

export interface FlowSettingsConfig<S extends Record<string, unknown>> {
  /** Pinia store id, unique per flow. */
  storeId: string
  /** localStorage key, unique per flow. */
  storageKey: string
  shape: FlowSettingsShape
  fields: FieldKinds<S>
}

/** The internal entry key used when the flow's settings are a single flat object. */
const FLAT_KEY = 'flat'

function isValidFieldValue(value: unknown, kind: FieldKind): boolean {
  if (kind.kind === 'nullableNumber') {
    return value === null || (typeof value === 'number' && Number.isFinite(value))
  }
  if (kind.kind === 'boolean') return typeof value === 'boolean'
  return typeof value === 'string' && kind.values.includes(value)
}

/**
 * Rebuilds an entry from its declared fields, dropping anything undeclared. Returns null when
 * any declared field is missing or invalid, so a corrupt entry is never partially applied.
 */
function sanitizeEntry<S extends Record<string, unknown>>(
  value: unknown,
  fields: FieldKinds<S>,
): S | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const entry: Record<string, unknown> = {}
  for (const key of Object.keys(fields)) {
    if (!isValidFieldValue(record[key], fields[key as keyof S & string])) return null
    entry[key] = record[key]
  }
  return entry as S
}

function loadEntries<S extends Record<string, unknown>>(
  config: FlowSettingsConfig<S>,
  validProfileIds: ReadonlySet<string>,
): Record<string, S> {
  const { storageKey, shape, fields } = config
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (shape === 'flat') {
      const entry = sanitizeEntry(parsed, fields)
      if (entry === null) {
        console.warn(`Dropping invalid stored settings under ${storageKey}`, parsed)
        return {}
      }
      return { [FLAT_KEY]: entry }
    }
    if (typeof parsed !== 'object' || parsed === null) {
      console.warn(`Dropping invalid stored settings under ${storageKey}`, parsed)
      return {}
    }
    const entries: Record<string, S> = {}
    for (const [profileId, value] of Object.entries(parsed)) {
      // An entry for a printer profile that no longer exists is stale and dropped.
      if (!validProfileIds.has(profileId)) continue
      const entry = sanitizeEntry(value, fields)
      if (entry === null) {
        console.warn(`Dropping invalid stored settings for profile ${profileId} under ${storageKey}`, value)
        continue
      }
      entries[profileId] = entry
    }
    return entries
  } catch (e) {
    console.warn(`Could not read the stored settings under ${storageKey}`, e)
    return {}
  }
}

/**
 * Builds a Pinia store that persists one flow's user-adjustable test settings in localStorage.
 * The store holds only what the user saved: when no entry exists for the current context
 * (`settings` is null), the page falls back to its computed defaults. For the per-profile
 * shape the current context is the selected printer profile from `usePrinterProfiles`.
 */
export function createFlowSettingsStore<S extends Record<string, unknown>>(
  config: FlowSettingsConfig<S>,
) {
  return defineStore(config.storeId, () => {
    const profiles = config.shape === 'perProfile' ? usePrinterProfiles() : null
    const validIds = new Set(profiles?.profiles.map((p) => p.id) ?? [])
    const entries = shallowRef<Record<string, S>>(loadEntries(config, validIds))

    const currentKey = computed<string | null>(() =>
      config.shape === 'flat' ? FLAT_KEY : (profiles?.selectedId ?? null),
    )
    const settings = computed<S | null>(() =>
      currentKey.value !== null ? (entries.value[currentKey.value] ?? null) : null,
    )
    const hasStored = computed(() => settings.value !== null)

    function persist(): void {
      try {
        if (Object.keys(entries.value).length === 0) {
          localStorage.removeItem(config.storageKey)
          return
        }
        const payload = config.shape === 'flat' ? entries.value[FLAT_KEY] : entries.value
        localStorage.setItem(config.storageKey, JSON.stringify(payload))
      } catch (e) {
        console.warn(`Could not persist the settings under ${config.storageKey}`, e)
      }
    }

    /** Stores the given settings as the entry for the current context and persists them. */
    function save(next: S): void {
      if (currentKey.value === null) return
      entries.value = { ...entries.value, [currentKey.value]: { ...next } }
      persist()
    }

    /** Deletes the stored entry for the current context; the page recomputes its defaults. */
    function reset(): void {
      if (currentKey.value === null || !(currentKey.value in entries.value)) return
      const rest = { ...entries.value }
      delete rest[currentKey.value]
      entries.value = rest
      persist()
    }

    return { settings, hasStored, save, reset }
  })
}
