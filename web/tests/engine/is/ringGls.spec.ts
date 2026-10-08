// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  fitNoise,
  lineBasis,
  noiseModel,
  nullDesign,
  olsNull,
  orthonormalBasis,
  pooledVarianceSlope,
  projectColumns,
  projectPeriodic,
  ringScratch,
} from '../../../src/engine/is/ringGls'
import type { LineRecord } from '../../../src/engine/is/ringGls'
import { arcLengthMm, periodicColumns } from '../../../src/engine/is/ringRegressors'
import { analyzeTracedLine } from '../../../src/engine/is/ringAnalyzer'
import { defaultIsTestRequest, fitSpecToPrinter } from '../../../src/engine/is/types'
import { defaultPrinterProfile } from '../../../src/engine/gcode/profileTypes'
import { simulateAxis } from '../../helpers/isTraceSim'
import { mulberry32 } from '../../../src/engine/math'

describe('pooledVarianceSlope', () => {
  it('recovers the variance ratio of two groups of innovations as e^b', () => {
    // Four innovations of square 1 at g = 0 and four of square 4 at g = 1, the mean known (no
    // columns): the likelihood is maximized where the variance ratio e^b equals the ratio of mean
    // squares, 4, so b = ln 4 = 1.386294; the likelihood ratio of b = 0 is
    // 8 ln(20 / 8) - 4 ln 4 = 1.785148 (hand-computed).
    const result = pooledVarianceSlope([{ y: [1, -1, 1, -1, 2, -2, 2, -2], columns: [], covariate: [0, 0, 0, 0, 1, 1, 1, 1] }])
    expect(result.slope).toBeCloseTo(1.386294, 5)
    expect(result.statistic).toBeCloseTo(1.785148, 5)
  })

  it('pools the lines, each with its own level', () => {
    // The same pattern on two lines whose levels differ by a factor 100 in variance: the shared
    // slope is still ln 4 and the statistic doubles.
    const result = pooledVarianceSlope([
      { y: [1, -1, 1, -1, 2, -2, 2, -2], columns: [], covariate: [0, 0, 0, 0, 1, 1, 1, 1] },
      { y: [10, -10, 10, -10, 20, -20, 20, -20], columns: [], covariate: [0, 0, 0, 0, 1, 1, 1, 1] },
    ])
    expect(result.slope).toBeCloseTo(1.386294, 5)
    expect(result.statistic).toBeCloseTo(3.570297, 5)
  })

  it('estimates the slope after the mean columns, the group means removed by restricted likelihood', () => {
    // Two groups of four at g = 0 and g = 1, each with its own mean (one indicator column per
    // group), deviations +-1 and +-2 around means 5 and -3. Each group's mean takes one degree of
    // freedom from its 4 samples, so the restricted likelihood equates the variance ratio e^b to
    // the ratio of the groups' sums of squares over their 3 residual degrees of freedom: 16 / 4,
    // b = ln 4 = 1.386294, and the ratio statistic of b = 0 is 6 ln(20 / 8) - 3 ln 4 = 1.338861
    // (hand-computed). Treating the residuals as eight free innovations would report the
    // statistic of the known-mean case, 1.785148.
    const result = pooledVarianceSlope([
      {
        y: [6, 4, 6, 4, -1, -5, -1, -5],
        columns: [
          [1, 1, 1, 1, 0, 0, 0, 0],
          [0, 0, 0, 0, 1, 1, 1, 1],
        ],
        covariate: [0, 0, 0, 0, 1, 1, 1, 1],
      },
    ])
    expect(result.slope).toBeCloseTo(1.386294, 5)
    expect(result.statistic).toBeCloseTo(1.338861, 5)
  })

  it('reports no slope and no evidence when the deficit vanishes', () => {
    expect(pooledVarianceSlope([{ y: [1, -2, 3], columns: [], covariate: [0, 0, 0] }])).toEqual({ slope: 0, statistic: 0 })
  })

  // Ten lines of 120 samples whose covariate g = e^(-i / 8) decays from the first sample, as the
  // corner deficit does, with mean columns concentrated where g is large: a constant, a ramp, g
  // itself and a decaying quadrature pair, as the corner model and a ring are. The fitted mean
  // absorbs more of the noise where those columns live, so residuals there are smaller than the
  // noise even when its variance is constant.
  function cornerShapedLines(rnd: () => number, trueSlope: number) {
    const m = 120
    const g = Float64Array.from({ length: m }, (_, i) => Math.exp(-i / 8))
    const columns = [
      Float64Array.from({ length: m }, () => 1),
      Float64Array.from({ length: m }, (_, i) => i / m),
      g,
      Float64Array.from({ length: m }, (_, i) => Math.exp(-i / 15) * Math.cos(0.6 * i)),
      Float64Array.from({ length: m }, (_, i) => Math.exp(-i / 15) * Math.sin(0.6 * i)),
    ]
    const normal = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd())
    return Array.from({ length: 10 }, (_, l) => ({
      y: Float64Array.from({ length: m }, (_, i) => 3 * columns[2][i] - l * columns[1][i] + Math.exp((trueSlope * g[i]) / 2) * normal()),
      columns,
      covariate: g,
    }))
  }

  it('keeps the false alarm rate of the constant-variance test nominal when the mean columns share the covariate shape', () => {
    // 200 replicates at a constant variance, tested at the 5% level (chi2_1 critical value
    // 3.841459): the rejection count is Binomial(200, 0.05), mean 10, and [3, 19] holds it with
    // probability 0.995. A slope estimated from the residuals as free innovations, blind to the
    // mean's leverage, rejects in 97 of these replicates and reads the slope near -0.44. The
    // slope estimate's SD is near 0.27 per replicate, so its mean over 200 replicates has a
    // standard error near 0.019, and 0.1 is five of them.
    const rnd = mulberry32(20261008)
    const results = Array.from({ length: 200 }, () => pooledVarianceSlope(cornerShapedLines(rnd, 0)))
    const rejections = results.filter((r) => r.statistic > 3.841459).length
    const meanSlope = results.reduce((s, r) => s + r.slope, 0) / results.length
    expect(rejections).toBeGreaterThanOrEqual(3)
    expect(rejections).toBeLessThanOrEqual(19)
    expect(Math.abs(meanSlope)).toBeLessThan(0.1)
  })

  it('still detects and recovers a real variance slope on the same design', () => {
    // A true slope of 1.5 (the innovation variance e^1.5 = 4.5 times larger at the corner): its
    // estimate's SD is near 0.27 per replicate, so the mean of 40 replicates lies within 0.2 of
    // 1.5 (about five standard errors). The test of b = 0 at the 0.1% level of the analysis
    // (critical value 10.827566) has a power near 0.99 here (mean statistic near 42), so at least
    // 37 of 40 replicates reject. A slope read from the residuals as free innovations comes out
    // near 0.94 on this design.
    const rnd = mulberry32(20261009)
    const results = Array.from({ length: 40 }, () => pooledVarianceSlope(cornerShapedLines(rnd, 1.5)))
    const meanSlope = results.reduce((s, r) => s + r.slope, 0) / results.length
    expect(Math.abs(meanSlope - 1.5)).toBeLessThan(0.2)
    expect(results.filter((r) => r.statistic > 10.827566).length).toBeGreaterThanOrEqual(37)
  })
})

describe('orthonormalBasis', () => {
  it("decides a column's dependence by its direction, whatever its scale", () => {
    // A constant column of norm 10 and a linear column scaled by 1e-18: the linear shape is
    // independent of the constant whatever its scale, so it adds a direction, and the same one as
    // its unscaled copy. A least squares fit absorbs any column scale in its coefficient.
    const ones = new Float64Array(100).fill(1)
    const linear = Float64Array.from({ length: 100 }, (_, i) => i - 49.5)
    const tiny = linear.map((v) => 1e-18 * v)
    const scaled = orthonormalBasis([ones, tiny])
    const plain = orthonormalBasis([ones, linear])
    expect(scaled).toHaveLength(2)
    for (let i = 0; i < 100; i++) expect(scaled[1][i]).toBeCloseTo(plain[1][i], 14)
  })

  it("drops a column that repeats an earlier one's direction", () => {
    const ones = new Float64Array(100).fill(1)
    expect(orthonormalBasis([ones, ones.map(() => 1e-18)])).toHaveLength(1)
    expect(orthonormalBasis([ones, new Float64Array(100)])).toHaveLength(1)
  })
})

describe('nullDesign', () => {
  it('carries one flow-lag direction on a cruise window, at any nearby time constant', () => {
    // After the ramp the relative flow deficit and the homogeneous term are both e^(-t / tau)
    // shapes, so the corner model adds one direction, not two. Corner 20 mm/s, tier 106 mm/s,
    // 3000 mm/s^2, tau 4.468 ms; the window starts at 81.77 ms, long after the 28.67 ms ramp, and
    // the null fit must not change its column count, nor its residual by more than rounding,
    // when tau moves by 1e-10 or 1e-8 of itself.
    const m = 576
    const dt = 25.4 / 600 / 106
    const rec: LineRecord = {
      tS: Float64Array.from({ length: m }, (_, i) => 0.08177 + i * dt),
      lattice: Int32Array.from({ length: m }, (_, i) => i),
      y: Float64Array.from({ length: m }, (_, i) => 0.004 * Math.sin(1.7 * i) + 0.002 * Math.cos(0.3 * i * i)),
      speedMmS: 106,
      cornerSpeedMmS: 20,
      accelMmS2: 3000,
      alongPxPerMm: 600 / 25.4,
      acrossImagePx: new Float64Array(m),
      acrossAxisPxPerMm: 600 / 25.4,
      lateralTowardRunUp: 1,
    }
    const basis = lineBasis(rec)
    const noise = noiseModel(basis, { coefficients: [], noiseVariance: 1.6e-5 })
    const at = (dLogTau: number) => nullDesign(basis, noise, 0.004468 * Math.exp(dLogTau))
    const base = at(0)
    expect(base.k).toBe(basis.fixedColumns.length + 1)
    for (const d of [1e-10, 1e-8]) {
      const moved = at(d)
      expect(moved.k).toBe(base.k)
      expect(Math.abs(moved.ssr - base.ssr)).toBeLessThan(1e-9 * base.ssr)
    }
  })
  it('keeps its flow-lag direction and a continuous residual while the lag decays before the window', () => {
    // Corner 20 mm/s, tier 106 mm/s, 3000 mm/s^2: the ramp ends at 28.67 ms and the window starts
    // at 49 ms, so at a time constant near 1 ms the flow-lag column has decayed by e^-20 or more
    // before its first sample and is a spike on the window's first samples. Its direction is
    // still a direction of the design at every tau, so the null fit must keep one flow-lag column
    // over the whole sweep, and its residual must move continuously with tau: a relative change of
    // 1e-6 in tau moves the residual sum of squares by far less than 1e-6 of itself.
    const m = 576
    const dt = 25.4 / 600 / 106
    const rec: LineRecord = {
      tS: Float64Array.from({ length: m }, (_, i) => 0.049 + i * dt),
      lattice: Int32Array.from({ length: m }, (_, i) => i),
      y: Float64Array.from({ length: m }, (_, i) => 0.004 * Math.sin(1.7 * i) + 0.002 * Math.cos(0.3 * i * i)),
      speedMmS: 106,
      cornerSpeedMmS: 20,
      accelMmS2: 3000,
      alongPxPerMm: 600 / 25.4,
      acrossImagePx: new Float64Array(m),
      acrossAxisPxPerMm: 600 / 25.4,
      lateralTowardRunUp: 1,
    }
    const basis = lineBasis(rec)
    const noise = noiseModel(basis, { coefficients: [], noiseVariance: 1.6e-5 })
    for (let i = 0; i <= 200; i++) {
      const tau = 0.0006 * Math.exp((i / 200) * Math.log(1.4 / 0.6))
      const here = nullDesign(basis, noise, tau)
      const moved = nullDesign(basis, noise, tau * (1 + 1e-6))
      expect(here.k).toBe(basis.fixedColumns.length + 1)
      expect(moved.k).toBe(here.k)
      expect(Math.abs(moved.ssr - here.ssr)).toBeLessThan(1e-7 * here.ssr)
    }
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
