// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getCv } from '../../helpers/cv'
import { renderIsScan } from '../../helpers/isRender'
import type { IsRenderOptions } from '../../helpers/isRender'
import { rgbaToBgrMat } from '../../../src/engine/imageData'
import { analyzeIsCoupon, ladderAdvice } from '../../../src/engine/is/isAnalyzer'
import type { IsLineOutcome } from '../../../src/engine/is/resultTypes'
import type { IsResult, IsAxisResult } from '../../../src/engine/is/resultTypes'
import { defaultIsTestRequest, fitSpecToPrinter } from '../../../src/engine/is/types'
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
const profile = defaultPrinterProfile()
// The fitted default coupon: tiers 106 / 150 mm/s interleaved, five lines per speed.
const baseSpec = fitSpecToPrinter(defaultIsTestRequest(profile), profile).spec
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
    'measures both axes in the field regime: faint 0.05 mm class ringing under scan noise',
    async () => {
      // The regime real stiff printers produce: ring amplitudes a few hundredths of a
      // millimetre, individually near the per-line detection threshold, recovered by the
      // joint fit across the lines.
      const truth = {
        x: { frequencyHz: 58, dampingRatio: 0.06, ringAmpMm: 0.05 },
        y: { frequencyHz: 47, dampingRatio: 0.08, ringAmpMm: 0.06 },
      }
      const r = await analyzePair(
        baseSpec,
        { truth, quarterTurns: 0, flipped: true, noiseSigma: 2 },
        { truth, quarterTurns: 1, flipped: true, noiseSigma: 2 },
      )
      expect(r.aligned).toBe(true)
      const y = axisOf(r, 'y')
      expect(y.refusals).toEqual([])
      expect(y.accepted).toBe(true)
      expect(Math.abs(y.frequencyHz! - 47)).toBeLessThanOrEqual(1.5)
      expect(y.frequencySeHz).not.toBeNull()
      expect(y.lines.filter((l) => l.usedInJointFit).length).toBeGreaterThanOrEqual(3)
      const x = axisOf(r, 'x')
      expect(x.refusals).toEqual([])
      expect(x.accepted).toBe(true)
      expect(Math.abs(x.frequencyHz! - 58)).toBeLessThanOrEqual(1.5)
    },
    240000,
  )

  it(
    'measures an axis whose lower ladder rungs ring near the noise floor (self-ranging)',
    async () => {
      // The corner-speed ladder scales the rendered ring amplitude with each line's rung
      // (delta-v over omega), so the slowest rungs carry only a fifth of the top rung's
      // amplitude; the joint fit must still measure the axis from the pooled lines.
      const truth = { y: { frequencyHz: 62, dampingRatio: 0.07, ringAmpMm: 0.1 } }
      const r = await analyzePair(
        ySpec,
        { truth, quarterTurns: 0, flipped: true, noiseSigma: 3 },
        { truth, quarterTurns: 1, flipped: true, noiseSigma: 3 },
      )
      expect(r.aligned).toBe(true)
      const y = axisOf(r, 'y')
      expect(y.refusals).toEqual([])
      expect(y.accepted).toBe(true)
      expect(Math.abs(y.frequencyHz! - 62)).toBeLessThanOrEqual(1.5)
      // Per-rung status: every line carries its rung, bottom 20 mm/s to top 100 mm/s, the two
      // tiers interleaved rung by rung (hand-derived rungs 20 * 5^(j/4)), and the fitted
      // amplitudes grow with the rung (top at least twice the bottom).
      const rungs = [20, 20, 29.90698, 29.90698, 44.72136, 44.72136, 66.87403, 66.87403, 100, 100]
      y.lines.forEach((l, i) => expect(l.cornerSpeedMmS).toBeCloseTo(rungs[i], 4))
      const bottom = y.lines[0]
      const top = y.lines[y.lines.length - 1]
      // The faint bottom rung is not discarded: the joint fit reads it alongside the top rung,
      // and both carry a joint-fit amplitude.
      expect(bottom.usedInJointFit).toBe(true)
      expect(top.usedInJointFit).toBe(true)
      expect(bottom.amplitudeMm).not.toBeNull()
      expect(top.amplitudeMm).not.toBeNull()
      // The rendered amplitudes stand 5 to 1 (100 over 20 mm/s); under the 3-level scan noise
      // the fitted ratio must keep at least 2 of it.
      expect(top.amplitudeMm!).toBeGreaterThan(2 * bottom.amplitudeMm!)
    },
    240000,
  )

  it(
    'refuses a coupon that shows no ringing, through the joint-fit significance test',
    async () => {
      // The joint fit pools the coherent sub-pixel signal of every line, so any rendered
      // ring amplitude above the resolvability floor is legitimately measurable in a
      // synthetic scan (the old per-line amplitude gate refused 0.002 mm; the joint fit
      // reads it). The refusal contract is therefore pinned at the true null: no ring at
      // all, only noise and the renderer's own sub-pixel artifacts.
      const truth = { y: { frequencyHz: 75, dampingRatio: 0.05, ringAmpMm: 0, lobeAmpMm: 0 } }
      const r = await analyzePair(
        ySpec,
        { truth, quarterTurns: 0, flipped: true, noiseSigma: 3 },
        { truth, quarterTurns: 1, flipped: true, noiseSigma: 3 },
      )
      expect(r.aligned).toBe(true)
      const y = axisOf(r, 'y')
      expect(y.accepted).toBe(false)
      expect(y.frequencyHz).toBeNull()
      // The refusal comes from the joint verdict: either no statistically significant
      // shared ringing, or a significant component below the scan's resolvability floor
      // (a sub-pixel sampling artifact); both mean there is no printable ringing.
      expect(
        y.refusals.some(
          (m) => m.includes('statistically significant') || m.includes('smaller than the scan can resolve'),
        ),
      ).toBe(true)

      // Every line is reported individually with an image-space position the overlay can
      // point at, and none is accepted. A line carries a refusal exactly when it was left out
      // of the joint fit: a line in it was measured through the joint fit, so the alert's
      // refusal counts and the table's joint-fit column cannot disagree. Lines without
      // ringing read as weak on their own, and weak lines enter the joint fit, so most lines
      // are in it and carry no refusal.
      expect(y.lines).toHaveLength(ySpec.speedsMmS.length * ySpec.linesPerSpeed)
      expect(y.lines.every((l) => !l.accepted)).toBe(true)
      expect(y.lines.every((l) => (l.refusalCategory === null) === l.usedInJointFit)).toBe(true)
      expect(y.lines.every((l) => (l.refusalReason === null) === l.usedInJointFit)).toBe(true)
      expect(y.lines.filter((l) => l.usedInJointFit).length * 2).toBeGreaterThan(y.lines.length)
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
      expect(y.refusals.some((m) => m.includes('outside the measurable range'))).toBe(true)
      expect(y.lines.some((l) => l.refusalCategory === 'out-of-band')).toBe(true)
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
    'times the ring by the commanded distance: a 0.5% shrunk coupon reads within 0.1% of the truth',
    async () => {
      // The printed coupon (fiducials, lines and rings) is 0.5% smaller than commanded, and the
      // card calibration reads true millimetres. The ring was printed at the commanded speed
      // over the commanded distance, so the time base must come from the affine-mapped
      // coupon-frame distance; converting the arc length through the card instead read this
      // render 0.52% high (75.39 Hz).
      const truth = { y: { frequencyHz: 75, dampingRatio: 0.05, ringAmpMm: 0.25 } }
      const r = await analyzePair(
        ySpec,
        { truth, quarterTurns: 0, flipped: true, shrink: 0.005 },
        { truth, quarterTurns: 1, flipped: true, shrink: 0.005 },
      )
      expect(r.aligned).toBe(true)
      const y = axisOf(r, 'y')
      expect(y.accepted).toBe(true)
      expect(Math.abs(y.frequencyHz! - 75)).toBeLessThanOrEqual(0.075)
    },
    240000,
  )

  it(
    'starts the Marlin fit after the post-corner ramp, so an S-curve ramp leaves the frequency unbiased',
    async () => {
      // Marlin's S_CURVE_ACCELERATION ramp (quintic Bezier, same duration and distance as the
      // trapezoid) cannot be detected, so the Marlin spec starts every fit at the ramp end. With
      // the window from the corner instead, this render read 0.8% low (74.41 Hz).
      const marlin = { ...profile, firmware: 'Marlin' as const }
      const marlinSpec: IsTestSpec = {
        ...fitSpecToPrinter(defaultIsTestRequest(marlin), marlin).spec,
        axes: ['y'],
      }
      expect(marlinSpec.exactRampTiming).toBe(false)
      const truth = { y: { frequencyHz: 75, dampingRatio: 0.05, ringAmpMm: 0.25 } }
      const r = await analyzePair(
        marlinSpec,
        { truth, quarterTurns: 0, flipped: true, rampProfile: 'sCurve' },
        { truth, quarterTurns: 1, flipped: true, rampProfile: 'sCurve' },
      )
      expect(r.aligned).toBe(true)
      const y = axisOf(r, 'y')
      expect(y.accepted).toBe(true)
      expect(Math.abs(y.frequencyHz! - 75)).toBeLessThanOrEqual(0.075)
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
    'refuses a two-axis scan pair whose orientations differ by a half turn',
    async () => {
      // A 0/180 degree pair keeps both line groups on the same scanner axis, so one axis is
      // unmeasurable in either scan; the pair is refused as a scanning mistake before any
      // tracing, instead of surfacing later as a confusing per-axis refusal.
      const truth = {
        x: { frequencyHz: 62, dampingRatio: 0.08, ringAmpMm: 0.25 },
        y: { frequencyHz: 75, dampingRatio: 0.05, ringAmpMm: 0.25 },
      }
      const r = await analyzePair(
        baseSpec,
        { truth, quarterTurns: 0, flipped: true },
        { truth, quarterTurns: 2, flipped: true },
      )
      expect(r.aligned).toBe(false)
      expect(r.failureReason).toContain('quarter turn')
      expect(r.scans).toHaveLength(2)
      expect(r.axes).toEqual([])
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

  it('advises raising the corner speed only when the resolvable lines split along the ladder', () => {
    const outcome = (cornerSpeedMmS: number, amplitudeMm: number | null): IsLineOutcome => ({
      lineIndex: 0,
      axis: 'y',
      speedMmS: 150,
      cornerSpeedMmS,
      traced: true,
      accepted: false,
      usedInJointFit: true,
      exclusion: null,
      refusalReason: null,
      refusalCategory: null,
      frequencyHz: null,
      amplitudeMm,
      startPx: null,
      endPx: null,
    })
    const floor = 0.002
    // Clean split: every resolvable amplitude sits on a faster rung than every
    // unresolvable one, so the advice fires. The 100 mm/s corner sits below the 150 mm/s
    // line speed, so the line speed only has to rise once the corner passes it.
    const split = [outcome(20, 0.001), outcome(45, 0.0015), outcome(70, 0.003), outcome(100, 0.006)]
    expect(ladderAdvice(ySpec, split, floor)).toBe(
      'Raise the corner speed and reprint. If the new corner speed exceeds the 150 mm/s line ' +
        'speed, raise the line speed to at least the corner speed. Only the lines with the ' +
        'fastest corner speeds carried ringing the scan can resolve.',
    )
    // A corner speed already at the line speed can only rise with it.
    expect(ladderAdvice({ ...ySpec, speedsMmS: [100] }, split, floor)).toBe(
      'Raise the corner speed and the line speed together, then reprint. The line speed must ' +
        'stay at least as fast as the corner speed. Only the lines with the fastest corner ' +
        'speeds carried ringing the scan can resolve.',
    )
    // No split (a slow rung resolved): no advice.
    const mixed = [outcome(20, 0.003), outcome(45, 0.001), outcome(70, 0.003), outcome(100, 0.006)]
    expect(ladderAdvice(ySpec, mixed, floor)).toBeNull()
  })

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
