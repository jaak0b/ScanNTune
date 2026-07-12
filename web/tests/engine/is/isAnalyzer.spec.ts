// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getCv } from '../../helpers/cv'
import { renderIsScan } from '../../helpers/isRender'
import type { IsRenderOptions } from '../../helpers/isRender'
import { rgbaToBgrMat } from '../../../src/engine/imageData'
import { analyzeIsCoupon } from '../../../src/engine/is/isAnalyzer'
import type { IsResult, IsAxisResult } from '../../../src/engine/is/resultTypes'
import { defaultIsTestSpec } from '../../../src/engine/is/types'
import type { IsTestSpec } from '../../../src/engine/is/types'
import { defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'
import type { ScaleReference } from '../../../src/engine/scannerCalibration'

// Ground-truth recovery contract for the input shaper pipeline (rule-1 style): coupons are
// rendered by tests/helpers/isRender.ts from known frequency, damping, and amplitude, and the
// two-scan analysis must recover them, or refuse with the specific user-worded reason. Renders
// are mirrored (flipped: true) like a real face-down scan.

// The analyzer refuses scans below the measurement resolution floor, so the synthetic scans are
// rendered at the 600 dpi class resolution a real scan is expected to have.
const PX_PER_MM = 24
const baseSpec = defaultIsTestSpec(defaultPrinterProfile())
// A single-axis (Y only) spec keeps the coupon, and thus the render time, small for the
// refusal-gate tests; the flagship recovery test uses the full two-axis default.
const ySpec: IsTestSpec = { ...baseSpec, axes: ['y'] }

async function analyzePair(
  spec: IsTestSpec,
  optionsA: Omit<IsRenderOptions, 'spec'>,
  optionsB: Omit<IsRenderOptions, 'spec'>,
  reference: ScaleReference = PX_PER_MM,
): Promise<IsResult> {
  const cv = await getCv()
  const a = rgbaToBgrMat(cv, renderIsScan({ pxPerMm: PX_PER_MM, spec, ...optionsA }))
  const b = rgbaToBgrMat(cv, renderIsScan({ pxPerMm: PX_PER_MM, spec, ...optionsB }))
  try {
    return analyzeIsCoupon(cv, a, b, spec, reference)
  } finally {
    a.delete()
    b.delete()
  }
}

function axisOf(result: IsResult, axis: 'x' | 'y'): IsAxisResult {
  const found = result.axes.find((a) => a.axis === axis)
  expect(found).toBeDefined()
  return found!
}

describe('analyzeIsCoupon render recovery', () => {
  it(
    'recovers both axes from a mirrored 0/90 degree scan pair: frequency within 1.5 Hz (2%), damping within 0.02',
    async () => {
      const truth = {
        x: { frequencyHz: 62, dampingRatio: 0.08, ringAmpMm: 0.25 },
        y: { frequencyHz: 75, dampingRatio: 0.05, ringAmpMm: 0.25 },
      }
      const r = await analyzePair(
        baseSpec,
        // Scan A carries realistic transport waviness; it lands on the traced lateral axis as
        // near-DC drift and must be removed by the detrend.
        { truth, quarterTurns: 0, flipped: true, wavinessAmpMm: 0.08, wavinessPeriodMm: 40 },
        { truth, quarterTurns: 1, flipped: true },
      )
      expect(r.aligned).toBe(true)
      expect(r.scans).toHaveLength(2)
      expect(r.scans[0].flipped).toBe(true)
      expect(r.scans[1].flipped).toBe(true)

      const y = axisOf(r, 'y')
      expect(y.refusals).toEqual([])
      expect(y.accepted).toBe(true)
      expect(y.scanIndex).toBe(0)
      expect(Math.abs(y.frequencyHz! - 75)).toBeLessThanOrEqual(1.5)
      expect(Math.abs(y.dampingRatio! - 0.05)).toBeLessThanOrEqual(0.02)
      expect(y.linesUsed).toBeGreaterThanOrEqual(3)

      // Per-line outcomes: one per geometry line, all with image-space endpoints, and the
      // accepted count agreeing with the pooled figure.
      expect(y.lines).toHaveLength(baseSpec.speedsMmS.length * baseSpec.linesPerSpeed)
      expect(y.lines.every((l) => l.traced && l.startPx !== null && l.endPx !== null)).toBe(true)
      expect(y.lines.filter((l) => l.accepted).length).toBe(y.linesUsed)
      expect(y.lines.map((l) => l.lineIndex)).toEqual(y.lines.map((_, i) => i))

      const x = axisOf(r, 'x')
      expect(x.accepted).toBe(true)
      expect(x.scanIndex).toBe(1)
      expect(Math.abs(x.frequencyHz! - 62)).toBeLessThanOrEqual(1.5)
      expect(Math.abs(x.dampingRatio! - 0.08)).toBeLessThanOrEqual(0.02)

      // Shaper table: five options, a recommendation within the band vibration tolerance.
      for (const axis of [x, y]) {
        expect(axis.shapers).toHaveLength(5)
        expect(axis.recommended).not.toBeNull()
        expect(axis.recommended!.bandResidualVibration).toBeLessThanOrEqual(0.05 + 1e-6)
        expect(axis.recommended!.maxAccelMmS2).toBeGreaterThan(0)
      }
    },
    240000,
  )

  it(
    'refuses a coupon that shows almost no ringing, with the amplitude reason (not a number)',
    async () => {
      const truth = { y: { frequencyHz: 75, dampingRatio: 0.05, ringAmpMm: 0.002, lobeAmpMm: 0 } }
      const r = await analyzePair(
        ySpec,
        { truth, quarterTurns: 0, flipped: true, noiseSigma: 3 },
        { truth, quarterTurns: 1, flipped: true, noiseSigma: 3 },
      )
      expect(r.aligned).toBe(true)
      const y = axisOf(r, 'y')
      expect(y.accepted).toBe(false)
      expect(y.frequencyHz).toBeNull()
      expect(y.refusals.some((m) => m.includes('below the detection threshold'))).toBe(true)

      // Every line is reported individually: none accepted, each with its own reason and an
      // image-space position the overlay can point at.
      expect(y.lines).toHaveLength(ySpec.speedsMmS.length * ySpec.linesPerSpeed)
      expect(y.lines.every((l) => !l.accepted && l.refusalReason !== null)).toBe(true)
      expect(y.lines.every((l) => l.startPx !== null && l.endPx !== null)).toBe(true)
    },
    240000,
  )

  it(
    'refuses when the lines disagree on the frequency (replicate scatter)',
    async () => {
      const truth = {
        y: { frequencyHz: 75, dampingRatio: 0.05, ringAmpMm: 0.25, frequencySpreadHz: 30 },
      }
      const r = await analyzePair(
        ySpec,
        { truth, quarterTurns: 0, flipped: true },
        { truth, quarterTurns: 1, flipped: true },
      )
      expect(r.aligned).toBe(true)
      const y = axisOf(r, 'y')
      expect(y.accepted).toBe(false)
      expect(y.frequencyHz).toBeNull()
      expect(y.refusals.some((m) => m.includes('disagree on the ringing frequency'))).toBe(true)
    },
    240000,
  )

  it(
    'refuses a resonance just outside the search range (fit at the bound)',
    async () => {
      const truth = { y: { frequencyHz: 152, dampingRatio: 0.05, ringAmpMm: 0.2 } }
      const r = await analyzePair(
        ySpec,
        { truth, quarterTurns: 0, flipped: true },
        { truth, quarterTurns: 1, flipped: true },
      )
      expect(r.aligned).toBe(true)
      const y = axisOf(r, 'y')
      expect(y.accepted).toBe(false)
      expect(y.frequencyHz).toBeNull()
      expect(y.refusals.some((m) => m.includes('search range'))).toBe(true)
    },
    240000,
  )

  it(
    'does not let the unused axis of a per-axis (CCD) reference leak into the frequency',
    async () => {
      // The traced lines run along the image's horizontal (sensor-row) axis, so the ring
      // wavelength must convert through the horizontal figure alone; the vertical figure here
      // is deliberately far off and must not affect the recovered frequency.
      const truth = { y: { frequencyHz: 75, dampingRatio: 0.05, ringAmpMm: 0.25 } }
      const r = await analyzePair(
        ySpec,
        { truth, quarterTurns: 0, flipped: true },
        { truth, quarterTurns: 1, flipped: true },
        { horizontal: PX_PER_MM, vertical: PX_PER_MM * 2 },
      )
      expect(r.aligned).toBe(true)
      const y = axisOf(r, 'y')
      expect(y.accepted).toBe(true)
      expect(y.scanIndex).toBe(0)
      expect(Math.abs(y.frequencyHz! - 75)).toBeLessThanOrEqual(1.5)
    },
    240000,
  )

  it(
    'refuses two speed tiers that disagree on the frequency (speed-invariance check)',
    async () => {
      const twoTier: IsTestSpec = { ...baseSpec, axes: ['y'], speedsMmS: [150, 100], linesPerSpeed: 3 }
      const truth = {
        y: { frequencyHz: 75, dampingRatio: 0.05, ringAmpMm: 0.25, frequencyByTierHz: [75, 55] },
      }
      const r = await analyzePair(
        twoTier,
        { truth, quarterTurns: 0, flipped: true },
        { truth, quarterTurns: 1, flipped: true },
      )
      expect(r.aligned).toBe(true)
      const y = axisOf(r, 'y')
      expect(y.accepted).toBe(false)
      expect(y.refusals.some((m) => m.includes('speed tiers disagree'))).toBe(true)
    },
    240000,
  )

  it(
    'accepts two agreeing speed tiers and recovers their shared frequency',
    async () => {
      const twoTier: IsTestSpec = { ...baseSpec, axes: ['y'], speedsMmS: [150, 100], linesPerSpeed: 3 }
      const truth = { y: { frequencyHz: 75, dampingRatio: 0.05, ringAmpMm: 0.25 } }
      const r = await analyzePair(
        twoTier,
        { truth, quarterTurns: 0, flipped: true },
        { truth, quarterTurns: 1, flipped: true },
      )
      expect(r.aligned).toBe(true)
      const y = axisOf(r, 'y')
      expect(y.refusals).toEqual([])
      expect(y.accepted).toBe(true)
      expect(Math.abs(y.frequencyHz! - 75)).toBeLessThanOrEqual(1.5)
    },
    240000,
  )

  it(
    'is order-independent: the swapped scan pair measures the axis from the other scan',
    async () => {
      // The UI passes the two files in pick order; each axis group must be assigned to
      // whichever scan reads it along the sensor rows, regardless of argument order.
      const truth = { y: { frequencyHz: 75, dampingRatio: 0.05, ringAmpMm: 0.25 } }
      const r = await analyzePair(
        ySpec,
        { truth, quarterTurns: 1, flipped: true },
        { truth, quarterTurns: 0, flipped: true },
      )
      expect(r.aligned).toBe(true)
      const y = axisOf(r, 'y')
      expect(y.accepted).toBe(true)
      expect(y.scanIndex).toBe(1)
      expect(Math.abs(y.frequencyHz! - 75)).toBeLessThanOrEqual(1.5)
    },
    240000,
  )

  it(
    'refuses an unmirrored scan as the coupon bed side',
    async () => {
      const truth = {
        y: { frequencyHz: 75, dampingRatio: 0.05, ringAmpMm: 0.25 },
      }
      const r = await analyzePair(
        ySpec,
        { truth, quarterTurns: 0, flipped: false },
        { truth, quarterTurns: 1, flipped: true },
      )
      expect(r.aligned).toBe(false)
      expect(r.failureReason).toContain('bed side')
      expect(r.scans[0].flipped).toBe(false)
      expect(r.axes).toEqual([])
    },
    240000,
  )

  it(
    'refuses a coupon printed with a different lines-per-speed than the configured spec',
    async () => {
      // The coupon is rendered at five lines per speed but analyzed with the eight-line
      // default. The plate and its fiducials are found and an orientation solves, but the
      // printed lines do not sit where the configured geometry expects, so the aligner must
      // refuse pointing at the configured test settings rather than reporting no coupon.
      const printedSpec: IsTestSpec = { ...ySpec, linesPerSpeed: 5 }
      const configuredSpec: IsTestSpec = { ...ySpec, linesPerSpeed: 8 }
      const truth = { y: { frequencyHz: 75, dampingRatio: 0.05, ringAmpMm: 0.25 } }
      const cv = await getCv()
      const a = rgbaToBgrMat(cv, renderIsScan({ spec: printedSpec, truth, quarterTurns: 0, flipped: true }))
      const b = rgbaToBgrMat(cv, renderIsScan({ spec: printedSpec, truth, quarterTurns: 1, flipped: true }))
      try {
        const r = analyzeIsCoupon(cv, a, b, configuredSpec, PX_PER_MM)
        expect(r.aligned).toBe(false)
        expect(r.failureReason).toContain('configured test settings')
        expect(r.failureReason).toContain('lines per speed')
        // The per-scan diagnostics must not contradict the failure reason: the plate and its
        // fiducial holes WERE found, only the content verification refused the scan.
        expect(r.scans).toHaveLength(1)
        expect(r.scans[0].fiducialsFound).toBe(true)
        expect(r.scans[0].orientationSolved).toBe(true)
        expect(r.axes).toEqual([])
      } finally {
        a.delete()
        b.delete()
      }
    },
    240000,
  )

  it(
    'refuses a scan below the 150 dpi floor with a resolution reason',
    async () => {
      const truth = { y: { frequencyHz: 75, dampingRatio: 0.05, ringAmpMm: 0.25 } }
      const r = await analyzePair(
        ySpec,
        { truth, quarterTurns: 0, flipped: true, pxPerMm: 5 },
        { truth, quarterTurns: 1, flipped: true, pxPerMm: 5 },
        5,
      )
      expect(r.aligned).toBe(false)
      expect(r.failureReason).toContain('Scan 1')
      expect(r.failureReason).toContain('dpi')
      expect(r.failureReason).toContain('150')
      // The resolution set check runs after both scans align, so both carry diagnostics.
      expect(r.scans).toHaveLength(2)
      expect(r.axes).toEqual([])
    },
    240000,
  )

  it(
    'refuses a pair whose second scan mismatches the expected calibration resolution',
    async () => {
      const truth = { y: { frequencyHz: 75, dampingRatio: 0.05, ringAmpMm: 0.25 } }
      const cv = await getCv()
      const a = rgbaToBgrMat(
        cv,
        renderIsScan({ pxPerMm: PX_PER_MM, spec: ySpec, truth, quarterTurns: 0, flipped: true }),
      )
      const b = rgbaToBgrMat(
        cv,
        renderIsScan({ pxPerMm: PX_PER_MM / 2, spec: ySpec, truth, quarterTurns: 1, flipped: true }),
      )
      try {
        const expectedDpi = Math.round(PX_PER_MM * 25.4)
        const r = analyzeIsCoupon(cv, a, b, ySpec, PX_PER_MM, expectedDpi)
        expect(r.aligned).toBe(false)
        expect(r.failureReason).toContain('Scan 2')
        expect(r.failureReason).toContain('expected resolution')
        expect(r.scans).toHaveLength(2)
        expect(r.scans[1].measuredPxPerMm).not.toBeNull()
        expect(r.axes).toEqual([])
      } finally {
        a.delete()
        b.delete()
      }
    },
    240000,
  )

  it('reports a failed alignment with a reason on a blank image', async () => {
    const cv = await getCv()
    const width = 400
    const height = 300
    const data = new Uint8ClampedArray(width * height * 4)
    data.fill(200)
    const blankA = rgbaToBgrMat(cv, { data, width, height })
    const blankB = rgbaToBgrMat(cv, { data: data.slice(), width, height })
    try {
      const r = analyzeIsCoupon(cv, blankA, blankB, ySpec, PX_PER_MM)
      expect(r.aligned).toBe(false)
      expect(r.failureReason).toBeTruthy()
      expect(r.scans).toHaveLength(1)
      expect(r.scans[0].fiducialsFound).toBe(false)
      expect(r.scans[0].orientationSolved).toBe(false)
      expect(r.axes).toEqual([])
    } finally {
      blankA.delete()
      blankB.delete()
    }
  })
})
