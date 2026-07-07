import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { FilamentProfile, PrinterProfile } from '../engine/pa/types'

const STORAGE_KEY = 'scanntune.printerProfiles'

const PRINTER_NUMERIC_FIELDS = [
  'bedWidthMm',
  'bedDepthMm',
  'nozzleDiameterMm',
  'travelSpeedMmS',
  'layerHeightMm',
  'retractMm',
  'retractSpeedMmS',
  'printAccelMmS2',
  'squareCornerVelocityMmS',
] as const

const PRINTER_STRING_FIELDS = [
  'id',
  'name',
  'firmware',
  'startGcode',
  'pauseGcode',
  'endGcode',
] as const

const FILAMENT_NUMERIC_FIELDS = [
  'filamentDiameterMm',
  'nozzleTempC',
  'bedTempC',
  'chamberTempC',
] as const

const FILAMENT_STRING_FIELDS = ['id', 'name', 'filamentType'] as const

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isValidFilament(value: unknown): value is FilamentProfile {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    FILAMENT_NUMERIC_FIELDS.every((k) => isFiniteNumber(record[k])) &&
    FILAMENT_STRING_FIELDS.every((k) => typeof record[k] === 'string')
  )
}

function isValidProfile(value: unknown): value is PrinterProfile {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const numbersOk = PRINTER_NUMERIC_FIELDS.every((k) => isFiniteNumber(record[k]))
  const stringsOk = PRINTER_STRING_FIELDS.every((k) => typeof record[k] === 'string')
  const filamentsOk =
    Array.isArray(record.filaments) &&
    record.filaments.length > 0 &&
    record.filaments.every(isValidFilament)
  const selectedOk =
    record.selectedFilamentId === null || typeof record.selectedFilamentId === 'string'
  return numbersOk && stringsOk && filamentsOk && selectedOk
}

/** Points selectedFilamentId at an existing filament, falling back to the first one. */
function withResolvedFilamentSelection(profile: PrinterProfile): PrinterProfile {
  const exists = profile.filaments.some((f) => f.id === profile.selectedFilamentId)
  if (exists) return profile
  return { ...profile, selectedFilamentId: profile.filaments[0].id }
}

interface StoredState {
  profiles: PrinterProfile[]
  selectedId: string | null
}

function loadFromStorage(): StoredState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { profiles: [], selectedId: null }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { profiles: [], selectedId: null }
    const record = parsed as Record<string, unknown>
    const rawProfiles = Array.isArray(record.profiles) ? record.profiles : []
    const profiles = rawProfiles
      .filter((p): p is PrinterProfile => {
        if (isValidProfile(p)) return true
        console.warn('Dropping invalid stored printer profile', p)
        return false
      })
      .map(withResolvedFilamentSelection)
    const selectedId = typeof record.selectedId === 'string' ? record.selectedId : null
    return { profiles, selectedId }
  } catch (e) {
    console.warn('Could not read the stored printer profiles', e)
    return { profiles: [], selectedId: null }
  }
}

export const usePrinterProfiles = defineStore('printerProfiles', () => {
  const initial = loadFromStorage()
  const profiles = ref<PrinterProfile[]>(initial.profiles)
  const selectedId = ref<string | null>(initial.selectedId)

  const selected = computed<PrinterProfile | null>(
    () => profiles.value.find((p) => p.id === selectedId.value) ?? null,
  )

  const selectedFilament = computed<FilamentProfile | null>(() => {
    const p = selected.value
    if (!p) return null
    return p.filaments.find((f) => f.id === p.selectedFilamentId) ?? p.filaments[0] ?? null
  })

  function persist(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ profiles: profiles.value, selectedId: selectedId.value }),
      )
    } catch (e) {
      console.warn('Could not persist the printer profiles', e)
    }
  }

  function upsert(profile: PrinterProfile): string {
    const id = profile.id === '' ? crypto.randomUUID() : profile.id
    const filaments = profile.filaments.map((f) =>
      f.id === '' ? { ...f, id: crypto.randomUUID() } : f,
    )
    const withId = withResolvedFilamentSelection({ ...profile, id, filaments })
    const index = profiles.value.findIndex((p) => p.id === id)
    if (index === -1) {
      profiles.value = [...profiles.value, withId]
    } else {
      profiles.value = profiles.value.map((p, i) => (i === index ? withId : p))
    }
    persist()
    return id
  }

  function remove(id: string): void {
    profiles.value = profiles.value.filter((p) => p.id !== id)
    if (selectedId.value === id) {
      selectedId.value = null
    }
    persist()
  }

  function select(id: string): void {
    selectedId.value = id
    persist()
  }

  function selectFilament(printerId: string, filamentId: string): void {
    profiles.value = profiles.value.map((p) => {
      if (p.id !== printerId) return p
      if (!p.filaments.some((f) => f.id === filamentId)) return p
      return { ...p, selectedFilamentId: filamentId }
    })
    persist()
  }

  return { profiles, selectedId, selected, selectedFilament, upsert, remove, select, selectFilament }
})
