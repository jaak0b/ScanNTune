// @vitest-environment node
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The colored-coupon regression anchors (yellow coupon on white paper, orange coupon on a
// wrinkled teal sheet) were captured from a coupon printed with the retired narrow-gap spec
// (pitch 0.70 to 1.10 mm, 13 blocks of 7 lines), and tests must validate the current default
// spec only, so the old fixtures and their pinned values are retired.
// TODO(owner): print the current wide-gap coupon (default spec of a fresh printer profile:
// pitch 1.14 to 1.35 mm, 9 blocks of 5 lines, 0.42 mm nominal) in a colored filament, scan it
// at 0 and 180 degrees at 600 dpi, and add the scans to the flow goldens (web/e2e/flow/golden)
// under the golden naming convention, so these tests can be re-pinned against the
// measurement-channel selection (saturation sweep and chromaticity discriminant).

// Real scans live only in their feature's golden folder, shared with the Playwright flow suite.
const GOLDEN_DIR = fileURLToPath(new URL('../../../e2e/flow/golden/', import.meta.url))

// Golden names are <flow>_<orientation>_<dpi>_<colors>.jpg, colors nearest the glass first
// (the part, then the backing). The black part on a white backing is the monochrome pair the
// wide-gap spec already pins; any other color part is a colored pair.
const PAIR_NAME = /^em_widegap_(0d|180d)_600dpi_([a-z0-9]+(?:_[a-z0-9]+)+)\.jpg$/
const MONOCHROME_COLORS = 'black_white'

/** The color parts that have both a 0d and a 180d 600 dpi wide-gap golden scan. */
function coloredPairs(): string[] {
  const orientationsByColors = new Map<string, Set<string>>()
  for (const name of readdirSync(GOLDEN_DIR)) {
    const match = PAIR_NAME.exec(name)
    if (match === null || match[2] === MONOCHROME_COLORS) continue
    const orientations = orientationsByColors.get(match[2]) ?? new Set<string>()
    orientationsByColors.set(match[2], orientations.add(match[1]))
  }
  return [...orientationsByColors]
    .filter(([, orientations]) => orientations.size === 2)
    .map(([colors]) => colors)
}

describe('real-scan EM regression, colored coupons on colored backings', () => {
  it('measures colored wide-gap coupons from 0 and 180 degree 600 dpi scans', () => {
    const pairs = coloredPairs()
    if (pairs.length === 0) {
      expect.fail(
        'Missing golden fixtures: print the current wide-gap EM coupon (default spec of a ' +
          'fresh printer profile: pitch 1.14 to 1.35 mm, 9 blocks of 5 lines, 0.42 mm ' +
          'nominal) in a colored filament and scan it at 0 and 180 degrees at 600 dpi. Place ' +
          'both scans in web/e2e/flow/golden/ named em_widegap_<0d or 180d>_600dpi_<colors>.jpg, ' +
          'with the colors nearest the glass first (the part, then the backing), for example ' +
          'em_widegap_0d_600dpi_orange_white.jpg and em_widegap_180d_600dpi_orange_white.jpg. ' +
          'Record both scans in the PROVENANCE.md of that folder.',
      )
    }
    expect.fail(
      `Fixtures present (${pairs.join(', ')}); implement the color-pair assertions (re-pin ` +
        'against the measurement-channel selection: saturation sweep and chromaticity ' +
        'discriminant).',
    )
  })
})
