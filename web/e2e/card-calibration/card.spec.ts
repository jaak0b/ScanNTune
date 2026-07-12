import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Literals below are copied verbatim from card.flow.md / golden/PROVENANCE.md. No math, no
// derivation: the test only transcribes and compares.

const here = path.dirname(fileURLToPath(import.meta.url))

const REFERENCE_MM = '85.55'

// Analysis on these fixtures took over two minutes end to end in the golden capture session, so
// the per-test timeout is raised well above Playwright's default and the visibility wait below is
// sized generously to match, per the flow spec's explicit instruction not to shrink either.
const ANALYSIS_TEST_TIMEOUT_MS = 210000
const RESULT_VISIBLE_TIMEOUT_MS = 180000

interface Band {
  value: number
  tolerance: number
}

interface CardCase {
  name: string
  fixture: string
  dpi: number
  pxPerMm: Band
  effectiveDpi: Band
  vsNominal: Band
}

const cases: CardCase[] = [
  {
    name: '300 dpi',
    fixture: 'golden/card_300dpi.png',
    dpi: 300,
    pxPerMm: { value: 11.796, tolerance: 0.02 },
    effectiveDpi: { value: 300, tolerance: 1 },
    vsNominal: { value: -0.131, tolerance: 0.05 },
  },
  {
    name: '600 dpi',
    fixture: 'golden/card_600dpi.png',
    dpi: 600,
    pxPerMm: { value: 23.584, tolerance: 0.02 },
    effectiveDpi: { value: 599, tolerance: 1 },
    vsNominal: { value: -0.161, tolerance: 0.05 },
  },
]

for (const c of cases) {
  test(`card calibration: ${c.name}`, async ({ page }) => {
    test.setTimeout(ANALYSIS_TEST_TIMEOUT_MS)

    await page.goto('/')
    await page.getByRole('button', { name: 'Calibrate scanner' }).click()
    await expect(page.getByRole('heading', { name: 'Scanner calibration' })).toBeVisible()

    await page.getByTestId('sensor-cis').click()

    await page.getByTestId('reference-mm').fill(REFERENCE_MM)
    await page.getByTestId('scan-dpi').fill(String(c.dpi))

    await page.getByTestId('card-input').setInputFiles(path.join(here, c.fixture))

    await expect(page.getByTestId('calibration-result')).toBeVisible({
      timeout: RESULT_VISIBLE_TIMEOUT_MS,
    })
    await expect(page.getByTestId('card-error')).toHaveCount(0)

    const pxPerMm = parseFloat(await page.getByTestId('pxpermm').innerText())
    expect(pxPerMm).toBeGreaterThan(c.pxPerMm.value - c.pxPerMm.tolerance)
    expect(pxPerMm).toBeLessThan(c.pxPerMm.value + c.pxPerMm.tolerance)

    const effectiveDpi = parseFloat(await page.getByTestId('effective-dpi').innerText())
    expect(effectiveDpi).toBeGreaterThan(c.effectiveDpi.value - c.effectiveDpi.tolerance)
    expect(effectiveDpi).toBeLessThan(c.effectiveDpi.value + c.effectiveDpi.tolerance)

    // vs-nominal's text carries a trailing "%" and its sign (e.g. "-0.131 %"); parseFloat reads
    // the leading signed number, and the sign is asserted explicitly per case (both goldens are
    // negative).
    const vsNominal = parseFloat(await page.getByTestId('vs-nominal').innerText())
    expect(vsNominal).toBeLessThan(0)
    expect(vsNominal).toBeGreaterThan(c.vsNominal.value - c.vsNominal.tolerance)
    expect(vsNominal).toBeLessThan(c.vsNominal.value + c.vsNominal.tolerance)

    await expect(page.getByTestId('scale-factor-note')).toHaveCount(0)
    await expect(page.getByTestId('saved')).toBeVisible()
    await expect(page.getByTestId('saved')).toHaveText('Saved, used for every scan')
  })
}

test('card calibration: resolution mismatch is refused', async ({ page }) => {
  test.setTimeout(ANALYSIS_TEST_TIMEOUT_MS)

  await page.goto('/')
  await page.getByRole('button', { name: 'Calibrate scanner' }).click()
  await expect(page.getByRole('heading', { name: 'Scanner calibration' })).toBeVisible()

  await page.getByTestId('sensor-cis').click()

  await page.getByTestId('reference-mm').fill(REFERENCE_MM)
  await page.getByTestId('scan-dpi').fill('150')

  await page.getByTestId('card-input').setInputFiles(path.join(here, 'golden/card_300dpi.png'))

  await expect(page.getByTestId('card-error')).toBeVisible({ timeout: RESULT_VISIBLE_TIMEOUT_MS })
  await expect(page.getByTestId('card-error')).toHaveText(
    'The detected card is about 2.0 times your measured size. The scan resolution likely differs from the 150 dpi you entered.',
  )
  await expect(page.getByTestId('calibration-result')).toHaveCount(0)
})
