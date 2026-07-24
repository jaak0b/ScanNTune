import type { OsName, SlicerName } from '../stores/useSlicerPresets'
import type { ImportKind } from '../composables/useProfileForm'
import { ORCA_PROFILES_LOCATION } from '../engine/pa/orcaInstallPaths'

/** Re-exported so existing importers of this module keep working: the per-OS profiles
 *  separator/subpath table is owned by the engine (it feeds the framework-agnostic base-preset
 *  path hint too), this module just presents it alongside the other slicer path data. */
export { ORCA_PROFILES_LOCATION }

/** Preset-folder paths to copy for a given slicer + OS, per import kind. Data-driven so the
 *  ImportView stays a thin presenter over the selected slicer/OS. */
const ORCA_PATHS: Record<ImportKind, Record<OsName, string>> = {
  printer: {
    Windows: '%APPDATA%\\OrcaSlicer\\user\\default\\machine\\',
    macOS: '~/Library/Application Support/OrcaSlicer/user/default/machine/',
    Linux: '~/.config/OrcaSlicer/user/default/machine/',
  },
  filament: {
    Windows: '%APPDATA%\\OrcaSlicer\\user\\default\\filament\\',
    macOS: '~/Library/Application Support/OrcaSlicer/user/default/filament/',
    Linux: '~/.config/OrcaSlicer/user/default/filament/',
  },
}

const PRUSA_PATHS: Record<ImportKind, Record<OsName, string>> = {
  printer: {
    Windows: '%APPDATA%\\PrusaSlicer\\printer\\',
    macOS: '~/Library/Application Support/PrusaSlicer/printer/',
    Linux: '~/.config/PrusaSlicer/printer/',
  },
  filament: {
    Windows: '%APPDATA%\\PrusaSlicer\\filament\\',
    macOS: '~/Library/Application Support/PrusaSlicer/filament/',
    Linux: '~/.config/PrusaSlicer/filament/',
  },
}

export interface ConfigPathHint {
  /** Copyable preset-folder path. */
  path: string
  /** Optional line shown above the path (e.g. the PrusaSlicer Export Config route). */
  note: string | null
}

export function configPathHint(slicer: SlicerName, os: OsName, kind: ImportKind): ConfigPathHint {
  if (slicer === 'PrusaSlicer') {
    return { path: PRUSA_PATHS[kind][os], note: 'File, Export, Export Config, or:' }
  }
  return { path: ORCA_PATHS[kind][os], note: null }
}
