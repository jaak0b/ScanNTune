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

const PX_PER_MM = 12
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
  const a = rgbaToBgrMat(cv, renderIsScan({ spec, ...optionsA }))
  const b = rgbaToBgrMat(cv, renderIsScan({ spec, ...optionsB }))
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
      expect(r.axes).toEqual([])
    } finally {
      blankA.delete()
      blankB.delete()
    }
  })
})
