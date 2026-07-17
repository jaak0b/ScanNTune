// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { getCv, syntheticCard, blankGray, decodePngFileBgr } from '../helpers/cv'
import { measureCard } from '../../src/engine/cardEdgeMeasurer'
import type { Mat, OpenCv } from '../../src/engine/opencv'

// Mirrors ScanNTune.Tests/CardEdgeMeasurerTests.cs (synthetic cards; no fixture needed).
const LongMm = 85.6
const Dpi = 254.0 // -> exactly 10 px/mm nominal

function assertRecovers(cv: OpenCv, img: Mat) {
  try {
    const r = measureCard(cv, img, LongMm, Dpi)
    expect(r.success).toBe(true)
    expect(Math.abs(r.pxPerMm - 10.0)).toBeLessThanOrEqual(0.05)
    expect(Math.abs(r.detectedMm - LongMm)).toBeLessThanOrEqual(0.5)
    expect(r.straightnessPx).toBeLessThan(0.5)
    expect(r.parallelismDegrees).toBeLessThan(0.2)
  } finally {
    img.delete()
  }
}

describe('card edge measurer', () => {
  it('dark card on white recovers px/mm', async () => {
    const cv = await getCv()
    assertRecovers(cv, syntheticCard(cv, 255, 60, false, 0))
  }, 60000)

  it('pale card on dark backing recovers px/mm', async () => {
    const cv = await getCv()
    assertRecovers(cv, syntheticCard(cv, 40, 235, false, 0))
  }, 60000)

  it('portrait card recovers px/mm', async () => {
    const cv = await getCv()
    assertRecovers(cv, syntheticCard(cv, 255, 60, true, 0))
  }, 60000)

  it('slightly rotated card recovers px/mm', async () => {
    const cv = await getCv()
    const img = syntheticCard(cv, 255, 60, false, 3.0)
    try {
      const r = measureCard(cv, img, LongMm, Dpi)
      expect(r.success).toBe(true)
      expect(Math.abs(r.pxPerMm - 10.0)).toBeLessThanOrEqual(0.05)
      expect(r.parallelismDegrees).toBeLessThan(0.2)
    } finally {
      img.delete()
    }
  }, 60000)

  // The rotation the edge tracer must survive: at 5 degrees the edge drifts out of a window that is
  // anchored at the upright bounding box, so the second, fit-recentred pass is what recovers it.
  it('a 5 degree rotated card still traces', async () => {
    const cv = await getCv()
    const img = syntheticCard(cv, 255, 60, false, 5.0)
    try {
      const r = measureCard(cv, img, LongMm, Dpi)
      expect(r.success).toBe(true)
      expect(Math.abs(r.pxPerMm - 10.0)).toBeLessThanOrEqual(0.06)
    } finally {
      img.delete()
    }
  }, 60000)

  // The real-world failure geometry: a dark backing sheet that stops short of the scan bed, so a
  // bright scanner-lid margin dominates the image border. A border-statistics polarity guess flips
  // on this; the card must still be found by validating both polarities against the card's shape.
  it('a card on a dark sheet with a bright lid margin recovers px/mm', async () => {
    const cv = await getCv()
    const scene = new cv.Mat(1300, 1400, cv.CV_8UC1, new cv.Scalar(255)) // bright lid margin
    const sheet = scene.roi(new cv.Rect(150, 140, 1050, 1000))
    sheet.setTo(new cv.Scalar(60)) // dark backing sheet, well inside the scan
    sheet.delete()
    const card = scene.roi(new cv.Rect(280, 350, 856, 540)) // pale card, 10 px/mm
    card.setTo(new cv.Scalar(235))
    card.delete()
    assertRecovers(cv, scene)
  }, 60000)

  // A card lying inside a card-ratio encloser (a sleeve): the true card and the sleeve are nested
  // near-equal candidates; the one whose long side matches the dpi prediction is the card, so the
  // inner card must be measured, not the sleeve.
  it('a card inside a card-ratio sleeve measures the card, not the sleeve', async () => {
    const cv = await getCv()
    const scene = new cv.Mat(1000, 1400, cv.CV_8UC1, new cv.Scalar(255))
    const sleeve = scene.roi(new cv.Rect(200, 190, 985, 621)) // 985/621 ~ the ISO ratio
    sleeve.setTo(new cv.Scalar(150))
    sleeve.delete()
    const card = scene.roi(new cv.Rect(264, 230, 856, 540)) // the true card, 10 px/mm
    card.setTo(new cv.Scalar(60))
    card.delete()
    try {
      const r = measureCard(cv, scene, LongMm, Dpi)
      expect(r.success).toBe(true)
      expect(Math.abs(r.pxPerMm - 10.0)).toBeLessThanOrEqual(0.05)
    } finally {
      scene.delete()
    }
  }, 60000)

  // Two separate similar-size card-shaped objects are genuinely ambiguous and must be refused, not
  // silently resolved to either one.
  it('two distinct card-shaped objects are refused as ambiguous', async () => {
    const cv = await getCv()
    const scene = new cv.Mat(1400, 2200, cv.CV_8UC1, new cv.Scalar(255))
    const a = scene.roi(new cv.Rect(100, 400, 856, 540))
    a.setTo(new cv.Scalar(60))
    a.delete()
    const b = scene.roi(new cv.Rect(1150, 400, 900, 567)) // a second card-shaped object, different tone
    b.setTo(new cv.Scalar(150))
    b.delete()
    try {
      const r = measureCard(cv, scene, LongMm, Dpi)
      expect(r.success).toBe(false)
      expect(r.message).toMatch(/More than one/)
    } finally {
      scene.delete()
    }
  }, 60000)

  it('a card clipped by the scan border is refused', async () => {
    const cv = await getCv()
    const scene = new cv.Mat(1120, 1220, cv.CV_8UC1, new cv.Scalar(255))
    const card = scene.roi(new cv.Rect(0, 300, 856, 540)) // touches the left border
    card.setTo(new cv.Scalar(60))
    card.delete()
    try {
      const r = measureCard(cv, scene, LongMm, Dpi)
      expect(r.success).toBe(false)
      expect(r.message).toBeTruthy()
    } finally {
      scene.delete()
    }
  }, 60000)

  it('a sheet without a card is refused, not measured', async () => {
    const cv = await getCv()
    const scene = new cv.Mat(1300, 1400, cv.CV_8UC1, new cv.Scalar(255))
    const sheet = scene.roi(new cv.Rect(150, 140, 1050, 1000))
    sheet.setTo(new cv.Scalar(60))
    sheet.delete()
    try {
      const r = measureCard(cv, scene, LongMm, Dpi)
      expect(r.success).toBe(false)
      expect(r.message).toBeTruthy()
    } finally {
      scene.delete()
    }
  }, 60000)

  // Real 300 dpi scan, byte-for-byte: the two overlapping logo circles on the card face form a
  // card-ratio rectangle in one dark-threshold band, so before the containment and size gates the
  // measurer refused the scan as ambiguous. Golden fixture from e2e/card-calibration; per its
  // PROVENANCE.md the owner-caliper long side is 85.55 mm and the app displayed 11.796 px/mm.
  it('a real 300 dpi scan with a card-ratio logo on the card recovers px/mm', async () => {
    const cv = await getCv()
    const img = decodePngFileBgr(
      cv,
      fileURLToPath(new URL('../../e2e/card-calibration/golden/card_300dpi.png', import.meta.url)),
    )
    try {
      const r = measureCard(cv, img, 85.55, 300)
      expect(r.success).toBe(true)
      expect(Math.abs(r.pxPerMm - 300 / 25.4)).toBeLessThanOrEqual(0.12) // ~1% dpi error allowance
      expect(r.parallelismDegrees).toBeLessThan(0.5)
    } finally {
      img.delete()
    }
  }, 60000)

  // The real 600 dpi card scan the e2e suite uses: about 23.6 px/mm (per the card-calibration
  // golden PROVENANCE the app displays 23.584 px/mm for this scan at 85.55 mm entered).
  it('the real 600 dpi card scan recovers ~23.6 px/mm', async () => {
    const cv = await getCv()
    const img = decodePngFileBgr(
      cv,
      fileURLToPath(new URL('../../e2e/card-calibration/golden/card_600dpi.png', import.meta.url)),
    )
    try {
      const r = measureCard(cv, img, 85.55, 600)
      expect(r.success).toBe(true)
      expect(r.pxPerMm).toBeGreaterThan(23.3)
      expect(r.pxPerMm).toBeLessThan(23.9)
    } finally {
      img.delete()
    }
  }, 60000)

  it('a blank scan fails gracefully', async () => {
    const cv = await getCv()
    const img = blankGray(cv, 400, 255)
    try {
      const r = measureCard(cv, img, LongMm, Dpi)
      expect(r.success).toBe(false)
      expect(r.message).toBeTruthy()
    } finally {
      img.delete()
    }
  }, 60000)
})
