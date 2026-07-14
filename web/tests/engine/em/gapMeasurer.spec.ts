// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getCv } from '../../helpers/cv'
import { renderEmScan } from '../../helpers/emRender'
import { rgbaToBgrMat } from '../../../src/engine/imageData'
import { valueChannel } from '../../../src/engine/cvUtils'
import { alignEmCoupon } from '../../../src/engine/em/fiducialAligner'
import { measureEmCoupon } from '../../../src/engine/em/gapMeasurer'
import type { EmMeasurement } from '../../../src/engine/em/gapMeasurer'
import { defaultEmTestSpec, pitchForBlock } from '../../../src/engine/em/types'
import { defaultPrinterProfile } from '../../../src/engine/pa/types'

const spec = defaultEmTestSpec(defaultPrinterProfile())
const TRUE_WIDTH_MM = 0.42
const PX_PER_MM = 12

async function measureRender(pitchScale: number, pxPerMm: number = PX_PER_MM): Promise<EmMeasurement> {
  const cv = await getCv()
  const img = rgbaToBgrMat(
    cv,
    renderEmScan({ spec, trueWidthMm: TRUE_WIDTH_MM, pxPerMm, pitchScale }),
  )
  const gray = valueChannel(cv, img)
  try {
    const alignment = alignEmCoupon(cv, img, spec)
    expect(alignment.success).toBe(true)
    // The render's px/mm doubles as the card-calibrated scanner px/mm (an exact scanner).
    return measureEmCoupon(cv, gray, alignment, spec, pxPerMm)
  } finally {
    gray.delete()
    img.delete()
  }
}

describe('measureEmCoupon', () => {
  it(
    'measures every block with the commanded line and gap counts on a clean render',
    async () => {
      const m = await measureRender(1)

      expect(m.blocks).toHaveLength(2 * spec.blockCount)
      for (const b of m.blocks) {
        expect(b.lineCentersMm).toHaveLength(spec.linesPerBlock)
        expect(b.gapsMm).toHaveLength(spec.linesPerBlock - 1)
        expect(b.pitchCommandedMm).toBeCloseTo(pitchForBlock(spec, b.blockIndex), 10)

        // Center spacing recovers the commanded pitch.
        for (let j = 1; j < b.lineCentersMm.length; j++) {
          const spacing = b.lineCentersMm[j] - b.lineCentersMm[j - 1]
          expect(Math.abs(spacing - b.pitchCommandedMm)).toBeLessThan(0.01)
        }
        // Gaps recover pitch minus the true deposited width.
        for (const gap of b.gapsMm) {
          expect(Math.abs(gap - (b.pitchCommandedMm - TRUE_WIDTH_MM))).toBeLessThan(0.015)
        }
      }

      // Every between-block separator on both rows, each at its commanded 2 mm.
      expect(m.separators).toHaveLength(2 * (spec.blockCount - 1))
      for (const s of m.separators) {
        expect(Math.abs(s.widthMm - 2)).toBeLessThan(0.02)
      }

      expect(Math.abs(m.pitchScale - 1)).toBeLessThan(0.003)
    },
    240000,
  )

  it(
    'recovers a 1.01 printer pitch stretch and gaps consistent with the stretched pitch',
    async () => {
      const stretch = 1.01
      const m = await measureRender(stretch)

      expect(m.blocks).toHaveLength(2 * spec.blockCount)
      expect(m.pitchScale).toBeGreaterThanOrEqual(1.007)
      expect(m.pitchScale).toBeLessThanOrEqual(1.013)
      for (const b of m.blocks) {
        // The physical gap is the STRETCHED pitch minus the deposited width.
        for (const gap of b.gapsMm) {
          expect(Math.abs(gap - (b.pitchCommandedMm * stretch - TRUE_WIDTH_MM))).toBeLessThan(0.015)
        }
      }
    },
    240000,
  )

  it(
    'measures every block at low scanner resolution',
    async () => {
      // 7 px/mm shrinks the centroid window enough to exercise its clamped-to-few-samples path.
      const m = await measureRender(1, 7)

      // The wide-gap sweep keeps every gap at 0.72 mm or more (5 px at this resolution), so no
      // block can merge in the combined profile and full coverage is expected even here. Every
      // block's sub-pixel precision is coarser than at full resolution (edge localization error
      // scales with pixel pitch), so the tolerances below are wider than the 12 px/mm test's,
      // not tight enough to hide a real detection bug.
      expect(m.blocks).toHaveLength(2 * spec.blockCount)

      const CENTER_TOLERANCE_MM = 0.025
      const GAP_TOLERANCE_MM = 0.035
      for (const b of m.blocks) {
        expect(b.lineCentersMm).toHaveLength(spec.linesPerBlock)
        expect(b.gapsMm).toHaveLength(spec.linesPerBlock - 1)

        for (let j = 1; j < b.lineCentersMm.length; j++) {
          const spacing = b.lineCentersMm[j] - b.lineCentersMm[j - 1]
          expect(Math.abs(spacing - b.pitchCommandedMm)).toBeLessThan(CENTER_TOLERANCE_MM)
        }
        for (const gap of b.gapsMm) {
          expect(Math.abs(gap - (b.pitchCommandedMm - TRUE_WIDTH_MM))).toBeLessThan(
            GAP_TOLERANCE_MM,
          )
        }
      }
    },
    240000,
  )
})
