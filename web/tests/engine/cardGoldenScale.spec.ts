// @vitest-environment node
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { getCv, decodePngFileBgr } from '../helpers/cv'
import { measureCard } from '../../src/engine/cardEdgeMeasurer'

// The same physical card scanned at 150 and 300 dpi on the same scanner measures px/mm in a fixed
// proportion; any drift in that proportion is a dpi-dependent localization change in the edge
// measurer. These golden scans are tracked in the repo (unlike the wider Data/ corpus), so this
// pins the relative dpi behavior of the sub-pixel stage in CI. The 300 dpi scan is the one
// validated against an external caliper measurement of the card. Per the card-calibration golden
// PROVENANCE these two owner-validated captures read vs-nominal -0.226 % (150 dpi) and -0.131 %
// (300 dpi), a real 0.095 percentage-point inter-capture difference, so the pinned ratio is the
// observed 2.001919, not an idealized exact 2.

const LONG_MM = 85.6

const goldenDir = fileURLToPath(new URL('../../e2e/card-calibration/golden', import.meta.url))

function measure(cv: Awaited<ReturnType<typeof getCv>>, path: string, dpi: number) {
  const img = decodePngFileBgr(cv, path)
  try {
    const r = measureCard(cv, img, LONG_MM, dpi)
    expect(r.success).toBe(true)
    return r
  } finally {
    img.delete()
  }
}

describe('golden card scans measure dpi-proportionally', () => {
  it('150 and 300 dpi cards agree on px/mm at the pinned ratio', async () => {
    const cv = await getCv()
    const r150 = measure(cv, `${goldenDir}/card_150dpi.png`, 150)
    const r300 = measure(cv, `${goldenDir}/card_300dpi.png`, 300)
    const ratio = r300.pxPerMm / r150.pxPerMm
    console.log(
      `pxPerMm 150 = ${r150.pxPerMm.toFixed(5)} 300 = ${r300.pxPerMm.toFixed(5)} ` +
        `ratio = ${ratio.toFixed(6)}`,
    )
    // Each scan must sit near its nominal resolution (a sanity bound, not the bias test).
    expect(Math.abs(r150.pxPerMm / (150 / 25.4) - 1)).toBeLessThan(0.02)
    expect(Math.abs(r300.pxPerMm / (300 / 25.4) - 1)).toBeLessThan(0.02)
    // The bias test: the ratio must hold its pinned value to within 5e-4 relative.
    expect(Math.abs(ratio / 2.001919 - 1)).toBeLessThan(5e-4)
  }, 300000)
})
