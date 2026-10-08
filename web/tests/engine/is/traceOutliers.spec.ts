// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { lineAdditiveOutliers, withoutSamples } from '../../../src/engine/is/traceOutliers'
import { analyzeTracedLine } from '../../../src/engine/is/ringAnalyzer'
import { fitNoise, lineBasis, olsNull } from '../../../src/engine/is/ringGls'
import type { LineRecord } from '../../../src/engine/is/ringGls'
import { nullHypothesisFit } from '../../../src/engine/is/ringLikelihood'
import { defaultIsTestRequest, fitSpecToPrinter } from '../../../src/engine/is/types'
import type { IsTestSpec } from '../../../src/engine/is/types'
import { defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'
import { simulateAxis } from '../../helpers/isTraceSim'
import type { SimNoise, SimRing } from '../../helpers/isTraceSim'

// Additive outliers of a traced line: the top-rung line of the default coupon, simulated from
// literal truth (a ring and scan noise), with specks of dust added at known samples of its fit
// window. The cleaning must set aside exactly those samples.

const profile = defaultPrinterProfile()
const twoTier: IsTestSpec = { ...fitSpecToPrinter(defaultIsTestRequest(profile), profile).spec, axes: ['y'] }

/** A 60 Hz ring of 0.035 mm on the top rung, the regime of a stiff printer. */
const fieldRing: SimRing = { frequencyHz: 60, dampingRatio: 0.05, ampMm: 0.035 }

/** The outliers found on the simulated line after adding `dust` (window sample, mm). */
function outliersOf(noise: SimNoise, dust: [number, number][], ring: SimRing = fieldRing): number[] {
  const [sim] = simulateAxis({ seed: 1, spec: twoTier, lineIndices: [9], noise, ring })
  const window = analyzeTracedLine(sim.trace).window!
  const y = window.y.slice()
  for (const [i, mm] of dust) y[i] += mm
  const basis = lineBasis({ ...window, y })
  const h0 = nullHypothesisFit(basis, fitNoise(basis, olsNull(basis, 0.03).residual).fit, 0.03)
  return lineAdditiveOutliers(basis, h0)
}

// Three specks of 0.03 to 0.05 mm, 7 to 12 times the 0.0042 mm scan noise.
const dust: [number, number][] = [
  [120, 0.03],
  [300, -0.05],
  [520, 0.04],
]

describe('lineAdditiveOutliers', () => {
  it('sets aside exactly the samples specks of dust displaced, under white scan noise', () => {
    expect(outliersOf({ model: 'iid', sigmaPx: 0.1 }, dust)).toEqual([120, 300, 520])
  })

  it('sets aside exactly the samples specks of dust displaced, under 2 px blurred scan noise', () => {
    expect(outliersOf({ model: 'blur2', sigmaPx: 0.1 }, dust)).toEqual([120, 300, 520])
  })

  it('keeps the start of a strongly ringing line under faint scan noise, where the ring is largest', () => {
    // A 0.25 mm ring under 0.01 px noise: the start of the window is far from stationary.
    const strong: SimRing = { frequencyHz: 75, dampingRatio: 0.05, ampMm: 0.25 }
    expect(outliersOf({ model: 'iid', sigmaPx: 0.01 }, dust, strong)).toEqual([120, 300, 520])
  })

  it('sets nothing aside on a line without dust', () => {
    expect(outliersOf({ model: 'iid', sigmaPx: 0.1 }, [])).toEqual([])
    expect(outliersOf({ model: 'blur2', sigmaPx: 0.1 }, [])).toEqual([])
  })
})

describe('withoutSamples', () => {
  it('turns the dropped samples into unread lattice positions and keeps every other field', () => {
    const rec: LineRecord = {
      tS: Float64Array.from([0.01, 0.02, 0.03, 0.04, 0.05]),
      lattice: Int32Array.from([3, 4, 5, 7, 8]),
      y: Float64Array.from([1, 2, 3, 4, 5]),
      acrossImagePx: Float64Array.from([10, 11, 12, 13, 14]),
      depositTimeS: Float64Array.from([0.011, 0.021, 0.031, 0.041, 0.051]),
      speedMmS: 150,
      cornerSpeedMmS: 100,
      accelMmS2: 3000,
      alongPxPerMm: 23.6,
      acrossAxisPxPerMm: 23.6,
      lateralTowardRunUp: 1,
    }
    const kept = withoutSamples(rec, [1, 3])
    expect(Array.from(kept.lattice)).toEqual([3, 5, 8])
    expect(Array.from(kept.tS)).toEqual([0.01, 0.03, 0.05])
    expect(Array.from(kept.y)).toEqual([1, 3, 5])
    expect(Array.from(kept.acrossImagePx)).toEqual([10, 12, 14])
    expect(Array.from(kept.depositTimeS!)).toEqual([0.011, 0.031, 0.051])
    expect(kept.speedMmS).toBe(150)
    expect(kept.cornerSpeedMmS).toBe(100)
  })
})
