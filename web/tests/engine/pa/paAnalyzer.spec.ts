// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getCv } from '../../helpers/cv'
import { renderPaScan } from '../../helpers/paRender'
import { rgbaToBgrMat } from '../../../src/engine/imageData'
import { analyzePaCoupon, parabolicMinimum, scoreLine } from '../../../src/engine/pa/paAnalyzer'
import { defaultPaTestSpec } from '../../../src/engine/pa/types'
import type { PaProgress } from '../../../src/engine/pa/types'
import type { WidthSample } from '../../../src/engine/pa/lineMeasurer'

describe('scoreLine', () => {
  const transitions: [number, number] = [20, 60]

  const flat = (width: number): WidthSample[] => {
    const s: WidthSample[] = []
    for (let x = 2; x <= 78; x += 0.25) s.push({ xMm: x, widthMm: width })
    return s
  }

  it('scores a perfectly uniform line at zero', () => {
    const { score, medianWidthMm } = scoreLine(flat(0.45), transitions, 0.45)
    expect(score).toBeCloseTo(0, 9)
    expect(medianWidthMm).toBeCloseTo(0.45, 9)
  })

  it('scores a bulge at a transition higher than a uniform line', () => {
    const samples = flat(0.45).map((s) =>
      Math.abs(s.xMm - transitions[1]) < 1 ? { ...s, widthMm: 0.9 } : s,
    )
    const { score } = scoreLine(samples, transitions, 0.45)
    expect(score).toBeGreaterThan(0.05)
  })

  it('treats a NaN gap inside a window as a full nominal-width deviation', () => {
    const samples = flat(0.45).map((s) =>
      Math.abs(s.xMm - transitions[0]) < 1 ? { ...s, widthMm: NaN } : s,
    )
    const { score } = scoreLine(samples, transitions, 0.45)
    expect(score).toBeGreaterThan(0.05)
  })
})

describe('parabolicMinimum', () => {
  it('finds the vertex of an exact parabola', () => {
    const f = (x: number) => 3 * (x - 0.031) ** 2 + 1
    expect(parabolicMinimum(0.02, f(0.02), 0.03, f(0.03), 0.04, f(0.04))).toBeCloseTo(0.031, 6)
  })
  it('clamps outside the bracket', () => {
    expect(parabolicMinimum(0.02, 1, 0.03, 2, 0.04, 3)).toBeGreaterThanOrEqual(0.02)
  })
  it('returns the middle point when the points are collinear (no curvature)', () => {
    expect(parabolicMinimum(0.02, 1, 0.03, 1, 0.04, 1)).toBe(0.03)
  })
  it('returns the middle point on a degenerate x spacing', () => {
    expect(parabolicMinimum(0.03, 1, 0.03, 2, 0.03, 3)).toBe(0.03)
  })
  it('returns the middle point when the parabola opens downward', () => {
    expect(parabolicMinimum(0.02, 1, 0.03, 3, 0.04, 1)).toBe(0.03)
  })
})

describe('analyzePaCoupon', () => {
  const spec = defaultPaTestSpec()
  // The analyzer refuses scans below the measurement resolution floor, so the synthetic scans
  // are rendered at the 600 dpi class resolution a real scan is expected to have.
  const PX_PER_MM = 24

  it.each([
    [0.012, 0, false],
    [0.03, 0, false],
    [0.048, 0, false],
    [0.03, 90, false],
    [0.03, 7, true],
  ])('recovers truePa %f at rotation %d flipped %s', async (truePa, rot, flip) => {
    const cv = await getCv()
    const bgr = rgbaToBgrMat(
      cv,
      renderPaScan({
        truePa: truePa as number,
        rotationDegrees: rot as number,
        flipped: flip as boolean,
        pxPerMm: PX_PER_MM,
      }),
    )
    try {
      const r = analyzePaCoupon(cv, bgr, spec)
      expect(r.success).toBe(true)
      // One PA step of the default sweep is 0.004; require within one step.
      expect(Math.abs((r.bestPa as number) - (truePa as number))).toBeLessThan(0.004)
      expect(r.lines).toHaveLength(spec.lineCount)
    } finally {
      bgr.delete()
    }
  }, 180000)

  it.each([
    [0.03, 0, false],
    [0.03, 7, true],
  ])(
    'recovers truePa %f at rotation %d flipped %s with light lines on a dark base',
    async (truePa, rot, flip) => {
      const cv = await getCv()
      const bgr = rgbaToBgrMat(
        cv,
        renderPaScan({
          truePa: truePa as number,
          rotationDegrees: rot as number,
          flipped: flip as boolean,
          baseGray: 40,
          lineGray: 220,
          backgroundGray: 245,
          pxPerMm: PX_PER_MM,
        }),
      )
      try {
        const r = analyzePaCoupon(cv, bgr, spec)
        expect(r.success).toBe(true)
        expect(Math.abs((r.bestPa as number) - (truePa as number))).toBeLessThan(0.004)
        expect(r.lines).toHaveLength(spec.lineCount)
      } finally {
        bgr.delete()
      }
    },
    180000,
  )

  // Regression for the glossy-scan failure the bounded half-amplitude edge finder fixed: scanner
  // blur softens the line edges while sharp specular infill ridges put a stronger gradient on the
  // base, which captured the old global-argmax edge finder (truth 0.036 was its worst case).
  it.each([[0.012], [0.036], [0.048]])(
    'recovers truePa %f on a glossy textured base under scanner blur',
    async (truePa) => {
      const cv = await getCv()
      const bgr = rgbaToBgrMat(
        cv,
        renderPaScan({
          truePa,
          pxPerMm: PX_PER_MM,
          blurSigmaPx: 1.5,
          textureAmpGray: 90,
          ridgeExponent: 20,
          texturePitchMm: 0.7,
        }),
      )
      try {
        const r = analyzePaCoupon(cv, bgr, spec)
        expect(r.success).toBe(true)
        expect(Math.abs((r.bestPa as number) - truePa)).toBeLessThan(0.004)
      } finally {
        bgr.delete()
      }
    },
    180000,
  )

  it('reports above-range with the sweep-top value when the truth lies above the sweep', async () => {
    const cv = await getCv()
    const bgr = rgbaToBgrMat(cv, renderPaScan({ truePa: 0.08, pxPerMm: PX_PER_MM }))
    try {
      const r = analyzePaCoupon(cv, bgr, spec)
      expect(r.success).toBe(true)
      expect(r.sweepBracket).toBe('above-range')
      expect(r.bestLineIndex).toBe(spec.lineCount - 1)
      expect(r.bestPa).toBeCloseTo(spec.paEnd, 6)
      expect(r.sePa).toBeNull()
    } finally {
      bgr.delete()
    }
  }, 180000)

  it('reports below-range with the sweep-bottom value when the truth lies below the sweep', async () => {
    const cv = await getCv()
    const bgr = rgbaToBgrMat(cv, renderPaScan({ truePa: -0.02, pxPerMm: PX_PER_MM }))
    try {
      const r = analyzePaCoupon(cv, bgr, spec)
      expect(r.success).toBe(true)
      expect(r.sweepBracket).toBe('below-range')
      expect(r.bestLineIndex).toBe(0)
      expect(r.bestPa).toBeCloseTo(spec.paStart, 6)
      expect(r.sePa).toBeNull()
    } finally {
      bgr.delete()
    }
  }, 180000)

  it('reports bracketed with a finite positive sePa for a mid-range truth', async () => {
    const cv = await getCv()
    const bgr = rgbaToBgrMat(cv, renderPaScan({ truePa: 0.03, pxPerMm: PX_PER_MM }))
    try {
      const r = analyzePaCoupon(cv, bgr, spec)
      expect(r.success).toBe(true)
      expect(r.sweepBracket).toBe('bracketed')
      expect(r.sePa).not.toBeNull()
      expect(r.sePa!).toBeGreaterThan(0)
      expect(Number.isFinite(r.sePa!)).toBe(true)
    } finally {
      bgr.delete()
    }
  }, 180000)

  it('reports the same sePa on repeated analyses of the same scan', async () => {
    const cv = await getCv()
    const first = rgbaToBgrMat(cv, renderPaScan({ truePa: 0.03, pxPerMm: 12 }))
    const second = rgbaToBgrMat(cv, renderPaScan({ truePa: 0.03, pxPerMm: 12 }))
    try {
      const a = analyzePaCoupon(cv, first, spec)
      const b = analyzePaCoupon(cv, second, spec)
      expect(a.sePa).not.toBeNull()
      expect(b.sePa).toBe(a.sePa)
    } finally {
      first.delete()
      second.delete()
    }
  }, 180000)

  it('reports a larger sePa on a noisier scan of the same truth', async () => {
    const cv = await getCv()
    const quiet = rgbaToBgrMat(cv, renderPaScan({ truePa: 0.03, pxPerMm: 12, noiseSigma: 2 }))
    const noisy = rgbaToBgrMat(cv, renderPaScan({ truePa: 0.03, pxPerMm: 12, noiseSigma: 8 }))
    try {
      const rq = analyzePaCoupon(cv, quiet, spec)
      const rn = analyzePaCoupon(cv, noisy, spec)
      expect(rq.sePa).not.toBeNull()
      expect(rn.sePa).not.toBeNull()
      expect(rn.sePa!).toBeGreaterThan(rq.sePa!)
    } finally {
      quiet.delete()
      noisy.delete()
    }
  }, 180000)

  it('covers the truth within bestPa +/- 1.96 sePa about 95 percent of the time', async () => {
    const cv = await getCv()
    const runs = 40
    let covered = 0
    for (let seed = 1; seed <= runs; seed++) {
      const bgr = rgbaToBgrMat(cv, renderPaScan({ truePa: 0.03, pxPerMm: 12, seed }))
      try {
        const r = analyzePaCoupon(cv, bgr, spec)
        expect(r.success).toBe(true)
        expect(r.sePa).not.toBeNull()
        if (Math.abs((r.bestPa as number) - 0.03) <= 1.96 * r.sePa!) covered++
      } finally {
        bgr.delete()
      }
    }
    // Binomial(40, 0.95) has mean 38 and sigma about 1.4; 34 is roughly 3 sigma below, so a real
    // coverage failure trips it while sampling luck does not. (Capture run observed 39 of 40.)
    expect(covered).toBeGreaterThanOrEqual(34)
  }, 600000)

  it('fails with a contrast reason when lines match the base brightness', async () => {
    const cv = await getCv()
    const bgr = rgbaToBgrMat(
      cv,
      renderPaScan({
        truePa: 0.03,
        baseGray: 120,
        lineGray: 135,
        backgroundGray: 245,
        pxPerMm: PX_PER_MM,
      }),
    )
    try {
      const r = analyzePaCoupon(cv, bgr, spec)
      expect(r.success).toBe(false)
      expect(r.failureReason).toContain('too similar in brightness')
      expect(r.bestPa).toBeNull()
    } finally {
      bgr.delete()
    }
  }, 120000)

  it('fails with a resolution reason on a scan below the 150 dpi floor', async () => {
    const cv = await getCv()
    const bgr = rgbaToBgrMat(cv, renderPaScan({ truePa: 0.03, pxPerMm: 5 }))
    try {
      const r = analyzePaCoupon(cv, bgr, spec)
      expect(r.success).toBe(false)
      expect(r.failureReason).toContain('dpi')
      expect(r.failureReason).toContain('150')
      expect(r.bestPa).toBeNull()
    } finally {
      bgr.delete()
    }
  }, 120000)

  it('returns a failure result on a blank image', async () => {
    const cv = await getCv()
    const blank = new cv.Mat(400, 400, cv.CV_8UC3, new cv.Scalar(128, 128, 128, 255))
    try {
      const r = analyzePaCoupon(cv, blank, spec)
      expect(r.success).toBe(false)
      expect(r.failureReason).toBeTruthy()
      expect(r.bestPa).toBeNull()
    } finally {
      blank.delete()
    }
  }, 60000)

  it('emits progress events: align, one measure per line in order, then score', async () => {
    const cv = await getCv()
    const bgr = rgbaToBgrMat(cv, renderPaScan({ truePa: 0.03, pxPerMm: PX_PER_MM }))
    const events: PaProgress[] = []
    try {
      const r = analyzePaCoupon(cv, bgr, spec, undefined, (p) => events.push(p))
      expect(r.success).toBe(true)
      expect(events[0]).toEqual({ stage: 'align' })
      const measures = events.filter((e) => e.stage === 'measure')
      expect(measures).toHaveLength(spec.lineCount)
      measures.forEach((e, i) => {
        expect(e.line).toBe(i)
        expect(e.lineCount).toBe(spec.lineCount)
      })
      expect(events[events.length - 1]).toEqual({ stage: 'score' })
    } finally {
      bgr.delete()
    }
  }, 120000)
})
