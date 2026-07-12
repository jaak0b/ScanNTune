// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getCv } from '../../helpers/cv'
import { renderIsScan } from '../../helpers/isRender'
import { rgbaToBgrMat } from '../../../src/engine/imageData'
import type { Mat } from '../../../src/engine/opencv'
import { alignIsCoupon } from '../../../src/engine/is/isFiducialAligner'
import type { IsAlignment } from '../../../src/engine/is/isFiducialAligner'
import { couponCropRect, renderIsOverlayMat } from '../../../src/engine/is/isOverlayRenderer'
import { isCouponGeometry } from '../../../src/engine/is/couponGeometry'
import { tracedSpanPx } from '../../../src/engine/is/lineTracer'
import type { IsAxisResult, IsLineOutcome, IsPointPx } from '../../../src/engine/is/resultTypes'
import { defaultIsTestSpec } from '../../../src/engine/is/types'
import type { IsTestSpec } from '../../../src/engine/is/types'
import { defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'

// The IS detection overlay is a debugging view, so the contract is pixel presence, not
// geometry recovery: an accepted line's traced stretch is drawn green, a skipped line red,
// and a line that was never traced still gets a red annotation at its EXPECTED position
// (that is the damaged-line case the overlay exists for).

const spec: IsTestSpec = { ...defaultIsTestSpec(defaultPrinterProfile()), axes: ['y'] }
const PX_PER_MM = 12

// BGR pixel predicates on the drawn annotation colors (anti-aliased cores keep the pure hue).
const isGreen = (b: number, g: number, r: number) => g >= 180 && r < 100 && b < 100
const isRed = (b: number, g: number, r: number) => r >= 180 && g < 100 && b < 100

function countNear(
  overlay: Mat,
  center: IsPointPx,
  radiusPx: number,
  predicate: (b: number, g: number, r: number) => boolean,
): number {
  const data = overlay.data as Uint8Array
  const cols = overlay.cols
  const rows = overlay.rows
  let count = 0
  for (let dy = -radiusPx; dy <= radiusPx; dy++) {
    for (let dx = -radiusPx; dx <= radiusPx; dx++) {
      const x = Math.round(center.x + dx)
      const y = Math.round(center.y + dy)
      if (x < 0 || y < 0 || x >= cols || y >= rows) continue
      const i = (y * cols + x) * 3
      if (predicate(data[i], data[i + 1], data[i + 2])) count++
    }
  }
  return count
}

// A per-axis result whose line outcomes are chosen by the test: line 0 traced but refused,
// line 1 never traced, the rest accepted. Endpoints come from the same geometry mapping the
// analyzer uses.
function fakeAxisResult(alignment: IsAlignment): IsAxisResult {
  const g = isCouponGeometry(spec)
  const group = g.groups[0]
  const lines: IsLineOutcome[] = group.lines.map((l, i) => {
    const span = tracedSpanPx(alignment, spec, l)
    return {
      lineIndex: i,
      axis: group.axis,
      speedMmS: l.speedMmS,
      traced: i !== 1,
      accepted: i >= 2,
      refusalReason: i < 2 ? 'test reason' : null,
      refusalCategory: i === 1 ? ('not-traced' as const) : i === 0 ? ('weak-ringing' as const) : null,
      startPx: span.start,
      endPx: span.end,
    }
  })
  return {
    axis: group.axis,
    accepted: true,
    refusals: [],
    frequencyHz: 75,
    dampingRatio: 0.05,
    frequencyCi95Hz: 1,
    amplitudeMm: 0.2,
    linesUsed: lines.filter((l) => l.accepted).length,
    linesTraced: lines.filter((l) => l.traced).length,
    scanIndex: 0,
    lines,
    shapers: null,
    recommended: null,
  }
}

// Midpoint of a line's traced stretch, translated from scan pixels into overlay (cropped)
// pixels.
function overlayMidpoint(alignment: IsAlignment, scan: Mat, lineIndex: number): IsPointPx {
  const g = isCouponGeometry(spec)
  const span = tracedSpanPx(alignment, spec, g.groups[0].lines[lineIndex])
  const crop = couponCropRect(alignment, g.couponWidthMm, g.couponHeightMm, scan.cols, scan.rows)
  return {
    x: (span.start.x + span.end.x) / 2 - crop.x,
    y: (span.start.y + span.end.y) / 2 - crop.y,
  }
}

describe('renderIsOverlayMat', () => {
  it(
    'marks accepted lines green, refused lines red, and annotates a never-traced line at its expected position',
    async () => {
      const cv = await getCv()
      const bgr = rgbaToBgrMat(cv, renderIsScan({ spec, truth: {}, pxPerMm: PX_PER_MM }))
      let overlay: Mat | null = null
      try {
        const alignment = alignIsCoupon(cv, bgr, spec)
        expect(alignment.success).toBe(true)
        overlay = renderIsOverlayMat(cv, bgr, alignment, spec, [fakeAxisResult(alignment)], 0)

        // Cropped to the coupon plus a small margin, but still covering the coupon itself.
        expect(overlay.cols).toBeLessThan(bgr.cols)
        expect(overlay.rows).toBeLessThan(bgr.rows)
        const g = isCouponGeometry(spec)
        const scale = Math.hypot(alignment.affine!.a, alignment.affine!.c)
        expect(overlay.cols).toBeGreaterThanOrEqual(Math.floor(g.couponWidthMm * scale))
        expect(overlay.rows).toBeGreaterThanOrEqual(Math.floor(g.couponHeightMm * scale))
        expect(overlay.channels()).toBe(3)

        // An accepted line's traced stretch is green and shows no red near it.
        const acceptedMid = overlayMidpoint(alignment, bgr, 3)
        expect(countNear(overlay, acceptedMid, 4, isGreen)).toBeGreaterThan(0)
        expect(countNear(overlay, acceptedMid, 4, isRed)).toBe(0)

        // A traced-but-refused line is red, not green.
        const refusedMid = overlayMidpoint(alignment, bgr, 0)
        expect(countNear(overlay, refusedMid, 4, isRed)).toBeGreaterThan(0)
        expect(countNear(overlay, refusedMid, 4, isGreen)).toBe(0)

        // The never-traced line still gets a red annotation at its expected position.
        const untracedMid = overlayMidpoint(alignment, bgr, 1)
        expect(countNear(overlay, untracedMid, 4, isRed)).toBeGreaterThan(0)
      } finally {
        overlay?.delete()
        bgr.delete()
      }
    },
    240000,
  )

  it('throws when the alignment did not succeed', async () => {
    const cv = await getCv()
    const bgr = rgbaToBgrMat(cv, renderIsScan({ spec, truth: {}, pxPerMm: PX_PER_MM }))
    try {
      const failed: IsAlignment = {
        success: false,
        failureReason: 'test',
        affine: null,
        fiducialsFound: false,
        orientationSolved: false,
        flipped: false,
        rotationQuarterTurns: 0,
      }
      expect(() => renderIsOverlayMat(cv, bgr, failed, spec, [], 0)).toThrow()
    } finally {
      bgr.delete()
    }
  }, 240000)
})
