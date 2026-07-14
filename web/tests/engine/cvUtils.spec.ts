// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getCv } from '../helpers/cv'
import {
  analyzeThresholdBands,
  deepestFailure,
  discriminantChannel,
  saturationChannel,
  selectMeasurementChannel,
  valueChannel,
} from '../../src/engine/cvUtils'
import { assessMeasurementBackdrop } from '../../src/engine/measurementBackdrop'
import type { Mat } from '../../src/engine/opencv'

describe('analyzeThresholdBands early exit', () => {
  // A three-population gray image so several distinct threshold bands exist.
  async function threeToneImage() {
    const cv = await getCv()
    const image = new cv.Mat(60, 60, cv.CV_8UC1, new cv.Scalar(30))
    cv.rectangle(image, new cv.Point(0, 20), new cv.Point(60, 40), new cv.Scalar(128), -1)
    cv.rectangle(image, new cv.Point(0, 40), new cv.Point(60, 60), new cv.Scalar(230), -1)
    return { cv, image }
  }

  it('stops evaluating bands once isDone returns true', async () => {
    const { cv, image } = await threeToneImage()
    try {
      let calls = 0
      const results = analyzeThresholdBands(
        cv,
        image,
        () => ++calls,
        (n) => n === 2,
      )
      expect(calls).toBe(2)
      expect(results).toEqual([1, 2])
    } finally {
      image.delete()
    }
  })

  it('evaluates every band when isDone is omitted', async () => {
    const { cv, image } = await threeToneImage()
    try {
      let calls = 0
      const results = analyzeThresholdBands(cv, image, () => ++calls)
      expect(calls).toBeGreaterThan(2)
      expect(results).toHaveLength(calls)
    } finally {
      image.delete()
    }
  })
})

describe('analyzeThresholdBands saturation sweep', () => {
  it('finds a band isolating a saturated object on a white backdrop of the same value', async () => {
    const cv = await getCv()
    // Saturated yellow rectangle on white: both are near-max in the value channel (V = max of
    // B, G, R), so only a saturation band can separate them.
    const image = new cv.Mat(80, 80, cv.CV_8UC3, new cv.Scalar(255, 255, 255))
    cv.rectangle(image, new cv.Point(20, 20), new cv.Point(60, 60), new cv.Scalar(0, 200, 240), -1)
    const rectArea = 40 * 40
    try {
      const areas = analyzeThresholdBands(cv, image, (objectWhite) => {
        const contours = new cv.MatVector()
        const hierarchy = new cv.Mat()
        try {
          cv.findContours(objectWhite, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
          let largest = 0
          for (let i = 0; i < contours.size(); i++) {
            const contour = contours.get(i)
            try {
              largest = Math.max(largest, cv.contourArea(contour))
            } finally {
              contour.delete()
            }
          }
          return largest
        } finally {
          contours.delete()
          hierarchy.delete()
        }
      })
      const isolating = areas.some((a) => Math.abs(a - rectArea) / rectArea < 0.05)
      expect(isolating).toBe(true)
    } finally {
      image.delete()
    }
  })
})

describe('selectMeasurementChannel', () => {
  // Assesses a candidate plane with the shared backdrop gate: feature tones from inside the
  // 20..60 square, backdrop tones from the surrounding border, mirroring how the flows sample
  // through their alignments.
  function assess(gray: Mat) {
    const data = gray.data as Uint8Array
    const cols = gray.cols
    const feature: number[] = []
    const backdrop: number[] = []
    for (let y = 4; y < 80; y += 8) {
      for (let x = 4; x < 80; x += 8) {
        const inside = x > 24 && x < 56 && y > 24 && y < 56
        ;(inside ? feature : backdrop).push(data[y * cols + x])
      }
    }
    return assessMeasurementBackdrop(feature, backdrop)
  }

  it('falls back to the saturation plane when only it carries contrast (yellow on white)', async () => {
    const cv = await getCv()
    // Saturated yellow on white: near-equal value (240 vs 255), full saturation separation.
    const image = new cv.Mat(80, 80, cv.CV_8UC3, new cv.Scalar(255, 255, 255))
    cv.rectangle(image, new cv.Point(25, 25), new cv.Point(55, 55), new cv.Scalar(0, 200, 240), -1)
    try {
      const { gray, assessment } = selectMeasurementChannel(cv, image, assess)
      try {
        expect(assessment.failure).toBeNull()
        const data = gray.data as Uint8Array
        // The saturation plane: chromatic inside, zero on the white backdrop.
        expect(data[40 * gray.cols + 40]).toBeGreaterThan(200)
        expect(data[4 * gray.cols + 4]).toBe(0)
      } finally {
        gray.delete()
      }
    } finally {
      image.delete()
    }
  })

  it('keeps the value plane for a neutral scene where saturation carries nothing', async () => {
    const cv = await getCv()
    const image = new cv.Mat(80, 80, cv.CV_8UC3, new cv.Scalar(245, 245, 245))
    cv.rectangle(image, new cv.Point(25, 25), new cv.Point(55, 55), new cv.Scalar(40, 40, 40), -1)
    try {
      const { gray, assessment } = selectMeasurementChannel(cv, image, assess)
      try {
        expect(assessment.failure).toBeNull()
        const data = gray.data as Uint8Array
        // The value plane: the dark square's brightness, not its (zero) saturation.
        expect(data[40 * gray.cols + 40]).toBe(40)
        expect(data[4 * gray.cols + 4]).toBe(245)
      } finally {
        gray.delete()
      }
    } finally {
      image.delete()
    }
  })

  it('reports the highest-contrast candidate when every plane fails', async () => {
    const cv = await getCv()
    // Uniform white: no plane carries any contrast, so the returned assessment fails.
    const image = new cv.Mat(80, 80, cv.CV_8UC3, new cv.Scalar(245, 245, 245))
    try {
      const { gray, assessment } = selectMeasurementChannel(cv, image, assess)
      try {
        expect(assessment.failure).toBe('low-contrast')
      } finally {
        gray.delete()
      }
    } finally {
      image.delete()
    }
  })
})

describe('selectMeasurementChannel discriminant fallback', () => {
  // Orange square on a teal backdrop, both chosen so neither brightness nor saturation
  // separates them: teal BGR (220, 190, 60) has V = 220 and S = 185, orange BGR (60, 170, 240)
  // has V = 240 and S = 181 (hand-calculated HSV), so both planes sit under the 30-level
  // contrast floor and only the hue direction separates the two. A smooth additive brightness
  // gradient (+-16 across the image, the wrinkled-sheet shading) rides on top.
  const TEAL = [220, 190, 60]
  const ORANGE = [60, 170, 240]

  async function gradientImage() {
    const cv = await getCv()
    const image = new cv.Mat(80, 80, cv.CV_8UC3)
    const data = image.data as Uint8Array
    for (let y = 0; y < 80; y++) {
      for (let x = 0; x < 80; x++) {
        const inside = x >= 25 && x < 55 && y >= 25 && y < 55
        const color = inside ? ORANGE : TEAL
        const shade = Math.round((x - 40) * 0.4)
        const i = (y * 80 + x) * 3
        for (let c = 0; c < 3; c++) {
          data[i + c] = Math.max(0, Math.min(255, color[c] + shade))
        }
      }
    }
    return { cv, image }
  }

  // The same sample grid as the plain selectMeasurementChannel tests: feature triples from the
  // central square, backdrop triples from the border, mirroring the flows' gate positions.
  function gridSamples(read: (x: number, y: number) => number[] | number) {
    const feature: ReturnType<typeof read>[] = []
    const backdrop: ReturnType<typeof read>[] = []
    for (let y = 4; y < 80; y += 8) {
      for (let x = 4; x < 80; x += 8) {
        const inside = x > 24 && x < 56 && y > 24 && y < 56
        ;(inside ? feature : backdrop).push(read(x, y))
      }
    }
    return { feature, backdrop }
  }

  function assess(gray: Mat) {
    const data = gray.data as Uint8Array
    const cols = gray.cols
    const { feature, backdrop } = gridSamples((x, y) => data[y * cols + x])
    return assessMeasurementBackdrop(feature as number[], backdrop as number[])
  }

  function colorSamples(image: Mat) {
    const data = image.data as Uint8Array
    const cols = image.cols
    const { feature, backdrop } = gridSamples((x, y) => [
      data[(y * cols + x) * 3],
      data[(y * cols + x) * 3 + 1],
      data[(y * cols + x) * 3 + 2],
    ])
    return { feature: feature as number[][], backdrop: backdrop as number[][] }
  }

  it('value and saturation both fail on hue-only contrast, the discriminant plane passes', async () => {
    const { cv, image } = await gradientImage()
    try {
      const value = valueChannel(cv, image)
      const saturation = saturationChannel(cv, image)
      try {
        expect(assess(value).failure).not.toBeNull()
        expect(assess(saturation).failure).not.toBeNull()
      } finally {
        value.delete()
        saturation.delete()
      }

      const { gray, assessment } = selectMeasurementChannel(cv, image, assess, colorSamples(image))
      try {
        expect(assessment.failure).toBeNull()
      } finally {
        gray.delete()
      }
    } finally {
      image.delete()
    }
  })

  it('keeps the shadowed backdrop with the lit backdrop, not the plastic (chromaticity invariance)', async () => {
    const cv = await getCv()
    // The same orange-on-teal scene, but the left half of the backdrop sits in a scanner-lamp
    // shadow: the same teal hue at 60% brightness (a multiplicative illumination change). In
    // chromaticity coordinates the shadowed teal is identical to the lit teal, so the
    // discriminant plane must still separate plastic from backdrop and pass the gate; a raw-BGR
    // discriminant projects the darkened teal onto the plastic side and fails it.
    const image = new cv.Mat(80, 80, cv.CV_8UC3)
    const data = image.data as Uint8Array
    for (let y = 0; y < 80; y++) {
      for (let x = 0; x < 80; x++) {
        const inside = x >= 25 && x < 55 && y >= 25 && y < 55
        const shadowed = !inside && x < 40
        const color = inside ? ORANGE : TEAL
        const i = (y * 80 + x) * 3
        for (let c = 0; c < 3; c++) {
          data[i + c] = Math.round(color[c] * (shadowed ? 0.6 : 1))
        }
      }
    }
    try {
      // Half the backdrop class samples land in the shadow, exactly as the flows' gate grids do
      // when a separator wall casts a lamp shadow onto the backing sheet.
      const { gray, assessment } = selectMeasurementChannel(cv, image, assess, colorSamples(image))
      try {
        expect(assessment.failure).toBeNull()
      } finally {
        gray.delete()
      }
    } finally {
      image.delete()
    }
  })

  it('still reports the failure without color samples on the same scene', async () => {
    const { cv, image } = await gradientImage()
    try {
      const { gray, assessment } = selectMeasurementChannel(cv, image, assess)
      try {
        expect(assessment.failure).toBe('low-contrast')
      } finally {
        gray.delete()
      }
    } finally {
      image.delete()
    }
  })
})

describe('discriminantChannel', () => {
  const TEAL = [220, 190, 60]
  const ORANGE = [60, 170, 240]

  // Left half teal, right half orange, no gradient: a minimal two-class scene.
  async function twoToneImage() {
    const cv = await getCv()
    const image = new cv.Mat(8, 8, cv.CV_8UC3)
    const data = image.data as Uint8Array
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const color = x < 4 ? TEAL : ORANGE
        const i = (y * 8 + x) * 3
        for (let c = 0; c < 3; c++) data[i + c] = color[c]
      }
    }
    return { cv, image }
  }

  it('returns null below the minimum class size for a stable scatter estimate', async () => {
    const { cv, image } = await twoToneImage()
    try {
      const result = discriminantChannel(cv, image, [ORANGE, ORANGE], [TEAL, TEAL, TEAL, TEAL])
      expect(result).toBeNull()
    } finally {
      image.delete()
    }
  })

  it('returns null when the class means coincide', async () => {
    const { cv, image } = await twoToneImage()
    try {
      const samples = [ORANGE, TEAL, [10, 20, 30], [200, 100, 50]]
      const result = discriminantChannel(cv, image, samples, samples)
      expect(result).toBeNull()
    } finally {
      image.delete()
    }
  })

  it('falls back to the nearest-mean projection on a singular scatter and still separates', async () => {
    const { cv, image } = await twoToneImage()
    try {
      // Zero within-class variance makes the scatter singular, forcing the difference-of-means
      // fallback. The samples' own projections define the 8-bit range, so the two constant
      // classes must land exactly on its ends: orange 255, teal 0.
      const feature = [ORANGE, ORANGE, ORANGE, ORANGE, ORANGE]
      const backdrop = [TEAL, TEAL, TEAL, TEAL, TEAL]
      const result = discriminantChannel(cv, image, feature, backdrop)
      expect(result).not.toBeNull()
      try {
        const data = result!.data as Uint8Array
        expect(result!.type()).toBe(cv.CV_8UC1)
        expect(data[4 * 8 + 1]).toBe(0) // teal half
        expect(data[4 * 8 + 6]).toBe(255) // orange half
      } finally {
        result!.delete()
      }
    } finally {
      image.delete()
    }
  })
})

describe('deepestFailure', () => {
  interface Attempt {
    stage: number
    reason: string
  }
  const stageOf = (a: Attempt) => a.stage

  it('returns the attempt with the highest stage', () => {
    const attempts: Attempt[] = [
      { stage: 0, reason: 'no plate' },
      { stage: 2, reason: 'holes missing' },
      { stage: 1, reason: 'wrong shape' },
    ]
    expect(deepestFailure(attempts, stageOf)).toEqual({ stage: 2, reason: 'holes missing' })
  })

  it('keeps the first attempt among equal-stage ties', () => {
    const attempts: Attempt[] = [
      { stage: 1, reason: 'first' },
      { stage: 1, reason: 'second' },
      { stage: 0, reason: 'shallow' },
    ]
    expect(deepestFailure(attempts, stageOf)).toEqual({ stage: 1, reason: 'first' })
  })

  it('returns null for no attempts', () => {
    expect(deepestFailure([], stageOf)).toBeNull()
  })
})
