// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  DETECTION_GRID_SIZE,
  analyzeTracedLine,
  poolAxisFits,
} from '../../../src/engine/is/ringAnalyzer'
import type { LineFit } from '../../../src/engine/is/ringAnalyzer'
import type { TracedLine } from '../../../src/engine/is/lineTracer'
import { defaultIsTestRequest, fitSpecToPrinter } from '../../../src/engine/is/types'
import type { IsTestSpec } from '../../../src/engine/is/types'
import { defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'
import { simulateAxis } from '../../helpers/isTraceSim'
import type { SimLine, TraceSimOptions } from '../../helpers/isTraceSim'

// Unit-level validation of the ring detection and estimation on simulated traced lines
// (tests/helpers/isTraceSim.ts: the fitted coupon's own lines on the tracer's 600 dpi one-pixel
// lattice, ring and artifacts generated from literal truth). The traces carry iid scan noise of
// 0.1 px per sample unless a case says otherwise. Image-level recovery lives in
// isAnalyzer.spec.ts; the statistical calibration of every decision in tests/stats.

const profile = defaultPrinterProfile()
/** The default coupon's Y group: tiers 106 and 150 mm/s, five rungs each. */
const twoTier: IsTestSpec = { ...fitSpecToPrinter(defaultIsTestRequest(profile), profile).spec, axes: ['y'] }
/** A one-tier coupon at 150 mm/s. */
const oneTier: IsTestSpec = {
  ...fitSpecToPrinter({ ...defaultIsTestRequest(profile), speedsMmS: [150] }, profile).spec,
  axes: ['y'],
}
const IID = { model: 'iid' as const, sigmaPx: 0.1 }

function pool(spec: IsTestSpec, lines: SimLine[]) {
  return poolAxisFits(lines.map((l) => analyzeTracedLine(l.trace)), spec.speedsMmS)
}

function simulate(spec: IsTestSpec, options: Omit<TraceSimOptions, 'spec' | 'seed'>, seed = 1) {
  return simulateAxis({ seed, spec, ...options })
}

/** Adds a damped ring to one simulated line's trace (a disturbance on that line alone). */
function addToLine(line: SimLine, ampMm: number, frequencyHz: number, dampingRatio: number): void {
  const t = line.trace
  const w = 2 * Math.PI * frequencyHz
  for (let k = 0; k < t.tS.length; k++) {
    t.lateralMm[k] += ampMm * Math.exp(-dampingRatio * w * t.tS[k]) * Math.cos(w * t.tS[k])
  }
}

function trace(tS: number[], lateralMm: number[], observed: number[], fitStartMinS = 0): TracedLine {
  return {
    speedMmS: 150,
    cornerSpeedMmS: 100,
    accelMmS2: 3000,
    tS: Float64Array.from(tS),
    fitStartMinS,
    lateralMm: Float64Array.from(lateralMm),
    observed: Uint8Array.from(observed),
    alongPxPerMm: 23.6,
  }
}

describe('analyzeTracedLine', () => {
  it('puts only the samples the tracer read into the fit window', () => {
    const [line] = simulate(twoTier, { noise: IID, gaps: { fraction: 0.05, maxRun: 4 }, lineIndices: [0] })
    const fit = analyzeTracedLine(line.trace)
    expect(fit.screening).toBe('windowed')
    const unread = Array.from(fit.window!.lattice).filter((k) => line.trace.observed[k] === 0)
    expect(unread).toEqual([])
  })

  it('starts the window no earlier than the earliest exactly timed sample', () => {
    const [line] = simulate(twoTier, { noise: IID, lineIndices: [0] })
    const held = analyzeTracedLine({ ...line.trace, fitStartMinS: 0.05 })
    expect(held.window!.tS[0]).toBeGreaterThanOrEqual(0.05)
  })

  it('finds no window when the earliest exactly timed sample lies past the trace', () => {
    const [line] = simulate(twoTier, { noise: IID, lineIndices: [0] })
    const fit = analyzeTracedLine({ ...line.trace, fitStartMinS: 10 })
    expect(fit.screening).toBe('no-free-response')
    expect(fit.refusalCategory).toBe('irregular-trace')
    expect(fit.window).toBeNull()
  })

  it('finds no window in a trace too short to host the model', () => {
    const fit = analyzeTracedLine(trace([0, 0.001, 0.002], [0.1, -0.05, 0.02], [1, 1, 1]))
    expect(fit.screening).toBe('no-free-response')
    expect(fit.refusalReason).toContain('never settles')
  })

  it('reads the lateral offset from read samples only', () => {
    // Read samples sit at 0.2 mm; the filled-in sample carries 5 mm and must not count.
    const fit = analyzeTracedLine(trace([0, 1, 2, 3, 4, 5], [0.2, 0.2, 0.2, 0.2, 5, 0.2], [1, 1, 1, 1, 0, 1]))
    expect(fit.offsetMm).toBe(0.2)
  })
})

describe('poolAxisFits detection', () => {
  it('pays the look-elsewhere penalty over 1,703 grid points', () => {
    // 131 frequencies (20 to 150 Hz every 1 Hz) times 13 damping ratios.
    expect(DETECTION_GRID_SIZE).toBe(1703)
  })

  it('refuses scan noise alone with the no-ringing reason and its rescan advice', () => {
    const p = pool(twoTier, simulate(twoTier, { noise: IID }))
    expect(p.accepted).toBe(false)
    expect(p.detectionPBound!).toBeGreaterThan(0.001)
    expect(p.refusals).toEqual([
      'No ringing was found on this axis. Across all its lines, the traces match drift and scan noise.',
    ])
    expect(p.rescanAdvice).toContain('half turn')
  })

  it('does not mistake the flow lag of the commanded flow for ringing', () => {
    // A 40 ms first-order flow lag leaves a 0.03 mm lobe after every corner; the model carries it.
    const p = pool(twoTier, simulate(twoTier, { noise: IID, flowLag: { tauS: 0.04, ampMm: 0.03 } }))
    expect(p.accepted).toBe(false)
    expect(p.detectionPBound!).toBeGreaterThan(0.001)
  })

  it('does not take the rougher bead after the corner for ringing', () => {
    // Scan noise doubled where the extruded flow lags a 40 ms first-order lag, with that lag's
    // lobe: the variance function of the noise model carries it.
    const p = pool(
      twoTier,
      simulate(twoTier, { noise: IID, flowLag: { tauS: 0.04, ampMm: 0.03 }, earlyNoise: { factor: 2, tauS: 0.04 } }, 2),
    )
    expect(p.detectionPBound!).toBeGreaterThan(0.001)
  })

  it('refuses too few lines with a fit window, pointing at the lamp shadow', () => {
    const none: LineFit = {
      screening: 'no-free-response',
      refusalReason: 'no free ringdown',
      refusalCategory: 'irregular-trace',
      window: null,
      offsetMm: null,
    }
    const p = poolAxisFits([none, none, none, none], [150])
    expect(p.refusals).toEqual([
      "Only 0 of the axis's lines produced a usable ringing trace (at least 3 are needed for a " +
        'trustworthy estimate).',
    ])
    expect(p.rescanAdvice).toContain('half turn')
  })
})

describe('poolAxisFits estimation', () => {
  it('recovers a 60 Hz ring at damping 0.05 from both tiers', () => {
    // Truth 60 Hz, zeta 0.05, 0.03 mm on the top rung. The frequency standard error of this
    // configuration is about 0.085 Hz, so 0.3 Hz is 3.5 standard errors; the damping band is a
    // tenth of the truth (observed seed-to-seed spread 0.002).
    const p = pool(twoTier, simulate(twoTier, { noise: IID, ring: { frequencyHz: 60, dampingRatio: 0.05, ampMm: 0.03 } }))
    expect(p.accepted).toBe(true)
    expect(Math.abs(p.frequencyHz! - 60)).toBeLessThan(0.3)
    expect(Math.abs(p.dampingRatio! - 0.05)).toBeLessThan(0.005)
    expect(p.linesUsed).toBe(10)
  })

  it('passes every check on a real ring: speed, proportionality, replicates, decay', () => {
    const p = pool(twoTier, simulate(twoTier, { noise: IID, ring: { frequencyHz: 60, dampingRatio: 0.05, ampMm: 0.03 } }))
    expect(p.speedCheck.state).toBe('confirmed')
    expect(p.speedCheck.tiers.map((t) => t.speedMmS)).toEqual([106, 150])
    expect(p.proportionality).toBe('passed')
    expect(p.replicateCheck).toBe('passed')
    expect(p.decayDemonstrated).toBe(true)
  })

  it('accepts a strong, lightly damped ring that the noise model under the null partly absorbs', () => {
    // zeta 0.005 at 60 Hz, 0.25 mm: nearly stationary over the read window.
    const p = pool(twoTier, simulate(twoTier, { noise: IID, ring: { frequencyHz: 60, dampingRatio: 0.005, ampMm: 0.25 } }, 5))
    expect(p.accepted).toBe(true)
    expect(Math.abs(p.frequencyHz! - 60)).toBeLessThan(0.3)
    expect(p.speedCheck.state).toBe('confirmed')
  })

  it('accepts a moderate ring so lightly damped that the noise model of the null absorbs it', () => {
    // zeta 0.002 at 60 Hz, 0.03 mm: persistent over the whole read window, so a noise model
    // fitted without the ring predicts it; only the noise model refitted under the ring sees it.
    const p = pool(twoTier, simulate(twoTier, { noise: IID, ring: { frequencyHz: 60, dampingRatio: 0.002, ampMm: 0.03 } }))
    expect(p.accepted).toBe(true)
    expect(Math.abs(p.frequencyHz! - 60)).toBeLessThan(0.3)
  })

  it('reports a second mode next to the dominant one', () => {
    // Modes at 45 Hz (0.03 mm) and 62 Hz (0.02 mm): the fitted modes' standard errors are about
    // 0.13 and 0.45 Hz, so 0.5 Hz and 1.5 Hz are more than three of them.
    const p = pool(
      twoTier,
      simulate(twoTier, {
        noise: IID,
        ring: { frequencyHz: 45, dampingRatio: 0.05, ampMm: 0.03 },
        extraModes: [{ frequencyHz: 62, dampingRatio: 0.05, ampMm: 0.02 }],
      }),
    )
    expect(p.accepted).toBe(true)
    expect(Math.abs(p.frequencyHz! - 45)).toBeLessThan(0.5)
    expect(p.secondModePBound!).toBeLessThanOrEqual(0.001)
    expect(Math.abs(p.secondMode!.frequencyHz - 62)).toBeLessThan(1.5)
    expect(p.secondMode!.proportionality).toBe('passed')
  })

  it('finds no second mode next to a single mode', () => {
    const p = pool(twoTier, simulate(twoTier, { noise: IID, ring: { frequencyHz: 60, dampingRatio: 0.05, ampMm: 0.03 } }))
    expect(p.secondModePBound!).toBeGreaterThan(0.001)
    expect(p.secondMode).toBeNull()
  })

  it('handles unread samples without biasing the frequency', () => {
    const p = pool(
      twoTier,
      simulate(twoTier, {
        noise: IID,
        ring: { frequencyHz: 60, dampingRatio: 0.05, ampMm: 0.03 },
        gaps: { fraction: 0.05, maxRun: 4 },
      }),
    )
    expect(p.accepted).toBe(true)
    expect(Math.abs(p.frequencyHz! - 60)).toBeLessThan(0.3)
  })

  it('excludes a line whose own ring sits at the edge of the search range', () => {
    const lines = simulate(twoTier, { noise: IID, ring: { frequencyHz: 60, dampingRatio: 0.05, ampMm: 0.03 } })
    addToLine(lines[3], 0.1, 152, 0.05)
    const p = pool(twoTier, lines)
    expect(p.lines[3].exclusion).toBe('out-of-band')
    expect(p.lines[3].usedInJointFit).toBe(false)
    expect(p.accepted).toBe(true)
    expect(Math.abs(p.frequencyHz! - 60)).toBeLessThan(0.3)
  })
})

describe('poolAxisFits checks', () => {
  it('identifies a GT2 belt-tooth pattern as a known artifact and finds no ringing', () => {
    // The 2 mm GT2 pitch, 0.002 mm on every line of both tiers: the known-period stage finds it,
    // and with it in the null design nothing is left to detect.
    const belt = { beltTooth: { periodMm: 2, ampMm: 0.002 } }
    const p = pool(twoTier, simulate(twoTier, { noise: IID, artifacts: belt }, 3))
    expect(p.artifacts.map((a) => [a.periodMm, a.known])).toEqual([[2, true]])
    expect(p.detectionPBound!).toBeGreaterThan(0.001)
  })

  it('finds a stationary pattern of unknown period and still measures the ring next to it', () => {
    // A 1.7 mm arc-length pattern, 0.002 mm, beside a 60 Hz ring: the grid's period step at
    // 1.7 mm is 1.7^2 / 150 = 0.019 mm (hand-computed), and the ring stays within 0.5 Hz.
    const p = pool(
      twoTier,
      simulate(
        twoTier,
        {
          noise: IID,
          ring: { frequencyHz: 60, dampingRatio: 0.05, ampMm: 0.03 },
          artifacts: { beltTooth: { periodMm: 1.7, ampMm: 0.002 } },
        },
        2,
      ),
    )
    expect(p.artifacts).toHaveLength(1)
    expect(p.artifacts[0].known).toBe(false)
    expect(Math.abs(p.artifacts[0].periodMm - 1.7)).toBeLessThanOrEqual(0.019)
    expect(p.accepted).toBe(true)
    expect(Math.abs(p.frequencyHz! - 60)).toBeLessThan(0.5)
  })

  it('identifies the slowly decaying ring of a pedestal layer as an arc-length artifact', () => {
    // A 30 Hz ring printed into the pedestal at 45 mm/s (a 1.5 mm period along the line), damping
    // 0.02, 0.005 mm on every line: it persists over the window, so the grid stage finds it.
    const pedestal = { frequencyHz: 30, dampingRatio: 0.02, ampMm: 0.005, speedMmS: 45 }
    const p = pool(twoTier, simulate(twoTier, { noise: IID, pedestalRing: pedestal }, 3))
    expect(p.artifacts.length).toBeGreaterThanOrEqual(1)
    expect(Math.abs(p.artifacts[0].periodMm - 1.5)).toBeLessThanOrEqual(0.05)
    expect(p.detectionPBound!).toBeGreaterThan(0.001)
  })

  it('refuses a strongly damped pedestal ring because its frequency changes with the line speed', () => {
    // The pedestal ring at damping 0.1, 0.02 mm, decays within a few millimetres, so it reads as a
    // ring: 70.7 Hz at 106 mm/s and 100 Hz at 150 mm/s.
    const pedestal = { frequencyHz: 30, dampingRatio: 0.1, ampMm: 0.02, speedMmS: 45 }
    const p = pool(twoTier, simulate(twoTier, { noise: IID, pedestalRing: pedestal }, 3))
    expect(p.speedCheck.state).toBe('changed')
    expect(p.refusals).toEqual([
      'The frequency changed with the line speed, the way a print or scan pattern does. Ringing ' +
        'of the machine keeps its frequency at every speed, so no shaper is recommended.',
    ])
  })

  it('refuses a forced tone because it does not grow with the corner speed', () => {
    // A 100 Hz tone fixed in time, 0.002 mm on every line with a random phase: it keeps its
    // frequency at both speeds, so only input proportionality can tell it from ringing.
    const p = pool(twoTier, simulate(twoTier, { noise: IID, artifacts: { forcedTone: { frequencyHz: 100, ampMm: 0.002 } } }))
    expect(p.speedCheck.state).toBe('confirmed')
    expect(p.proportionality).toBe('failed')
    expect(p.refusals).toEqual([
      'The pattern on this axis does not grow with the corner speed the way ringing of the ' +
        'machine does. A steady vibration, such as a fan, or a pattern in the print or the scan ' +
        'is the likely cause, so no shaper is recommended.',
    ])
  })

  it('detects a strong forced tone the noise model of the null absorbs, then refuses it', () => {
    // 0.01 mm at 100 Hz on every line with a random phase: a null noise model predicts it, so
    // without the refit the axis read as noise only; refitted it is found, and it fails the
    // proportionality gate.
    const p = pool(twoTier, simulate(twoTier, { noise: IID, artifacts: { forcedTone: { frequencyHz: 100, ampMm: 0.01 } } }))
    expect(p.detectionPBound!).toBeLessThanOrEqual(0.001)
    expect(p.proportionality).toBe('failed')
    expect(p.accepted).toBe(false)
  })

  it('reports an undamped tone as decay not demonstrated, a row and not a refusal reason', () => {
    const p = pool(twoTier, simulate(twoTier, { noise: IID, artifacts: { forcedTone: { frequencyHz: 100, ampMm: 0.002 } } }))
    expect(p.decayDemonstrated).toBe(false)
    expect(p.refusals.some((r) => r.includes('decay'))).toBe(false)
  })

  it('reports the speed check as not assessed on a one-tier coupon', () => {
    const p = pool(oneTier, simulate(oneTier, { noise: IID, ring: { frequencyHz: 60, dampingRatio: 0.05, ampMm: 0.03 } }))
    expect(p.speedCheck).toEqual({ state: 'not-assessed', tiers: [] })
    expect(p.influenceCheck).toBe('passed')
    expect(p.accepted).toBe(true)
  })

  it('refuses a one-tier detection that rests on a single line', () => {
    // Scan noise on every line, plus a strong 120 Hz transient, 0.3 mm, on one line only (a
    // defect or a speck of dust): without that line nothing is detected.
    const lines = simulate(oneTier, { noise: IID })
    addToLine(lines[2], 0.3, 120, 0.15)
    const p = pool(oneTier, lines)
    expect(p.detectionPBound!).toBeLessThanOrEqual(0.001)
    expect(p.influenceCheck).toBe('failed')
    expect(p.accepted).toBe(false)
    expect(p.refusals).toEqual([
      'The ringing found on this axis rests on a single line, so a print defect or dust on that ' +
        'line could have caused it. Rescan the coupon, or reprint it with two speed tiers.',
    ])
  })

  it('fails the replicate check when the lines disagree on the frequency', () => {
    // The frequency changes by 1 Hz per mm across the 22.5 mm line field (about +/-11 Hz).
    const p = pool(
      twoTier,
      simulate(twoTier, {
        noise: IID,
        ring: { frequencyHz: 60, dampingRatio: 0.05, ampMm: 0.03, frequencyGradientHzPerMm: 1 },
      }),
    )
    expect(p.replicateCheck).toBe('failed')
    expect(p.accepted).toBe(false)
  })
})
