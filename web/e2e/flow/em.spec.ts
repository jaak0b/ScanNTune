import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { seedCalibration } from '../helpers/seedCalibration'

// Literals below are copied verbatim from em.flow.md / golden/PROVENANCE.md. No math, no
// derivation: the test only transcribes and compares.

const here = path.dirname(fileURLToPath(import.meta.url))

// Analysis on real flatbed scans took well over a minute per case in the golden capture
// session; the per-test timeout and the result-visibility wait are sized generously to match,
// per the flow spec's explicit instruction not to shrink either.
const ANALYSIS_TEST_TIMEOUT_MS = 210000
const RESULT_VISIBLE_TIMEOUT_MS = 180000

interface Band {
  value: number
  tolerance: number
}

interface EmCase {
  name: string
  fixtures: string[]
  dpi: number
  pxPerMm: number
  flow: Band
  width: Band
  blocksText: string
  bias: Band
  pitchScale: Band
}

const cases: EmCase[] = [
  {
    name: '600 dpi pair',
    fixtures: ['golden/em_widegap_0d_600dpi_black_white.jpg', 'golden/em_widegap_180d_600dpi_black_white.jpg'],
    dpi: 600,
    pxPerMm: 23.622,
    flow: { value: 1.0028, tolerance: 0.01 },
    width: { value: 0.4188, tolerance: 0.01 },
    blocksText: '36 of 36',
    bias: { value: 0.0025, tolerance: 0.003 },
    pitchScale: { value: 0.9956, tolerance: 0.003 },
  },
  {
    name: '600 dpi single scan',
    fixtures: ['golden/em_widegap_0d_600dpi_black_white.jpg'],
    dpi: 600,
    pxPerMm: 23.622,
    flow: { value: 1.006, tolerance: 0.015 },
    width: { value: 0.4175, tolerance: 0.01 },
    blocksText: '18 of 18',
    bias: { value: 0.0015, tolerance: 0.003 },
    pitchScale: { value: 0.9957, tolerance: 0.003 },
  },
  {
    name: '300 dpi single scan',
    fixtures: ['golden/em_widegap_0d_300dpi_black_white.jpg'],
    dpi: 300,
    pxPerMm: 11.811,
    flow: { value: 1.006, tolerance: 0.015 },
    width: { value: 0.4175, tolerance: 0.01 },
    blocksText: '18 of 18',
    bias: { value: 0.0001, tolerance: 0.003 },
    pitchScale: { value: 0.9962, tolerance: 0.003 },
  },
]

async function openEmPageWithNewProfile(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByTestId('nav-em').click()
  await expect(page.getByRole('heading', { name: 'Flow calibration' })).toBeVisible()

  await page.getByTestId('profile-new').click()
  await expect(page.getByTestId('profile-page')).toBeVisible()
  await page.getByLabel('Profile name').fill('E2E Printer')
  await page.getByTestId('profile-save').click()
  await expect(page.getByRole('heading', { name: 'Flow calibration' })).toBeVisible()
}

for (const c of cases) {
  test(`flow calibration: ${c.name}`, async ({ page }) => {
    test.setTimeout(ANALYSIS_TEST_TIMEOUT_MS)

    await seedCalibration(page, {
      pxPerMm: c.pxPerMm,
      dpi: c.dpi,
      referenceMm: 85.6,
      measuredWidthPx: c.pxPerMm * 85.6,
      straightnessPx: 0.1,
      parallelismDegrees: 0.02,
      calibratedUtc: '2026-07-01T00:00:00.000Z',
      scannerType: 'CIS',
      measuredAxis: 'horizontal',
    })

    await openEmPageWithNewProfile(page)

    // NumericField forwards its testid onto both the Vuetify wrapper root and the inner
    // <input> (Vue attr fallthrough plus an explicit mount-time setAttribute); target the
    // input directly since only it is fillable.
    await page.getByTestId('em-current-flow').locator('input').fill('1')

    await page.getByTestId('em-scan-input').setInputFiles(c.fixtures.map((f) => path.join(here, f)))

    await page.getByTestId('em-analyze').click()

    await expect(page.getByTestId('em-width')).toBeVisible({ timeout: RESULT_VISIBLE_TIMEOUT_MS })
    await expect(page.getByTestId('em-scan-error')).toHaveCount(0)
    await expect(page.getByTestId('em-failure')).toHaveCount(0)

    const flow = parseFloat(await page.getByTestId('em-flow').innerText())
    expect(flow).toBeGreaterThan(c.flow.value - c.flow.tolerance)
    expect(flow).toBeLessThan(c.flow.value + c.flow.tolerance)

    const width = parseFloat(await page.getByTestId('em-width').innerText())
    expect(width).toBeGreaterThan(c.width.value - c.width.tolerance)
    expect(width).toBeLessThan(c.width.value + c.width.tolerance)

    await expect(page.getByTestId('em-blocks')).toHaveText(c.blocksText)

    const bias = parseFloat(await page.getByTestId('em-bias').innerText().then((t) => t.replace('separator check ', '')))
    expect(bias).toBeGreaterThan(c.bias.value - c.bias.tolerance)
    expect(bias).toBeLessThan(c.bias.value + c.bias.tolerance)

    const pitchScale = parseFloat(
      await page.getByTestId('em-pitch-scale').innerText().then((t) => t.replace('pitch scale ', '')),
    )
    expect(pitchScale).toBeGreaterThan(c.pitchScale.value - c.pitchScale.tolerance)
    expect(pitchScale).toBeLessThan(c.pitchScale.value + c.pitchScale.tolerance)
  })
}
