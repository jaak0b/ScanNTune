// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { getCv, syntheticCard, blankGray } from '../helpers/cv'
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
