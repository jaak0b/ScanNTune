import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'

// Real-world end-to-end tests over the user's actual scans plus the rendered calibration plates. The
// core regression is the bug that motivated the rewrite: analysis must complete in the browser
// without freezing.
const card = fileURLToPath(new URL('./fixtures/card.png', import.meta.url))
const scan0 = fileURLToPath(new URL('./fixtures/scan1-0.png', import.meta.url))
const scan90 = fileURLToPath(new URL('./fixtures/scan1-90.png', import.meta.url))
// The user's real new-plate scans on a backing sheet that stops short of the scan bed: the bright
// scanner-lid margin flipped the old border-based polarity guess, so only dust registered. The
// polarity is now resolved by validating both threshold polarities against the coupon grid.
const realxy0 = fileURLToPath(new URL('./fixtures/realxy-0.png', import.meta.url))
const realxy90 = fileURLToPath(new URL('./fixtures/realxy-90.png', import.meta.url))
// Real scans of a printed plate carrying the diagonal plane-ID marks (35 MP, 600 dpi).
const realdiag0 = fileURLToPath(new URL('./fixtures/realdiag-0.png', import.meta.url))
const realdiag90 = fileURLToPath(new URL('./fixtures/realdiag-90.png', import.meta.url))

const plate = (p: string, rot: number) =>
  fileURLToPath(new URL(`./fixtures/plate_${p}_${rot}.png`, import.meta.url))

test.beforeEach(async ({ page }) => {
  page.on('console', (msg) => console.log(`[browser:${msg.type()}]`, msg.text()))
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await page.addInitScript(() => localStorage.clear())
})

test('the app loads', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Skew/shrinkage calibration' })).toBeVisible()
})

test('calibration flow recovers ~23.6 px/mm from the real card scan', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('calibrate-btn').click()
  await page.getByLabel('Measured long side (mm)').fill('85.5')
  await page.getByTestId('card-input').setInputFiles(card)

  await expect(page.getByTestId('calibration-result')).toBeVisible({ timeout: 120000 })
  const pxPerMm = parseFloat(await page.getByTestId('pxpermm').innerText())
  console.log('card px/mm =', pxPerMm)
  expect(pxPerMm).toBeGreaterThan(23.3)
  expect(pxPerMm).toBeLessThan(23.9)
  await expect(page.getByTestId('saved')).toBeVisible()
})

test('calibration recovers after uploading before entering the measurement', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('calibrate-btn').click()

  await page.getByTestId('card-input').setInputFiles(card)
  await expect(page.getByText('Enter your measured size')).toBeVisible()

  await page.getByLabel('Measured long side (mm)').fill('85.5')
  await expect(page.getByText('Enter your measured size')).toBeHidden()

  await page.getByTestId('card-input').setInputFiles(card)
  await expect(page.getByTestId('calibration-result')).toBeVisible({ timeout: 120000 })
  await expect(page.getByTestId('saved')).toBeVisible()
})

test('the original dot-less coupon never enables Analyze (no axis, never guessed as XY)', async ({ page }) => {
  await page.goto('/')
  // The original coupon has no plane-ID dots. On real 35 MP scans the pipeline must complete without
  // freezing (the regression that motivated the rewrite); each scan gets an island, but with no axis
  // it can't be assigned to a plane, so the data-driven Analyze button stays disabled.
  await page.getByTestId('scans-input').setInputFiles([scan0, scan90])
  await expect(page.locator('[data-testid="scan-island"]')).toHaveCount(2)
  // Wait for both to finish analysing (their ring tally appears).
  await expect(page.getByTestId('ring-count')).toHaveCount(2, { timeout: 120000 })

  // Not analysable, and crucially no silent XY result was produced.
  await expect(page.getByTestId('analyze-btn')).toBeDisabled()
  await expect(page.getByTestId('scale-X')).toHaveCount(0)
})

test('real scans with a bright lid margin align but stay unlabeled (dot-era print)', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('scans-input').setInputFiles([realxy0, realxy90])

  // Each scan is analysed on upload into its own island; both must register every hole and align.
  // These are scans of a plate printed with the retired dot code, so the plane-ID diagonals are
  // absent: alignment and ring detection still work, but the plane stays unassigned and Analyze
  // stays disabled (never silently guessed as XY). A scan of a diagonal-marked print is needed to
  // cover the full real-scan measurement flow again.
  await expect(page.locator('[data-testid="scan-island"]')).toHaveCount(2)
  const counts = page.getByTestId('ring-count')
  await expect(counts.first()).toContainText('23 of 23', { timeout: 120000 })
  await expect(counts.nth(1)).toContainText('23 of 23', { timeout: 120000 })

  // The Scan/Threshold toggle is offered, so the mask the detector searched was rendered.
  await expect(page.getByTestId('threshold-toggle').first()).toBeVisible()

  // No plane label, no analysis.
  await expect(page.getByTestId('analyze-btn')).toBeDisabled()
  await expect(page.getByTestId('scale-X')).toHaveCount(0)
})

test('real scans of a diagonal-marked print measure end to end', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('scans-input').setInputFiles([realdiag0, realdiag90])

  // Each scan is analysed on upload into its own island; both must register every hole, align,
  // and read the XY plane from the diagonal marks on the real print.
  await expect(page.locator('[data-testid="scan-island"]')).toHaveCount(2)
  const counts = page.getByTestId('ring-count')
  await expect(counts.first()).toContainText('23 of 23', { timeout: 120000 })
  await expect(counts.nth(1)).toContainText('23 of 23', { timeout: 120000 })
  await expect(page.locator('[data-testid="scan-island"]').first()).toContainText('XY plane')

  // The pair is analysable and produces the X/Y measurement without freezing on 35 MP scans.
  await expect(page.getByTestId('analyze-btn')).toBeEnabled()
  await page.getByTestId('analyze-btn').click()
  for (const axis of ['X', 'Y']) {
    await expect(page.getByTestId(`scale-${axis}`)).toBeVisible({ timeout: 120000 })
  }
})

test('all three rendered plates auto-sort into X/Y/Z scale and skew', async ({ page }) => {
  await page.goto('/')
  // Drop in all six scans (two per plate, a quarter-turn apart); the app sorts them by plane-ID.
  await page
    .getByTestId('scans-input')
    .setInputFiles([
      plate('xy', 0),
      plate('xy', 90),
      plate('xz', 0),
      plate('xz', 90),
      plate('yz', 0),
      plate('yz', 90),
    ])
  // Wait for all six to finish analyzing before hitting Analyze, so none are dropped.
  await expect(page.locator('[data-testid="scan-island"]')).toHaveCount(6)
  await expect(page.getByTestId('analyze-btn')).toBeEnabled({ timeout: 120000 })
  // Clear the DPI so scales are reported relative (anisotropy + skew), independent of the render size.
  await page.getByLabel('Scanner DPI').fill('')
  await expect(page.getByTestId('analyze-btn')).toBeEnabled()
  await page.getByTestId('analyze-btn').click()

  // Every physical axis and every plane skew must appear: the plates were auto-identified and combined.
  for (const axis of ['X', 'Y', 'Z']) {
    await expect(page.getByTestId(`scale-${axis}`)).toBeVisible({ timeout: 120000 })
  }
  for (const p of ['XY', 'XZ', 'YZ']) {
    await expect(page.getByTestId(`skew-${p}`)).toBeVisible()
    const skew = parseFloat(await page.getByTestId(`skew-${p}`).innerText())
    console.log(`${p} skew =`, skew)
    expect(Math.abs(skew)).toBeLessThan(0.5)
  }

  // New calibration resets the session: it disposes the scans and returns to an empty upload step.
  await page.getByTestId('startover-btn').click()
  await expect(page.getByRole('heading', { name: 'Skew/shrinkage calibration' })).toBeVisible()
  await expect(page.locator('[data-testid="scan-island"]')).toHaveCount(0)
})
