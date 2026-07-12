import type { Page } from '@playwright/test'

// Mirrors the exact shape `useCalibration.ts` persists (`ScannerCalibration` in
// `web/src/engine/types.ts`) under this storage key.
const STORAGE_KEY = 'scanntune.calibration'

export interface SeedCalibration {
  pxPerMm: number
  dpi: number
  referenceMm: number
  measuredWidthPx: number
  straightnessPx: number
  parallelismDegrees: number
  calibratedUtc: string
  scannerType: string
  measuredAxis: string
}

/**
 * Seed-state carve-out (per the writing-webtests skill): scanner calibration has its own
 * dedicated webtest, `web/e2e/card-calibration/card.spec.ts`, so dependent flows may seed the
 * stored calibration directly into localStorage instead of re-running the card UI in every test
 * that needs it. Writes via `page.addInitScript`, which runs before any page script on
 * navigation, so `useCalibration`'s store-init read from localStorage picks up the seeded value
 * as soon as the app loads. Must be called before `page.goto()`.
 *
 * The seed objects themselves must be copied verbatim from a feature's `golden/PROVENANCE.md`
 * ("Seed calibration" section), never hand-built or recomputed.
 */
export async function seedCalibration(page: Page, calibration: SeedCalibration): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, JSON.stringify(value))
    },
    { key: STORAGE_KEY, value: calibration },
  )
}
