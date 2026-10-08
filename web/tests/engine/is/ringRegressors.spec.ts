import { describe, expect, it } from 'vitest'
import { cornerColumns, driftBasis, flowLagColumns, flowLagRegressor } from '../../../src/engine/is/ringRegressors'

const MOTION = { cornerSpeedMmS: 20, speedMmS: 150, accelMmS2: 3000 }

describe('driftBasis', () => {
  it('spans the drift band with floor(2 T W) + 1 cosine regressors', () => {
    // W = 20 / 3 Hz. T = 0.31 s: 2 T W = 4.1333, so 5 regressors; T = 0.1 s: 1.3333, so 2
    // (hand-computed).
    expect(driftBasis(Float64Array.from([0, 0.1, 0.2, 0.31]))).toHaveLength(5)
    expect(driftBasis(Float64Array.from([0, 0.05, 0.1]))).toHaveLength(2)
  })
  it('keeps the constant and the linear-trend regressor on a very short record', () => {
    // T = 0.01 s: 2 T W = 0.13, which would leave the constant alone.
    expect(driftBasis(Float64Array.from([0, 0.005, 0.01]))).toHaveLength(2)
  })
  it('starts with the constant and a half cosine over the record', () => {
    const [c0, c1] = driftBasis(Float64Array.from([1, 1.05, 1.1]))
    expect(Array.from(c0)).toEqual([1, 1, 1])
    // cos(0), cos(pi / 2), cos(pi).
    expect(c1[0]).toBeCloseTo(1, 12)
    expect(c1[1]).toBeCloseTo(0, 12)
    expect(c1[2]).toBeCloseTo(-1, 12)
  })
})

describe('flowLagRegressor', () => {
  it('matches a numerical integration of the first-order lag at a 40 ms time constant', () => {
    // Corner 20 mm/s, tier 150 mm/s, 3000 mm/s^2 (ramp ends at 43.3 ms). Reference values by
    // fourth-order Runge-Kutta integration of tau q' = v(t) - q from q(0) = 20 in 1 us steps
    // (Python): q / v - 1 = 0 at t = 0, -0.5308781 at 10 ms (on the ramp), -0.1283489 at 100 ms.
    const r = flowLagRegressor(Float64Array.from([0, 0.01, 0.1]), MOTION, 0.04)
    expect(r[0]).toBeCloseTo(0, 12)
    expect(r[1]).toBeCloseTo(-0.5308781, 7)
    expect(r[2]).toBeCloseTo(-0.1283489, 7)
  })
})

describe('flowLagColumns', () => {
  it('adds the homogeneous solution c e^(-t / tau) / v(t) for a free flow state at the corner', () => {
    // At t = 0: 20 / 20 = 1. At 10 ms: 20 e^(-0.25) / 50 = 0.3115203 (hand-computed).
    const [particular, homogeneous] = flowLagColumns(Float64Array.from([0, 0.01]), MOTION, 0.04)
    expect(particular[1]).toBeCloseTo(-0.5308781, 7)
    expect(homogeneous[0]).toBeCloseTo(1, 12)
    expect(homogeneous[1]).toBeCloseTo(0.3115203, 7)
  })
})

describe('cornerColumns', () => {
  it('builds the bead-drag lobe exp(-s / lambda) of the commanded arc length', () => {
    // Corner 100 mm/s, tier 150 mm/s, 3000 mm/s^2: at 0.01 s on the ramp s = 1 + 0.15 = 1.15 mm;
    // at 0.02 s, past the ramp end (1/60 s, 2.08333 mm), s = 2.58333 mm. With lambda = 1 mm the
    // lobe is e^-1.15 = 0.316637 and e^-2.58333 = 0.075522 (hand-computed).
    const motion = { cornerSpeedMmS: 100, speedMmS: 150, accelMmS2: 3000 }
    const [lobe] = cornerColumns(Float64Array.from([0.01, 0.02]), motion, 'bead-drag', 1)
    expect(lobe[0]).toBeCloseTo(0.316637, 6)
    expect(lobe[1]).toBeCloseTo(0.075522, 6)
  })

  it('builds the two flow-lag columns for the flow-lag model', () => {
    const motion = { cornerSpeedMmS: 100, speedMmS: 150, accelMmS2: 3000 }
    expect(cornerColumns(Float64Array.from([0.01, 0.02]), motion, 'flow-lag', 0.03)).toHaveLength(2)
  })
})
