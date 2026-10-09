import type { IsAxis, IsTestSpec } from '../../src/engine/is/types'
import { isCouponGeometry } from '../../src/engine/is/couponGeometry'
import type { TracedLine } from '../../src/engine/is/lineTracer'

// Synthetic ground-truth generator for the input shaper ANALYZER: it produces the traced lines of
// one axis group directly (no imaging), so the statistical calibration of the analysis can run
// thousands of fixed-seed replicates. The layout (tiers, ladder rungs, field offsets, print order)
// is the fitted coupon's own geometry; everything the analyzer is meant to recover or reject is
// generated here from literal truth with formulas written independently of the production code:
//
// - Time base: samples sit on the tracer's lattice, one scan pixel apart along the line
//   (600 dpi by default), from 1 mm past the corner to the end of the clean read. The physical
//   time of a sample follows the commanded profile after the corner: the trapezoid (constant
//   acceleration from the corner speed to the tier speed, then cruise), which is also the traced
//   time base the analyzer receives, exactly as the tracer computes it.
// - Ring: the free response to the corner's velocity step, amplitude proportional to the line's
//   rung (the top printed rung carries ampMm), one phase for the whole axis (fixed by the corner).
// - Noise models (per traced sample, in scan pixels): iid; bilinear (iid pixel noise read by the
//   tracer's bilinear interpolation at the line's sub-pixel phase); Gaussian blur of 1 or 2 px
//   along the line, then the bilinear read; red AR(2) noise with its spectral peak inside the ring
//   band; per-line noise levels.
// - Artifacts: a belt-tooth pattern fixed in arc length (GT2, 2 mm pitch) printed on both tiers;
//   a forced tone fixed in hertz (fan imbalance) with a random phase per line and an amplitude
//   that does not depend on the rung; a JPEG 8 px block pattern fixed in scan pixels; pixel
//   locking of a line tilted against the pixel grid.
// - Mechanisms: the first-order flow lag of the commanded flow (run-up at the rung, corner, ramp
//   to the tier speed), entering the lateral trace as amplitude times (lagged flow / commanded
//   flow - 1); the forced corner overshoot lobe; samples the tracer could not read (gaps), filled
//   by linear interpolation exactly as the tracer fills them.
// - Stage 2 mechanisms: further machine modes next to the ring (a second in-band mode, a mode
//   above the band); the bead dragged at the corner, a lobe decaying in arc length
//   exp(-s / lambda); the ring of the slower pedestal layer the measured bead follows, fixed in arc
//   length at the pedestal's speed; scan noise inflated where the extruded flow lags the
//   commanded flow (the starved bead after the corner is rougher), by a factor 1 + k D(t) / max D
//   with D = 1 - q / v the flow deficit of the same first-order lag; isolated impulse outliers (dust, hairs, voids) on a fraction of samples;
//   the along-track time warp: the axis along the line rings after the corner too, driven by the
//   commanded along-line motion, the corner's velocity step c and then the ramp's constant
//   acceleration a up to the tier speed. The nozzle lags its commanded arc position by delta(t),
//   the superposition of the mode's step response over that motion: the corner term (by default
//   the free response from rest, (c / w_a) e^(-zeta_a w_a t) sin(w_d t)) plus a times the integral
//   of the unit step response over the ramp, in closed form (the antiderivative of
//   e^(alpha x) cos(beta x + phi)). The bead at arc position s is deposited at the time t that
//   solves s_cmd(t) - delta(t) = s exactly (bisection on the trapezoid), and every time-domain
//   mechanism is evaluated at that deposit time.
// - Lateral sign: the mechanisms are displacements along the run-up's direction of travel into
//   the corner; the tracer's lateral coordinate points that way (+1, the default) or against it
//   (-1), and the noise and the pixel locking act in the tracer's coordinate.

export const SIM_PX_PER_MM = 600 / 25.4

/** One sample step along the line in scan pixels: the tracer's step, the native pixel pitch. */
const ALONG_STEP_PX = 1
/** First traced sample past the corner, mm (the tracer's trace start). */
const TRACE_START_MM = 1

export type SimNoiseModel = 'iid' | 'bilinear' | 'blur1' | 'blur2' | 'redAr2'

export interface SimNoise {
  model: SimNoiseModel
  /** Standard deviation of the pixel-level (or, for iid and redAr2, sample-level) noise, px. */
  sigmaPx: number
  /** Per-line multiplier of sigmaPx, in group order; absent means 1 for every line. */
  perLineScale?: number[]
  /** redAr2: frequency of the spectral peak at the line's cruise speed, Hz. */
  peakHz?: number
  /** redAr2: pole radius (closer to 1 is a sharper peak). */
  poleRadius?: number
}

export interface SimRing {
  frequencyHz: number
  dampingRatio: number
  /** Ring amplitude at the corner on the TOP rung, mm; lower rungs scale with their rung. */
  ampMm: number
  phaseRad?: number
  /** Per-tier frequency override, indexed like spec.speedsMmS. */
  frequencyByTierHz?: number[]
  /** Linear change of the frequency with the line's field offset, Hz per mm (belt stiffness
   *  varying along the axis), about the group's mean offset. */
  frequencyGradientHzPerMm?: number
}

export interface SimArtifacts {
  /** Arc-length periodic pattern of a belt, identical on both tiers. */
  beltTooth?: { periodMm: number; ampMm: number }
  /** Hertz-fixed undamped tone, random phase per line, rung-independent amplitude. */
  forcedTone?: { frequencyHz: number; ampMm: number }
  /** Scan-pixel periodic block pattern. */
  jpegBlock?: { periodPx: number; ampMm: number }
  /** Peak locking of a line tilted against the pixel grid. */
  pixelLock?: { tiltDeg: number; ampPx: number }
}

/** A machine mode along the measured line's own axis (rings along the line after the corner). */
export interface SimAlongTrack {
  frequencyHz: number
  dampingRatio: number
  /** The mode's response to the corner's velocity step on the TOP rung, mm, lower rungs scaling
   *  with their rung, as ampMm e^(-zeta w t) cos(w_d t + phaseRad); the ramp's response follows
   *  from the same step response. Absent means the full free response to the velocity step,
   *  c_top / w_a, with phase -pi/2. A joint X/Y case passes the other group's `ring` here: the same
   *  axis answers the same step. */
  ampMm?: number
  phaseRad?: number
}

export interface TraceSimOptions {
  seed: number
  /** The fitted spec the coupon was printed with. */
  spec: IsTestSpec
  axis?: IsAxis
  pxPerMm?: number
  ring?: SimRing | null
  noise: SimNoise
  artifacts?: SimArtifacts
  /** First-order flow lag of the commanded flow. */
  flowLag?: { tauS: number; ampMm: number }
  /** Forced corner overshoot: ampMm on the top rung, scaling with the rung, decaying with tauS. */
  cornerLobe?: { ampMm: number; tauS: number }
  /** Further machine modes, each ringing like `ring` (another in-band mode, or one above the band). */
  extraModes?: SimRing[]
  /** Bead drag at the corner: ampMm on the top rung, scaling with the rung, decaying in arc length. */
  spatialLobe?: { ampMm: number; lambdaMm: number }
  /** The pedestal layer's ring, printed at speedMmS and followed by the measured bead: fixed in arc
   *  length, amplitude ampMm on every line (the pedestal's corners are all at its own speed). */
  pedestalRing?: { frequencyHz: number; dampingRatio: number; ampMm: number; speedMmS: number }
  /** Scan noise inflated by the flow deficit of a first-order lag tauS: the per-sample noise
   *  times 1 + factor D(t) / max D, D = 1 - lagged flow / commanded flow. */
  earlyNoise?: { factor: number; tauS: number }
  /** Impulse outliers on this fraction of the samples, each +/- ampMm times a uniform 0.5 to 1.5. */
  impulseOutliers?: { fraction: number; ampMm: number }
  /** The along-track mode whose ring warps the time at which the nozzle passes each position. */
  alongTrack?: SimAlongTrack
  /** +1 (default) when the traced lateral coordinate points along the run-up's direction of
   *  travel into the corner, -1 against it. */
  lateralTowardRunUp?: 1 | -1
  /** Unreadable samples: this fraction of the samples, in runs of 1 to maxRun samples. */
  gaps?: { fraction: number; maxRun: number }
  /** Lines to simulate, by group index; absent means every line of the group. */
  lineIndices?: number[]
}

export interface SimLine {
  trace: TracedLine
  speedMmS: number
  cornerSpeedMmS: number
  rungIndex: number
  /** Field offset perpendicular to the line, mm from the group's first slot. */
  offsetMm: number
  /** Position of the line in the layer's print order (0 first). */
  printRank: number
  /** Ground-truth mask of the samples the tracer read (true) or had to fill (false). */
  observed: boolean[]
}

/** mulberry32, the repo's seeded generator, local so the simulator has no production import. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function normal(rand: () => number): number {
  const u = Math.max(rand(), 1e-300)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

/** Commanded speed after the corner, trapezoid: c + a t up to the tier speed v. */
function trapezoidSpeed(t: number, c: number, v: number, a: number): number {
  return Math.min(v, c + a * t)
}

/** Time to cover distance s after the corner on the trapezoid. */
function trapezoidTime(s: number, c: number, v: number, a: number): number {
  const tRamp = (v - c) / a
  const sRamp = c * tRamp + 0.5 * a * tRamp * tRamp
  if (s <= sRamp) return (-c + Math.sqrt(c * c + 2 * a * s)) / a
  return tRamp + (s - sRamp) / v
}

/** Distance covered by time t after the corner on the trapezoid. */
function trapezoidDistance(t: number, c: number, v: number, a: number): number {
  const tRamp = (v - c) / a
  if (t <= tRamp) return c * t + 0.5 * a * t * t
  return c * tRamp + 0.5 * a * tRamp * tRamp + v * (t - tRamp)
}

/**
 * The time at which the nozzle deposits arc position s when it lags its commanded position by
 * lag(t): the root of distance(t) - lag(t) = s, by bisection between the times the commanded
 * profile reaches s - |lag|max and s + |lag|max (the root lies between them for any lag bounded
 * by lagMaxMm).
 */
function depositTime(
  s: number,
  distance: (t: number) => number,
  time: (s: number) => number,
  lag: (t: number) => number,
  lagMaxMm: number,
): number {
  let lo = time(Math.max(0, s - lagMaxMm))
  let hi = time(s + lagMaxMm)
  const f = (t: number) => distance(t) - lag(t) - s
  if (f(lo) > 0 || f(hi) < 0) throw new Error('The along-track lag does not bracket the deposit time')
  for (let k = 0; k < 80; k++) {
    const mid = 0.5 * (lo + hi)
    if (f(mid) < 0) lo = mid
    else hi = mid
  }
  return 0.5 * (lo + hi)
}

/**
 * First-order lag q of the commanded flow (proportional to the commanded speed) at time t after
 * the corner: tau q' = v(t) - q, with q = c before the corner (steady run-up). On the ramp the
 * input is c + a t, whose lagged response is c + a (t - tau) + a tau e^(-t/tau); after the ramp
 * the lag relaxes exponentially toward the tier speed.
 */
function laggedFlow(t: number, c: number, v: number, a: number, tau: number): number {
  const tRamp = (v - c) / a
  if (t <= tRamp) return c + a * (t - tau) + a * tau * Math.exp(-t / tau)
  const atRampEnd = c + a * (tRamp - tau) + a * tau * Math.exp(-tRamp / tau)
  return v + (atRampEnd - v) * Math.exp(-(t - tRamp) / tau)
}

/** A damped mode's response at time t: amplitude at the corner, decaying, from the given phase. */
function modeAt(t: number, frequencyHz: number, dampingRatio: number, ampMm: number, phaseRad: number): number {
  const omega = 2 * Math.PI * frequencyHz
  return ampMm * Math.exp(-dampingRatio * omega * t) * Math.cos(omega * Math.sqrt(1 - dampingRatio * dampingRatio) * t + phaseRad)
}

/**
 * The integral of e^(-zeta w x) cos(w_d x + phase) over [x0, x1], by its antiderivative
 * e^(alpha x) (alpha cos(beta x + phase) + beta sin(beta x + phase)) / (alpha^2 + beta^2) with
 * alpha = -zeta w and beta = w_d.
 */
function dampedCosIntegral(x0: number, x1: number, frequencyHz: number, dampingRatio: number, phaseRad: number): number {
  const omega = 2 * Math.PI * frequencyHz
  const alpha = -dampingRatio * omega
  const beta = omega * Math.sqrt(1 - dampingRatio * dampingRatio)
  const antiderivative = (x: number) =>
    (Math.exp(alpha * x) * (alpha * Math.cos(beta * x + phaseRad) + beta * Math.sin(beta * x + phaseRad))) /
    (alpha * alpha + beta * beta)
  return antiderivative(x1) - antiderivative(x0)
}

/** Discrete Gaussian kernel of standard deviation sigma px, unit L2 norm (keeps the variance). */
function gaussianKernel(sigma: number): number[] {
  const half = Math.ceil(4 * sigma)
  const k: number[] = []
  for (let i = -half; i <= half; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)))
  const norm = Math.sqrt(k.reduce((s, w) => s + w * w, 0))
  return k.map((w) => w / norm)
}

/** Linear read of a pixel-indexed array at fractional pixel position x. */
function readLinear(pixels: number[], x: number): number {
  const i = Math.floor(x)
  const f = x - i
  return (1 - f) * pixels[i] + f * pixels[i + 1]
}

/** Noise in px at each of `count` samples, for one line. */
function lineNoisePx(
  noise: SimNoise,
  sigmaPx: number,
  count: number,
  phasePx: number,
  cruiseDtS: number,
  rand: () => number,
): number[] {
  if (noise.model === 'iid') return Array.from({ length: count }, () => sigmaPx * normal(rand))
  if (noise.model === 'redAr2') {
    const r = noise.poleRadius ?? 0.9
    const w0 = 2 * Math.PI * (noise.peakHz ?? 60) * cruiseDtS
    const phi1 = 2 * r * Math.cos(w0)
    const phi2 = -r * r
    // Stationary variance of the AR(2) with unit innovations (Box and Jenkins), to scale to sigma.
    const variance = (1 - phi2) / ((1 + phi2) * ((1 - phi2) ** 2 - phi1 * phi1))
    const out: number[] = []
    let x1 = 0
    let x2 = 0
    for (let k = 0; k < count + 500; k++) {
      const x = phi1 * x1 + phi2 * x2 + normal(rand)
      x2 = x1
      x1 = x
      if (k >= 500) out.push((sigmaPx * x) / Math.sqrt(variance))
    }
    return out
  }
  // Pixel-level noise read at the tracer's steps by bilinear interpolation, optionally blurred first.
  const pixelsNeeded = Math.ceil(phasePx + count * ALONG_STEP_PX) + 2
  const blurSigma = noise.model === 'blur1' ? 1 : noise.model === 'blur2' ? 2 : 0
  const kernel = blurSigma > 0 ? gaussianKernel(blurSigma) : [1]
  const half = (kernel.length - 1) / 2
  const raw = Array.from({ length: pixelsNeeded + 2 * half }, () => sigmaPx * normal(rand))
  const pixels: number[] = []
  for (let j = 0; j < pixelsNeeded; j++) {
    let s = 0
    for (let k = 0; k < kernel.length; k++) s += kernel[k] * raw[j + k]
    pixels.push(s)
  }
  return Array.from({ length: count }, (_, k) => readLinear(pixels, phasePx + k * ALONG_STEP_PX))
}

/** Zero-mean periodic block pattern with one random level per pixel of the period. */
function blockPattern(periodPx: number, rand: () => number): number[] {
  const levels = Array.from({ length: periodPx }, () => rand() - 0.5)
  const mean = levels.reduce((s, v) => s + v, 0) / periodPx
  const centered = levels.map((v) => v - mean)
  const peak = Math.max(...centered.map(Math.abs))
  return centered.map((v) => v / peak)
}

/** Marks `fraction` of `count` samples unread, in runs of 1 to maxRun, away from the ends. */
function gapMask(count: number, fraction: number, maxRun: number, rand: () => number): boolean[] {
  const observed = new Array<boolean>(count).fill(true)
  let missing = 0
  const target = Math.floor(fraction * count)
  let guard = 0
  while (missing < target && guard++ < 10 * count) {
    const run = 1 + Math.floor(rand() * maxRun)
    const start = 1 + Math.floor(rand() * (count - run - 2))
    for (let k = start; k < start + run && missing < target; k++) {
      if (observed[k]) {
        observed[k] = false
        missing++
      }
    }
  }
  return observed
}

/** Fills unread samples by linear interpolation between read neighbours, as the tracer does. */
function fillGaps(y: Float64Array, observed: boolean[]): void {
  let last = -1
  for (let i = 0; i < y.length; i++) {
    if (!observed[i]) continue
    if (last >= 0 && last < i - 1) {
      for (let j = last + 1; j < i; j++) {
        const f = (j - last) / (i - last)
        y[j] = y[last] * (1 - f) + y[i] * f
      }
    }
    last = i
  }
}

/** Simulates the traced lines of one axis group of the coupon `spec` describes. */
export function simulateAxis(options: TraceSimOptions): SimLine[] {
  const spec = options.spec
  const axis = options.axis ?? 'y'
  const pxPerMm = options.pxPerMm ?? SIM_PX_PER_MM
  const geometry = isCouponGeometry(spec)
  const groupIndex = geometry.groups.findIndex((g) => g.axis === axis)
  if (groupIndex < 0) throw new Error(`The spec has no ${axis} group`)
  const group = geometry.groups[groupIndex]
  const printRank = new Map<number, number>()
  geometry.printOrder.forEach((ref, rank) => {
    if (ref.groupIndex === groupIndex) printRank.set(ref.lineIndex, rank)
  })
  // Field offset perpendicular to the measured direction: the Y group's lines stack in y, the X
  // group's in x.
  const perpendicular = (i: number) =>
    axis === 'y' ? group.lines[i].measured.y0 : -group.lines[i].measured.x0
  const offsets = group.lines.map((_, i) => perpendicular(i))
  const minOffset = Math.min(...offsets)
  const meanOffset = offsets.reduce((s, o) => s + o, 0) / offsets.length - minOffset
  const cTop = Math.max(...geometry.groups.flatMap((g) => g.lines.map((l) => l.cornerSpeedMmS)))
  const a = spec.accelMmS2
  const rand = prng(options.seed)
  const jpeg = options.artifacts?.jpegBlock
    ? blockPattern(options.artifacts.jpegBlock.periodPx, rand)
    : null
  const indices = options.lineIndices ?? group.lines.map((_, i) => i)
  const stepMm = ALONG_STEP_PX / pxPerMm

  return indices.map((i) => {
    const line = group.lines[i]
    const v = line.speedMmS
    const c = line.cornerSpeedMmS
    const rampMm = (v * v - c * c) / (2 * a)
    const count = Math.floor((rampMm + spec.measuredLineMm - TRACE_START_MM) / stepMm) + 1
    const offsetMm = offsets[i] - minOffset
    const lineRand = prng(options.seed * 7919 + i * 104729 + 17)
    const tierIndex = spec.speedsMmS.indexOf(v)

    const tTraced = new Float64Array(count)
    const lateral = new Float64Array(count)
    const acrossNominal = new Float64Array(count)
    const along = options.alongTrack
    const alongAmp = along ? (along.ampMm ?? cTop / (2 * Math.PI * along.frequencyHz)) * (c / cTop) : 0
    const sign = options.lateralTowardRunUp ?? 1
    const alongPhase = along?.phaseRad ?? -Math.PI / 2
    const tRamp = (v - c) / a
    // The response to the corner's step c, plus the ramp: a velocity step a dtau at every tau of
    // [0, tRamp] answered by the unit step response (alongAmp / c per mm/s) tau later.
    const lag = (t: number) => {
      if (!along) return 0
      const corner = modeAt(t, along.frequencyHz, along.dampingRatio, alongAmp, alongPhase)
      const span = Math.min(t, tRamp)
      const ramp = a * (alongAmp / c) * dampedCosIntegral(t - span, t, along.frequencyHz, along.dampingRatio, alongPhase)
      return corner + ramp
    }
    // |corner| <= |alongAmp| and |ramp| <= a tRamp |alongAmp| / c, the ramp's velocity change v - c.
    const lagMaxMm = (Math.abs(alongAmp) * v) / c
    const ring = options.ring ?? null
    let f = ring ? (ring.frequencyByTierHz?.[tierIndex] ?? ring.frequencyHz) : 0
    if (ring?.frequencyGradientHzPerMm) f += ring.frequencyGradientHzPerMm * (offsetMm - meanOffset)
    const toneRand = lineRand()
    const beltPhase = 2 * Math.PI * lineRand()
    const pixelPhase = lineRand()
    const lockOffset = lineRand()
    // Drawn only when used, so the noise streams of every existing seed stay unchanged.
    const pedestalPhase = options.pedestalRing ? 2 * Math.PI * lineRand() : 0
    for (let k = 0; k < count; k++) {
      const s = TRACE_START_MM + k * stepMm
      tTraced[k] = trapezoidTime(s, c, v, a)
      // The nozzle lags its commanded arc position by the along-track mode's response to the
      // corner's velocity step and the ramp, so the bead at s is deposited when the lagging
      // nozzle reaches s.
      const t = along
        ? depositTime(s, (u) => trapezoidDistance(u, c, v, a), (x) => trapezoidTime(x, c, v, a), lag, lagMaxMm)
        : trapezoidTime(s, c, v, a)
      let y = 0
      if (ring) y += modeAt(t, f, ring.dampingRatio, ring.ampMm * (c / cTop), ring.phaseRad ?? 0)
      for (const mode of options.extraModes ?? []) {
        y += modeAt(t, mode.frequencyByTierHz?.[tierIndex] ?? mode.frequencyHz, mode.dampingRatio, mode.ampMm * (c / cTop), mode.phaseRad ?? 0)
      }
      if (options.spatialLobe) {
        y += options.spatialLobe.ampMm * (c / cTop) * Math.exp(-s / options.spatialLobe.lambdaMm)
      }
      if (options.pedestalRing) {
        const pr = options.pedestalRing
        y += modeAt(s / pr.speedMmS, pr.frequencyHz, pr.dampingRatio, pr.ampMm, pedestalPhase)
      }
      if (options.cornerLobe) {
        y += options.cornerLobe.ampMm * (c / cTop) * Math.exp(-t / options.cornerLobe.tauS)
      }
      if (options.flowLag) {
        const { tauS, ampMm } = options.flowLag
        y += ampMm * (laggedFlow(t, c, v, a, tauS) / trapezoidSpeed(t, c, v, a) - 1)
      }
      const art = options.artifacts
      if (art?.beltTooth) {
        y += art.beltTooth.ampMm * Math.sin((2 * Math.PI * s) / art.beltTooth.periodMm + beltPhase)
      }
      if (art?.forcedTone) {
        y += art.forcedTone.ampMm * Math.cos(2 * Math.PI * (art.forcedTone.frequencyHz * t + toneRand))
      }
      const xPx = pixelPhase + s * pxPerMm
      if (jpeg && art?.jpegBlock) {
        const u = (((xPx % art.jpegBlock.periodPx) + art.jpegBlock.periodPx) % art.jpegBlock.periodPx)
        const j0 = Math.floor(u)
        const fr = u - j0
        const level = (1 - fr) * jpeg[j0] + fr * jpeg[(j0 + 1) % art.jpegBlock.periodPx]
        y += art.jpegBlock.ampMm * level
      }
      // The mechanisms above are displacements along the run-up's direction of travel; the
      // tracer reads them in its own lateral coordinate.
      y *= sign
      const tilt = art?.pixelLock ? Math.tan((art.pixelLock.tiltDeg * Math.PI) / 180) : 0
      acrossNominal[k] = lockOffset + xPx * tilt
      if (art?.pixelLock) {
        // The centroid locks toward pixel centres by where the bead actually lies across the
        // pixel grid: the nominal centerline plus the lateral deviation.
        const acrossPx = acrossNominal[k] + y * pxPerMm
        const sub = acrossPx - Math.floor(acrossPx)
        y += (art.pixelLock.ampPx * Math.sin(2 * Math.PI * sub)) / pxPerMm
      }
      lateral[k] = y
    }

    const sigmaPx = options.noise.sigmaPx * (options.noise.perLineScale?.[i] ?? 1)
    const cruiseDtS = stepMm / v
    const noisePx = lineNoisePx(options.noise, sigmaPx, count, pixelPhase, cruiseDtS, lineRand)
    const deficit = new Float64Array(count)
    if (options.earlyNoise) {
      for (let k = 0; k < count; k++) {
        const t = trapezoidTime(TRACE_START_MM + k * stepMm, c, v, a)
        deficit[k] = 1 - laggedFlow(t, c, v, a, options.earlyNoise.tauS) / trapezoidSpeed(t, c, v, a)
      }
      const peak = Math.max(...deficit)
      if (peak > 0) for (let k = 0; k < count; k++) deficit[k] /= peak
    }
    for (let k = 0; k < count; k++) {
      const inflation = 1 + (options.earlyNoise ? options.earlyNoise.factor * deficit[k] : 0)
      lateral[k] += (inflation * noisePx[k]) / pxPerMm
    }
    if (options.impulseOutliers) {
      const outlierRand = prng(options.seed * 6151 + i * 3571 + 29)
      for (let k = 0; k < count; k++) {
        if (outlierRand() >= options.impulseOutliers.fraction) continue
        const sign = outlierRand() < 0.5 ? -1 : 1
        lateral[k] += sign * options.impulseOutliers.ampMm * (0.5 + outlierRand())
      }
    }

    const observed = options.gaps
      ? gapMask(count, options.gaps.fraction, options.gaps.maxRun, lineRand)
      : new Array<boolean>(count).fill(true)
    for (let k = 0; k < count; k++) if (!observed[k]) lateral[k] = NaN
    fillGaps(lateral, observed)

    const trace: TracedLine = {
      speedMmS: v,
      cornerSpeedMmS: c,
      accelMmS2: a,
      tS: tTraced,
      lateralMm: lateral,
      observed: Uint8Array.from(observed, (o) => (o ? 1 : 0)),
      alongPxPerMm: pxPerMm,
      acrossImagePx: acrossNominal,
      acrossAxisPxPerMm: pxPerMm,
      lateralTowardRunUp: sign,
    }
    return {
      trace,
      speedMmS: v,
      cornerSpeedMmS: c,
      rungIndex: line.rungIndex,
      offsetMm,
      printRank: printRank.get(i) ?? -1,
      observed,
    }
  })
}
