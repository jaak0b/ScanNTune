// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  heldNoiseStatistic,
  noiseSpectrumPeaks,
  nullHypothesisFit,
  ringLikelihoodRatio,
} from '../../../src/engine/is/ringLikelihood'
import { analyzeTracedLine } from '../../../src/engine/is/ringAnalyzer'
import { fitNoise, lineBasis, olsNull, projectRing, ringScratch } from '../../../src/engine/is/ringGls'
import { varianceCovariate } from '../../../src/engine/is/ringRegressors'
import { defaultIsTestRequest, fitSpecToPrinter } from '../../../src/engine/is/types'
import type { IsTestSpec } from '../../../src/engine/is/types'
import { defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'
import { simulateAxis } from '../../helpers/isTraceSim'
import type { TraceSimOptions } from '../../helpers/isTraceSim'

// The likelihood ratio of a ring with the AR noise model refitted under each hypothesis, on lines
// simulated from literal truth (tests/helpers/isTraceSim.ts). Its calibration under the null is
// the tests/stats S1 suite; these cases pin the properties the detection field relies on.

const profile = defaultPrinterProfile()
const twoTier: IsTestSpec = { ...fitSpecToPrinter(defaultIsTestRequest(profile), profile).spec, axes: ['y'] }

/** Group index of the default coupon's 150 mm/s line on the top rung. */
const TOP_RUNG_150 = 6

/** One simulated line's basis and null fit at a 30 ms flow-lag time constant. */
function nullFitOf(options: Omit<TraceSimOptions, 'spec' | 'seed'>, seed: number, line: number) {
  const [sim] = simulateAxis({ seed, spec: twoTier, lineIndices: [line], ...options })
  const basis = lineBasis(analyzeTracedLine(sim.trace).window!)
  const initial = fitNoise(basis, olsNull(basis, 0.03).residual)
  return { sim, basis, h0: nullHypothesisFit(basis, initial.fit, 0.03) }
}

/** The fastest corner of the default coupon's Y group, the rung the ring amplitude refers to. */
function topRungMmS(): number {
  return Math.max(...simulateAxis({ seed: 1, spec: twoTier, noise: { model: 'iid', sigmaPx: 0 } }).map((l) => l.cornerSpeedMmS))
}

function heldAt(fit: ReturnType<typeof nullFitOf>, frequencyHz: number, dampingRatio: number): number {
  const { basis, h0 } = fit
  const D = projectRing(basis, h0.noise, h0.design, frequencyHz, dampingRatio, ringScratch(basis.m), new Float64Array(h0.design.k), new Float64Array(h0.design.k)).D
  return heldNoiseStatistic(h0, basis.m, D)
}

describe('ringLikelihoodRatio', () => {
  it('is never below the ratio with the null noise model held fixed', () => {
    // Under 2 px blur the null model has a high AR order, so the refit moves it most.
    const fit = nullFitOf({ noise: { model: 'blur2', sigmaPx: 0.1 } }, 11, 4)
    const points: [number, number][] = [[20, 0.001], [60, 0.05], [97, 0.2], [150, 0.4]]
    for (const [f, zeta] of points) {
      expect(ringLikelihoodRatio(fit.basis, fit.h0, { frequencyHz: f, dampingRatio: zeta }).statistic).toBeGreaterThanOrEqual(
        heldAt(fit, f, zeta),
      )
    }
  })

  it('credits a persistent ring that the null noise model absorbs', () => {
    // zeta 0.002 at 60 Hz, 0.03 mm on the top rung: an AR model of the null predicts it almost
    // exactly. 29.35 is the single-line critical value 2 ln(2353 / 0.001) = 29.342 of the detection
    // bound (hand-computed), rounded up: held fixed the line shows nothing, refitted it is detected on its own.
    const fit = nullFitOf({ noise: { model: 'iid', sigmaPx: 0.1 }, ring: { frequencyHz: 60, dampingRatio: 0.002, ampMm: 0.03 } }, 1, TOP_RUNG_150)
    expect([fit.sim.speedMmS, fit.sim.cornerSpeedMmS]).toEqual([150, topRungMmS()])
    expect(heldAt(fit, 60, 0.002)).toBeLessThan(29.35)
    expect(ringLikelihoodRatio(fit.basis, fit.h0, { frequencyHz: 60, dampingRatio: 0.002 }).statistic).toBeGreaterThan(29.35)
  })
})

describe('nullHypothesisFit', () => {
  it('applies the variance slope to the covariate it is given, not to the basis corner model', () => {
    // A slope estimated against the bead-drag lobe (a joint fit's variance function on a basis
    // built in the flow-lag model) must stay on that lobe: weighting the samples by the flow-lag
    // deficit instead is another variance function and another likelihood.
    const { basis, h0 } = nullFitOf({ noise: { model: 'iid', sigmaPx: 0.1 } }, 3, TOP_RUNG_150)
    const lobe = varianceCovariate(basis.rec, 'bead-drag', 0.4)
    const deficit = varianceCovariate(basis.rec, 'flow-lag', 0.03)

    const onLobe = nullHypothesisFit(basis, h0.noise.fit, 0.03, 3, lobe)
    const onDeficit = nullHypothesisFit(basis, h0.noise.fit, 0.03, 3, deficit)

    expect(onLobe.noise.covariate).toBe(lobe)
    expect(onDeficit.noise.covariate).toBe(deficit)
    expect(onLobe.deviance).not.toBeCloseTo(onDeficit.deviance, 3)
  })
})

describe('noiseSpectrumPeaks', () => {
  it('finds the spectral peak of an AR(2) model inside the band', () => {
    // AR(2) phi = (1.879796, -0.9) sampled at 1/3000 s peaks where cos w = phi1 (phi2 - 1) /
    // (4 phi2) (Box and Jenkins), w = 2 pi 60 / 3000: at 60 Hz (hand-computed).
    expect(noiseSpectrumPeaks({ coefficients: [1.879796, -0.9], noiseVariance: 1 }, 1 / 3000)).toEqual([60])
  })

  it('reports the band edge a monotone spectrum falls away from', () => {
    expect(noiseSpectrumPeaks({ coefficients: [0.5], noiseVariance: 1 }, 1 / 3000)).toEqual([20])
    expect(noiseSpectrumPeaks({ coefficients: [-0.5], noiseVariance: 1 }, 1 / 3000)).toEqual([200])
  })

  it('reports none for a white noise model', () => {
    expect(noiseSpectrumPeaks({ coefficients: [], noiseVariance: 1 }, 1 / 3000)).toEqual([])
  })
})
