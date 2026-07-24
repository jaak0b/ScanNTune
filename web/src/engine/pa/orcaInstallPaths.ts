/** Orca install layout facts that vary by OS: the path separator to render in a hint, and the
 *  profiles subpath relative to the install base. macOS ships the app bundle's
 *  "Contents/Resources" folder as Orca's resources directory already, so its profiles live
 *  directly under "profiles"; Windows and Linux installs keep an extra "resources" folder under
 *  the install root. */
export type OsName = 'Windows' | 'macOS' | 'Linux'

export interface OrcaProfilesLocation {
  separator: string
  subpath: string
}

export const ORCA_PROFILES_LOCATION: Record<OsName, OrcaProfilesLocation> = {
  Windows: { separator: '\\', subpath: 'resources\\profiles' },
  macOS: { separator: '/', subpath: 'profiles' },
  Linux: { separator: '/', subpath: 'resources/profiles' },
}
