// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  fitNoise,
  lineBasis,
  nullDesign,
  olsNull,
  pooledVarianceSlope,
  projectColumns,
  projectPeriodic,
  ringScratch,
} from '../../../src/engine/is/ringGls'
import { arcLengthMm, periodicColumns } from '../../../src/engine/is/ringRegressors'
import { analyzeTracedLine } from '../../../src/engine/is/ringAnalyzer'
import { defaultIsTestRequest, fitSpecToPrinter } from '../../../src/engine/is/types'
import { defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'
import { simulateAxis } from '../../helpers/isTraceSim'

describe('pooledVarianceSlope', () => {
  it('recovers the variance ratio of two groups of innovations as e^b', () => {
    // Four innovations of square 1 at g = 0 and four of square 4 at g = 1: the likelihood is
    // maximized where the variance ratio e^b equals the ratio of mean squares, 4, so b = ln 4 =
    // 1.386294; the likelihood ratio of b = 0 is 8 ln(20 / 8) - 4 ln 4 = 1.785148 (hand-computed).
    const result = pooledVarianceSlope([[1, -1, 1, -1, 2, -2, 2, -2]], [[0, 0, 0, 0, 1, 1, 1, 1]])
    expect(result.slope).toBeCloseTo(1.386294, 5)
    expect(result.statistic).toBeCloseTo(1.785148, 5)
  })

  it('pools the lines, each with its own level', () => {
    // The same pattern on two lines whose levels differ by a factor 100 in variance: the shared
    // slope is still ln 4 and the statistic doubles.
    const result = pooledVarianceSlope(
      [[1, -1, 1, -1, 2, -2, 2, -2], [10, -10, 10, -10, 20, -20, 20, -20]],
      [[0, 0, 0, 0, 1, 1, 1, 1], [0, 0, 0, 0, 1, 1, 1, 1]],
    )
    expect(result.slope).toBeCloseTo(1.386294, 5)
    expect(result.statistic).toBeCloseTo(3.570297, 5)
  })

  it('reports no slope and no evidence when the deficit vanishes', () => {
    expect(pooledVarianceSlope([[1, -2, 3]], [[0, 0, 0]])).toEqual({ slope: 0, statistic: 0 })
  })
})

describe('projectPeriodic', () => {
  it('whitens an arc-length sinusoid in closed form exactly as the explicit whitening does', () => {
    // A line under 2 px blur noise (a high AR order) with unread samples: the closed form on the
    // cruise lattice and the Kalman stretches must give the projection of the explicit columns, to
    // the rounding of the recurrence (re-anchored every 256 samples, about 1e-10 relative per
    // column, amplified by the Gram determinant's division): 1e-6 relative.
    const profile = defaultPrinterProfile()
    const spec = { ...fitSpecToPrinter(defaultIsTestRequest(profile), profile).spec, axes: ['y' as const] }
    const [line] = simulateAxis({ seed: 4, spec, noise: { model: 'blur2', sigmaPx: 0.1 }, gaps: { fraction: 0.03, maxRun: 3 }, lineIndices: [5] })
    const basis = lineBasis(analyzeTracedLine(line.trace).window!)
    const noise = fitNoise(basis, olsNull(basis, 0.03).residual)
    const design = nullDesign(basis, noise, 0.03)
    for (const periodMm of [0.9, 1.7, 4.2]) {
      const [cos, sin] = periodicColumns(arcLengthMm(basis.rec.tS, basis.rec), [periodMm])
      const explicit = projectColumns(basis, noise, design, cos, sin).D
      const closed = projectPeriodic(basis, noise, design, periodMm, ringScratch(basis.m), new Float64Array(design.k), new Float64Array(design.k)).D
      expect(Math.abs(closed - explicit)).toBeLessThanOrEqual(1e-6 * Math.max(1, explicit))
    }
  })
})
