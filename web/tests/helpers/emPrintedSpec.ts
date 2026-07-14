import type { EmTestSpec } from '../../src/engine/em/types'

/**
 * The spec of the physically printed EM coupons behind the real-scan regression fixtures
 * (`em_real_scan.png` and the black/color pairs): pitch 0.70 to 1.10 mm, 13 blocks of 7
 * lines, 0.42 mm nominal width. The app's default spec has since moved to wider gaps, but
 * a fixture must always be analyzed under the spec it was printed with, so these values
 * are pinned here rather than taken from `defaultEmTestSpec`.
 */
export function printedEmSpec(): EmTestSpec {
  return {
    pitchMinMm: 0.7,
    pitchMaxMm: 1.1,
    blockCount: 13,
    linesPerBlock: 7,
    lineLengthMm: 25,
    printSpeedMmS: 100,
    nominalLineWidthMm: 0.42,
    placement: 'center',
    contrastBase: false,
  }
}
