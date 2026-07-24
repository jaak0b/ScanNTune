import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { OrcaPresetKind } from '../engine/pa/slicerImport'
import { orcaPresetKind, orcaPresetName, tryParseOrcaPreset } from '../engine/pa/slicerImport'
import type { OsName } from '../engine/pa/orcaInstallPaths'

export type { OsName }

const STORAGE_KEY = 'scanntune.slicerPresets'

const PRESET_KINDS: readonly OrcaPresetKind[] = ['filament', 'process', 'machine']

export type SlicerName = 'OrcaSlicer' | 'PrusaSlicer'

const SLICER_NAMES: readonly SlicerName[] = ['OrcaSlicer', 'PrusaSlicer']
const OS_NAMES: readonly OsName[] = ['Windows', 'macOS', 'Linux']

/** Default OrcaSlicer install folder per OS, used to seed the (editable) install-path field so
 *  base-preset path hints are absolute out of the box. */
export const ORCA_INSTALL_DEFAULTS: Record<OsName, string> = {
  Windows: 'C:\\Program Files\\OrcaSlicer',
  macOS: '/Applications/OrcaSlicer.app/Contents/Resources',
  Linux: '/usr/share/OrcaSlicer',
}

/** First-run OS guess from the browser platform; the user's persisted choice wins afterwards. */
export function detectOs(): OsName {
  const ua = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`.toLowerCase()
  if (ua.includes('mac')) return 'macOS'
  if (ua.includes('linux') && !ua.includes('android')) return 'Linux'
  return 'Windows'
}

/** One cached base preset: the raw file content plus the metadata shown in the UI. */
export interface StoredSlicerPreset {
  name: string
  kind: OrcaPresetKind
  addedUtc: string
  content: string
}

interface StoredState {
  presets: StoredSlicerPreset[]
  installPath: string | null
  slicer: SlicerName | null
  os: OsName | null
}

function isStoredPreset(value: unknown): value is StoredSlicerPreset {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.name === 'string' &&
    record.name.trim() !== '' &&
    PRESET_KINDS.includes(record.kind as OrcaPresetKind) &&
    typeof record.addedUtc === 'string' &&
    typeof record.content === 'string'
  )
}

function loadFromStorage(): StoredState {
  const empty: StoredState = { presets: [], installPath: null, slicer: null, os: null }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return empty
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      console.warn('Stored slicer presets had an unexpected shape; starting empty.')
      return empty
    }
    const record = parsed as Record<string, unknown>
    const presets = Array.isArray(record.presets) ? record.presets.filter(isStoredPreset) : []
    const installPath =
      typeof record.installPath === 'string' && record.installPath.trim() !== ''
        ? record.installPath
        : null
    const slicer = SLICER_NAMES.includes(record.slicer as SlicerName)
      ? (record.slicer as SlicerName)
      : null
    const os = OS_NAMES.includes(record.os as OsName) ? (record.os as OsName) : null
    return { presets, installPath, slicer, os }
  } catch (e) {
    console.warn('Could not read the stored slicer presets', e)
    return empty
  }
}

/**
 * Cache of OrcaSlicer base presets (raw preset JSON keyed by preset name), so a preset chain a
 * user resolved once keeps resolving on later imports without re-uploading the parent. Also holds
 * the optional OrcaSlicer install path used to build absolute path hints for missing parents.
 */
export const useSlicerPresets = defineStore('slicerPresets', () => {
  const initial = loadFromStorage()
  const presets = ref<StoredSlicerPreset[]>(initial.presets)
  // First run picks sensible defaults: OrcaSlicer, the detected OS, and that OS's default Orca
  // install folder so path hints work immediately. The persisted choices win on later loads.
  const slicer = ref<SlicerName>(initial.slicer ?? 'OrcaSlicer')
  const os = ref<OsName>(initial.os ?? detectOs())
  const installPath = ref<string | null>(initial.installPath ?? ORCA_INSTALL_DEFAULTS[os.value])

  function persist(): void {
    try {
      const state: StoredState = {
        presets: presets.value,
        installPath: installPath.value,
        slicer: slicer.value,
        os: os.value,
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch (e) {
      console.warn('Could not persist the slicer presets', e)
    }
  }

  // Persist the first-run defaults so the seeded install path and help selections survive a reload
  // even if the user never touches them.
  if (initial.slicer === null || initial.os === null || initial.installPath === null) persist()

  /** Validates and caches one preset file's content, keyed (and de-duplicated) by preset name.
   *  Throws a user-worded error when the content is not a usable OrcaSlicer preset. */
  function add(content: string): StoredSlicerPreset {
    const preset = tryParseOrcaPreset(content)
    if (preset === null) {
      throw new Error(
        'This file does not look like an OrcaSlicer preset, so it cannot be saved as a base preset.',
      )
    }
    const name = orcaPresetName(preset)
    if (name === undefined) {
      throw new Error(
        'This OrcaSlicer preset has no "name" value, so it cannot be saved as a base preset.',
      )
    }
    const entry: StoredSlicerPreset = {
      name,
      kind: orcaPresetKind(preset),
      addedUtc: new Date().toISOString(),
      content,
    }
    presets.value = [...presets.value.filter((p) => p.name !== name), entry]
    persist()
    return entry
  }

  function remove(name: string): void {
    presets.value = presets.value.filter((p) => p.name !== name)
    persist()
  }

  function clear(): void {
    presets.value = []
    persist()
  }

  /** Sets the OrcaSlicer install path used for absolute parent-path hints; blank clears it. */
  function setInstallPath(path: string | null): void {
    const trimmed = path?.trim() ?? ''
    installPath.value = trimmed === '' ? null : trimmed
    persist()
  }

  function setSlicer(value: SlicerName): void {
    slicer.value = value
    persist()
  }

  function setOs(value: OsName): void {
    os.value = value
    persist()
  }

  return { presets, installPath, slicer, os, add, remove, clear, setInstallPath, setSlicer, setOs }
})
