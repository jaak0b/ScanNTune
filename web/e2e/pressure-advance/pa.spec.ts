import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Literals below are copied verbatim from pa.flow.md / golden/PROVENANCE.md. No math, no
// derivation: the test only transcribes and compares. No scanner calibration is seeded: the PA
// flow prices every distance from the coupon's own fiducial geometry (see pa.flow.md).

const here = path.dirname(fileURLToPath(import.meta.url))

const ANALYSIS_TEST_TIMEOUT_MS = 210000
const RESULT_VISIBLE_TIMEOUT_MS = 180000

test('pressure advance calibration: 600 dpi golden scan', async ({ page }) => {
  test.setTimeout(ANALYSIS_TEST_TIMEOUT_MS)

  await page.goto('/')
  await page.getByTestId('nav-pa').click()
  await expect(page.getByRole('heading', { name: 'Pressure advance calibration' })).toBeVisible()

  await page.getByTestId('profile-new').click()
  await expect(page.getByTestId('profile-page')).toBeVisible()
  await page.getByLabel('Profile name').fill('E2E Printer')
  await page.getByTestId('profile-save').click()
  await expect(page.getByRole('heading', { name: 'Pressure advance calibration' })).toBeVisible()

  await page
    .getByTestId('pa-scan-input')
    .setInputFiles(path.join(here, 'golden/pa_0d_black_white.jpg'))

  await expect(page.getByTestId('pa-best')).toBeVisible({ timeout: RESULT_VISIBLE_TIMEOUT_MS })
  await expect(page.getByTestId('scan-error')).toHaveCount(0)
  await expect(page.getByTestId('pa-failure')).toHaveCount(0)

  const bestText = await page.getByTestId('pa-best').innerText()
  expect(bestText).toContain(' ± ')
  const [valueToken, uncertaintyToken] = bestText.split(' ± ')
  const bestPa = parseFloat(valueToken)
  expect(bestPa).toBeGreaterThan(0)
  expect(bestPa).toBeGreaterThan(0.0309 - 0.004)
  expect(bestPa).toBeLessThan(0.0309 + 0.004)
  const sePa = parseFloat(uncertaintyToken)
  expect(sePa).toBeGreaterThan(0)

  await expect(page.getByTestId('pa-best-line')).toHaveText('9 of 16')
  await expect(page.getByTestId('pa-lines-readable')).toHaveText('16 / 16')

  expect((await page.getByTestId('pa-bracket').innerText()).trim()).toBe(
    'Sweep bracketed the optimum: yes',
  )
  await expect(page.getByTestId('pa-bracket-direction')).toHaveCount(0)
  await expect(page.getByTestId('pa-edge-warning')).toHaveCount(0)
})
