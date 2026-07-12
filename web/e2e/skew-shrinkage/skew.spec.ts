import { test, expect, type Page, type Locator } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { seedCalibration } from '../helpers/seedCalibration'
import type { SeedCalibration } from '../helpers/seedCalibration'

// Phase 2 (mechanical transcription) of the approval-test model: every literal below is copied
// verbatim from web/e2e/skew-shrinkage/skew.flow.md and its golden/PROVENANCE.md. This file does
// no math, no unit conversion, and no derivation of expected values; it only drives the real UI
// and compares against the transcribed literals.

const here = path.dirname(fileURLToPath(import.meta.url))
function golden(name: string): string {
  return path.join(here, 'golden', name)
}

// Analysis on the 300 dpi fixtures (35 MP-class scans) can take on the order of a minute in the
// Web Worker; timeouts are sized generously per the flow spec's explicit instruction never to
// shrink them for tidiness.
const ANALYSIS_TEST_TIMEOUT_MS = 210000
const RESULT_VISIBLE_TIMEOUT_MS = 120000

// ---- Seed calibration objects (golden/PROVENANCE.md, "Seed calibration") ----
// Seed-state carve-out: scanner calibration has its own dedicated webtest,
// web/e2e/card-calibration/card.spec.ts, so these objects are seeded directly into localStorage
// via the shared seedCalibration helper instead of re-running the card UI here.

const SEED_300DPI: SeedCalibration = {
  pxPerMm: 11.795605844449824,
  dpi: 300,
  referenceMm: 85.55,
  measuredWidthPx: 1009.1140799926824,
  straightnessPx: 0.8872102214925227,
  parallelismDegrees: 0.03666165562292687,
  calibratedUtc: '2026-07-12T15:53:32.665Z',
  scannerType: 'CIS',
  measuredAxis: 'horizontal',
}

const SEED_150DPI: SeedCalibration = {
  pxPerMm: 5.89214823680637,
  dpi: 150,
  referenceMm: 85.55,
  measuredWidthPx: 504.07328165878494,
  straightnessPx: 0.3566679395601973,
  parallelismDegrees: 0.1834685153880538,
  calibratedUtc: '2026-07-12T15:51:51.601Z',
  scannerType: 'CIS',
  measuredAxis: 'horizontal',
}

interface Band {
  value: number
  tolerance: number
}

interface FirmwareCommand {
  reset: string
  skewCode: string
}

const FIRMWARES = ['Klipper', 'Marlin', 'RepRapFirmware'] as const
type Firmware = (typeof FIRMWARES)[number]

// ---- Helpers ----

/** Exact-text comparison via a retrying poll, safe for multi-line strings (Playwright's
 *  toHaveText/toContainText normalize internal whitespace, including newlines, to a single space,
 *  which would corrupt an exact multi-line literal like a Klipper skew-code block). */
async function expectExactText(locator: Locator, expected: string): Promise<void> {
  await expect.poll(() => locator.innerText()).toBe(expected)
}

async function selectFirmware(page: Page, firmware: Firmware): Promise<void> {
  await page.getByTestId('firmware-select').click()
  await page.getByRole('option', { name: firmware, exact: true }).click()
}

/** Reads a `scale-*`/`skew-*` tile's displayed value and checks its explicit sign and band. */
async function assertBand(page: Page, testid: string, band: Band): Promise<void> {
  const text = await page.getByTestId(testid).innerText()
  const value = parseFloat(text)
  // Both golden values in this set are positive (skew.flow.md, "Assertions per case").
  expect(value).toBeGreaterThan(0)
  expect(value).toBeGreaterThan(band.value - band.tolerance)
  expect(value).toBeLessThan(band.value + band.tolerance)
}

/**
 * Drives the shared journey (skew.flow.md "User journey", steps 1-10): seed the calibration,
 * open the app, upload the fixtures, wait for every scan to measure and the plane to be ready,
 * then click Analyze and wait for the results panel. Returns after step 10 (`scale-X` visible);
 * callers read the rest of the results panel themselves (step 11 onward), since each case's
 * assertions differ.
 */
async function uploadAndReachResults(
  page: Page,
  seed: SeedCalibration,
  dpi: number,
  fixtures: string[],
  expectedAnalyzeLabel?: string,
): Promise<void> {
  // Step 1: seed the calibration before navigation.
  await seedCalibration(page, seed)
  // Step 2: open the app (default screen is already the skew/shrinkage page).
  await page.goto('/')

  // Step 3: the seeded calibration took effect.
  await expect(page.getByTestId('calibration-status-line')).toHaveText(`${dpi} dpi`)
  // Step 4: the scan-DPI hint tracks the seeded DPI.
  await expect(page.getByTestId('scan-dpi-hint')).toHaveText(
    `Scan every plate at ${dpi} dpi, the DPI the scanner was calibrated at.`,
  )

  // Step 5: upload every fixture at once through the real file input.
  await page.getByTestId('scans-input').setInputFiles(fixtures)

  // Step 6: every scan's ring-count becomes visible and reads 23 of 23.
  const ringCounts = page.getByTestId('ring-count')
  await expect(ringCounts).toHaveCount(fixtures.length, { timeout: RESULT_VISIBLE_TIMEOUT_MS })
  for (let i = 0; i < fixtures.length; i++) {
    await expect(ringCounts.nth(i)).toHaveText('23 of 23', { timeout: RESULT_VISIBLE_TIMEOUT_MS })
  }

  // Step 7: every scan reads no flip.
  const flips = page.getByTestId('scan-flip')
  for (let i = 0; i < fixtures.length; i++) {
    await expect(flips.nth(i)).toHaveText('None')
  }

  // Step 8: the plane is ready to analyze.
  await expect(page.getByTestId('plane-status-XY')).toHaveText('Ready to analyze.')

  // Step 9: analyze-btn is enabled; click it.
  const analyzeBtn = page.getByTestId('analyze-btn')
  await expect(analyzeBtn).toBeEnabled()
  if (expectedAnalyzeLabel) await expect(analyzeBtn).toHaveText(expectedAnalyzeLabel)
  await analyzeBtn.click()

  // Step 10: the results section appears.
  await expect(page.getByTestId('scale-X')).toBeVisible({ timeout: RESULT_VISIBLE_TIMEOUT_MS })
}

// ==========================================================================
// Case 1: step-3 plate picker and download note (skew.flow.md "Case 1")
// Owner-confirmed from screenshots: the brim note is absent for the flat XY plate and present once
// a standing plate (XZ/YZ) is selected. No scan, seed, or analysis needed.
// ==========================================================================

test('case 1: step-3 plate picker shows the brim note only for a standing plate', async ({
  page,
}) => {
  await page.goto('/')

  // Default state: only the XY plate selected.
  await expect(page.getByTestId('plate-brim-tip')).toHaveCount(0)
  await expect(page.getByTestId('plate-download-button')).toHaveText('Download XY plate')
  // The always-present base note shows regardless of selection.
  await expect(page.getByText('Print it exactly as downloaded.', { exact: false })).toHaveCount(1)
  await expect(page.getByText('Let the bed cool before removing the plate.')).toHaveCount(1)

  // Select the XZ (standing) plate card, so XY + XZ are selected.
  await page.getByTestId('plate-select-xz').click()

  await expect(page.getByTestId('plate-brim-tip')).toHaveText(
    'Add an 8 mm brim to the outer side; peel it off and file the edge smooth before scanning. Thin-edge plates lift at the corners without one.',
  )
  await expect(page.getByTestId('plate-download-button')).toHaveText('Download XY + XZ plates')
})

// ==========================================================================
// Mandatory case table: 2-scan boundary-value pair (skew.flow.md "Case table")
// ==========================================================================

interface TwoScanCase {
  name: string
  dpi: number
  seed: SeedCalibration
  fixtures: [string, string]
  scaleX: Band
  scaleY: Band
  skewXY: Band
  moreScans: string
  sizeCode: string
  firmware: Record<Firmware, FirmwareCommand>
}

const twoScanCases: TwoScanCase[] = [
  {
    name: '300 dpi',
    dpi: 300,
    seed: SEED_300DPI,
    fixtures: [golden('xy_0d_300dpi.png'), golden('xy_90d_300dpi.png')],
    scaleX: { value: 0.146, tolerance: 0.05 },
    scaleY: { value: 0.183, tolerance: 0.05 },
    skewXY: { value: 0.498, tolerance: 0.02 },
    moreScans:
      'XY plate: Scan this plate 2 more times to get a confidence range, which shows how tightly the value is pinned down.',
    sizeCode: 'XY shrinkage: 100.16 %',
    firmware: {
      Klipper: {
        reset: 'SET_SKEW CLEAR=1',
        skewCode:
          'Paste into the Klipper console:\nSET_SKEW XY=99.566,100.436,70.713\nSKEW_PROFILE SAVE=ScanNTune\nSAVE_CONFIG',
      },
      Marlin: {
        reset: 'M852 I0 J0 K0\nM500',
        skewCode: 'M852 I-0.008697\nM500',
      },
      RepRapFirmware: {
        reset: 'M556 S100 X0 Y0 Z0',
        skewCode: 'M556 S100 X0.870',
      },
    },
  },
  {
    name: '150 dpi',
    dpi: 150,
    seed: SEED_150DPI,
    fixtures: [golden('xy_0d_150dpi.png'), golden('xy_90d_150dpi.png')],
    scaleX: { value: 0.242, tolerance: 0.05 },
    scaleY: { value: 0.276, tolerance: 0.05 },
    skewXY: { value: 0.492, tolerance: 0.02 },
    moreScans:
      'XY plate: Scan this plate 2 more times to get a confidence range, which shows how tightly the value is pinned down.',
    sizeCode: 'XY shrinkage: 100.26 %',
    firmware: {
      Klipper: {
        reset: 'SET_SKEW CLEAR=1',
        skewCode:
          'Paste into the Klipper console:\nSET_SKEW XY=99.572,100.43,70.713\nSKEW_PROFILE SAVE=ScanNTune\nSAVE_CONFIG',
      },
      Marlin: {
        reset: 'M852 I0 J0 K0\nM500',
        skewCode: 'M852 I-0.008580\nM500',
      },
      RepRapFirmware: {
        reset: 'M556 S100 X0 Y0 Z0',
        skewCode: 'M556 S100 X0.858',
      },
    },
  },
]

for (const c of twoScanCases) {
  test(`valid measurement (2 scans): ${c.name}`, async ({ page }) => {
    test.setTimeout(ANALYSIS_TEST_TIMEOUT_MS)

    await uploadAndReachResults(page, c.seed, c.dpi, c.fixtures)

    // Step 11: read every field in "Assertions per case".
    await assertBand(page, 'scale-X', c.scaleX)
    await assertBand(page, 'scale-Y', c.scaleY)
    await assertBand(page, 'skew-XY', c.skewXY)
    await expect(page.getByTestId('more-scans-XY')).toHaveText(c.moreScans)
    await expect(page.locator('[data-testid^="zero-note"]')).toHaveCount(0)

    // Step 12: every firmware's reset command and skew-code.
    for (const fw of FIRMWARES) {
      await selectFirmware(page, fw)
      await expectExactText(page.getByTestId('reset-skew-code'), c.firmware[fw].reset)
      await expectExactText(page.getByTestId('skew-code'), c.firmware[fw].skewCode)
    }

    // Step 13: Fix size tab, Format left at default (Shrinkage %), asserted once.
    await page.getByTestId('fix-tab-size').click()
    await expect(page.getByTestId('size-code')).toHaveText(c.sizeCode)
  })
}

// ==========================================================================
// Optional case: 4 scans, one plate, confidence range (skew.flow.md "Optional case")
// This is also the flow's rotation-robustness coverage: PROVENANCE.md's "Rotation-robustness
// finding" documents that the 0/90, 180/270, and all-4 pairings agree closely, but explicitly
// states there is one shared golden value set per DPI, not a separate golden per pairing, so no
// standalone 180/270-only test is written here; the 4-scan case is the one named case the spec
// asks for beyond the mandatory 0/90 pair.
// ==========================================================================

interface FourScanCase {
  name: string
  dpi: number
  seed: SeedCalibration
  fixtures: [string, string, string, string]
  scaleX: Band
  scaleY: Band
  skewXY: Band
  rangeScaleX: string
  rangeScaleY: string
  rangeSkew: string
  /** null where skew.flow.md's table for this case has no size-code row (150 dpi, 4 scans). */
  sizeCode: string | null
}

const fourScanCases: FourScanCase[] = [
  {
    name: '300 dpi, 4 scans',
    dpi: 300,
    seed: SEED_300DPI,
    fixtures: [
      golden('xy_0d_300dpi.png'),
      golden('xy_90d_300dpi.png'),
      golden('xy_180d_300dpi.png'),
      golden('xy_270d_300dpi.png'),
    ],
    scaleX: { value: 0.144, tolerance: 0.05 },
    scaleY: { value: 0.173, tolerance: 0.05 },
    skewXY: { value: 0.5, tolerance: 0.02 },
    rangeScaleX: 'Likely between +0.128 % and +0.160 % (95% from 4 scans).',
    rangeScaleY: 'Likely between +0.157 % and +0.189 % (95% from 4 scans).',
    rangeSkew: 'Likely between +0.483° and +0.517° (95% from 4 scans).',
    sizeCode: 'XY shrinkage: 100.16 %',
  },
  {
    name: '150 dpi, 4 scans',
    dpi: 150,
    seed: SEED_150DPI,
    fixtures: [
      golden('xy_0d_150dpi.png'),
      golden('xy_90d_150dpi.png'),
      golden('xy_180d_150dpi.png'),
      golden('xy_270d_150dpi.png'),
    ],
    scaleX: { value: 0.239, tolerance: 0.05 },
    scaleY: { value: 0.267, tolerance: 0.05 },
    skewXY: { value: 0.497, tolerance: 0.02 },
    rangeScaleX: 'Likely between +0.218 % and +0.259 % (95% from 4 scans).',
    rangeScaleY: 'Likely between +0.246 % and +0.287 % (95% from 4 scans).',
    rangeSkew: 'Likely between +0.479° and +0.515° (95% from 4 scans).',
    sizeCode: null,
  },
]

for (const c of fourScanCases) {
  test(`valid measurement (4 scans, confidence range): ${c.name}`, async ({ page }) => {
    test.setTimeout(ANALYSIS_TEST_TIMEOUT_MS)

    await uploadAndReachResults(page, c.seed, c.dpi, c.fixtures, 'Analyze 4 scans')

    await assertBand(page, 'scale-X', c.scaleX)
    await assertBand(page, 'scale-Y', c.scaleY)
    await assertBand(page, 'skew-XY', c.skewXY)
    await expect(page.getByTestId('range-scaleX-XY')).toHaveText(c.rangeScaleX)
    await expect(page.getByTestId('range-scaleY-XY')).toHaveText(c.rangeScaleY)
    await expect(page.getByTestId('range-skew-XY')).toHaveText(c.rangeSkew)

    if (c.sizeCode) {
      await page.getByTestId('fix-tab-size').click()
      await expect(page.getByTestId('size-code')).toHaveText(c.sizeCode)
    }
  })
}

// ==========================================================================
// Rejection paths (mandatory), skew.flow.md "Rejection paths"
// ==========================================================================

test('rejection 3.1: two scans at nearly the same angle are blocked before Analyze', async ({
  page,
}) => {
  test.setTimeout(ANALYSIS_TEST_TIMEOUT_MS)

  await seedCalibration(page, SEED_300DPI)
  await page.goto('/')

  // The same file uploaded twice, given distinct names so the app's upload-identity keying treats
  // them as two scans (per skew.flow.md 3.1).
  const bytes = fs.readFileSync(golden('xy_0d_300dpi.png'))
  await page.getByTestId('scans-input').setInputFiles([
    { name: 'xy_0d_300dpi_a.png', mimeType: 'image/png', buffer: bytes },
    { name: 'xy_0d_300dpi_b.png', mimeType: 'image/png', buffer: bytes },
  ])

  const ringCounts = page.getByTestId('ring-count')
  await expect(ringCounts).toHaveCount(2, { timeout: RESULT_VISIBLE_TIMEOUT_MS })
  await expect(ringCounts.nth(0)).toHaveText('23 of 23', { timeout: RESULT_VISIBLE_TIMEOUT_MS })
  await expect(ringCounts.nth(1)).toHaveText('23 of 23', { timeout: RESULT_VISIBLE_TIMEOUT_MS })

  const EXPECTED_STATUS =
    'These two scans are only 0 degrees apart. Turn the plate further, about a quarter turn, and scan it again so the app can separate scale from skew.'

  await expect(page.getByTestId('plane-status-XY')).toBeVisible()
  await expect(page.getByTestId('plane-status-XY')).toHaveText(EXPECTED_STATUS)
  await expect(page.getByTestId('analyze-reason')).toHaveText(`XY plate: ${EXPECTED_STATUS}`)
  await expect(page.getByTestId('analyze-btn')).toBeDisabled()

  // Whichever of the two identical uploads is marked "seen second" gets the duplicate warning; the
  // circular-angle sort used to order the islands does not preserve upload order for a near-exact
  // tie, so the assertion is index-independent: exactly one island shows the warning pill, the
  // other its normal "ok" plane pill.
  await expect(page.locator('.pill.warn', { hasText: 'Nearly same angle' })).toHaveCount(1)
  await expect(page.locator('.pill.ok', { hasText: 'XY plane' })).toHaveCount(1)
})

test('rejection 3.4: a mixed-resolution pair flags only the wrong scan and blocks Analyze', async ({
  page,
}) => {
  test.setTimeout(ANALYSIS_TEST_TIMEOUT_MS)

  await seedCalibration(page, SEED_300DPI)
  await page.goto('/')

  await page
    .getByTestId('scans-input')
    .setInputFiles([golden('xy_0d_300dpi.png'), golden('xy_90d_150dpi.png')])

  const ringCounts = page.getByTestId('ring-count')
  await expect(ringCounts).toHaveCount(2, { timeout: RESULT_VISIBLE_TIMEOUT_MS })
  await expect(ringCounts.nth(0)).toHaveText('23 of 23', { timeout: RESULT_VISIBLE_TIMEOUT_MS })
  await expect(ringCounts.nth(1)).toHaveText('23 of 23', { timeout: RESULT_VISIBLE_TIMEOUT_MS })

  const islands = page.getByTestId('scan-island')
  await expect(islands.nth(0).getByTestId('scan-resolution')).toHaveText('about 300 dpi')
  await expect(islands.nth(1).getByTestId('scan-resolution')).toHaveText('about 150 dpi')

  await expect(islands.nth(0).getByTestId('scan-resolution-badge')).toHaveCount(0)
  await expect(islands.nth(1).getByTestId('scan-resolution-badge')).toHaveText('Wrong resolution')
  await expect(islands.nth(1).getByTestId('failure-reason')).toHaveText(
    'This scan measures about 150 dpi, but the expected resolution is 300 dpi. Rescan at the expected resolution, or recalibrate the scanner at this one.',
  )

  await expect(page.getByTestId('analyze-btn')).toBeDisabled()
  await expect(page.getByTestId('analyze-reason')).toHaveText(
    'One scan measures a wrong resolution; replace it to analyze.',
  )
  await expect(page.getByTestId('scale-X')).toHaveCount(0)
})

test('rejection 3.5: a uniform resolution mismatch flags both scans and blocks Analyze', async ({
  page,
}) => {
  test.setTimeout(ANALYSIS_TEST_TIMEOUT_MS)

  await seedCalibration(page, SEED_300DPI)
  await page.goto('/')

  await page
    .getByTestId('scans-input')
    .setInputFiles([golden('xy_0d_150dpi.png'), golden('xy_90d_150dpi.png')])

  const ringCounts = page.getByTestId('ring-count')
  await expect(ringCounts).toHaveCount(2, { timeout: RESULT_VISIBLE_TIMEOUT_MS })
  await expect(ringCounts.nth(0)).toHaveText('23 of 23', { timeout: RESULT_VISIBLE_TIMEOUT_MS })
  await expect(ringCounts.nth(1)).toHaveText('23 of 23', { timeout: RESULT_VISIBLE_TIMEOUT_MS })

  const EXPECTED_EXPLANATION =
    'This scan measures about 150 dpi, but the expected resolution is 300 dpi. Rescan at the expected resolution, or recalibrate the scanner at this one.'

  const islands = page.getByTestId('scan-island')
  await expect(islands.nth(0).getByTestId('scan-resolution')).toHaveText('about 150 dpi')
  await expect(islands.nth(1).getByTestId('scan-resolution')).toHaveText('about 150 dpi')
  await expect(islands.nth(0).getByTestId('scan-resolution-badge')).toHaveText('Wrong resolution')
  await expect(islands.nth(1).getByTestId('scan-resolution-badge')).toHaveText('Wrong resolution')
  await expect(islands.nth(0).getByTestId('failure-reason')).toHaveText(EXPECTED_EXPLANATION)
  await expect(islands.nth(1).getByTestId('failure-reason')).toHaveText(EXPECTED_EXPLANATION)

  await expect(page.getByTestId('analyze-btn')).toBeDisabled()
  await expect(page.getByTestId('analyze-reason')).toHaveText(
    '2 scans measure a wrong resolution; replace them to analyze.',
  )
  await expect(page.getByTestId('scale-X')).toHaveCount(0)
})

test('rejection 3.6: wrong declared coupon geometry is a hard refusal before Analyze', async ({
  page,
}) => {
  test.setTimeout(ANALYSIS_TEST_TIMEOUT_MS)

  await seedCalibration(page, SEED_300DPI)
  await page.goto('/')

  // Enter wrong geometry before uploading (the fields lock once any scan is present).
  await page.getByTestId('grid-n-input').fill('6')
  await page.getByTestId('grid-n-input').blur()
  await page.getByTestId('baseline-mm-input').fill('150')
  await page.getByTestId('baseline-mm-input').blur()

  await page
    .getByTestId('scans-input')
    .setInputFiles([golden('xy_0d_300dpi.png'), golden('xy_90d_300dpi.png')])

  const ringCounts = page.getByTestId('ring-count')
  await expect(ringCounts).toHaveCount(2, { timeout: RESULT_VISIBLE_TIMEOUT_MS })
  await expect(ringCounts.nth(0)).toHaveText('23 of 34', { timeout: RESULT_VISIBLE_TIMEOUT_MS })
  await expect(ringCounts.nth(1)).toHaveText('23 of 34', { timeout: RESULT_VISIBLE_TIMEOUT_MS })

  const EXPECTED_FAILURE =
    'The coupon pattern was not found: only 23 of its 34 measurement rings were detected. Make sure the whole coupon lies inside the scan area on a plain, single-colour background, then scan again.'

  const islands = page.getByTestId('scan-island')
  await expect(islands.nth(0).getByTestId('failure-reason')).toHaveText(EXPECTED_FAILURE)
  await expect(islands.nth(1).getByTestId('failure-reason')).toHaveText(EXPECTED_FAILURE)
  await expect(islands.nth(0).locator('.pill')).toHaveText('Not aligned')
  await expect(islands.nth(1).locator('.pill')).toHaveText('Not aligned')

  await expect(page.getByTestId('analyze-btn')).toBeDisabled()
  await expect(page.getByTestId('analyze-reason')).toHaveText('Fix 2 scans to analyze.')
  await expect(page.getByTestId('plane-status-XY')).toHaveCount(0)
})
