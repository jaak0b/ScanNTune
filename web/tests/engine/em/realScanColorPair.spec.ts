// @vitest-environment node
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The colored-coupon regression anchors (yellow coupon on white paper, orange coupon on a
// wrinkled teal sheet) were captured from a coupon printed with the retired narrow-gap spec
// (pitch 0.70 to 1.10 mm, 13 blocks of 7 lines), and tests must validate the current default
// spec only, so the old fixtures and their pinned values are retired.
// TODO(owner): print the current wide-gap coupon (default spec of a fresh printer profile:
// pitch 1.14 to 1.35 mm, 9 blocks of 5 lines, 0.42 mm nominal) in the colored filament, scan
// it at 0 and 180 degrees at 600 dpi, and supply the scans so these tests can be re-pinned
// against the measurement-channel selection (saturation sweep and chromaticity discriminant).
const FIXTURE_NAMES = ['em_widegap_color_0_600dpi.jpg', 'em_widegap_color_180_600dpi.jpg']
const fixturePath = (name: string) =>
  fileURLToPath(new URL(`../../e2e/flow/golden/${name}`, import.meta.url))

describe('real-scan EM regression, colored coupons on colored backings', () => {
  it('measures colored wide-gap coupons from 0 and 180 degree 600 dpi scans', () => {
    const missing = FIXTURE_NAMES.filter((name) => !existsSync(fixturePath(name)))
    if (missing.length > 0) {
      expect.fail(
        `Missing golden fixtures: print the current wide-gap EM coupon (default spec of a ` +
          `fresh printer profile: pitch 1.14 to 1.35 mm, 9 blocks of 5 lines, 0.42 mm ` +
          `nominal) in the colored filament, scan it at 0 and 180 degrees at 600 dpi, and ` +
          `place the scans as ${missing.map(fixturePath).join(' and ')}.`,
      )
    }
    expect.fail(
      'Fixtures present; implement the color-pair assertions (re-pin against the ' +
        'measurement-channel selection: saturation sweep and chromaticity discriminant).',
    )
  })
})
