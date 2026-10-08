import { describe, it, expect } from 'vitest'
import { solveAffine } from '../../src/engine/affineSolver'
import { skewCorrection } from '../../src/engine/correctionFormatter'
import { defaultCouponSpec } from '../../src/engine/types'
import type { GridCorrespondence } from '../../src/engine/types'

// Mirrors the non-image tests in ScanNTune.Tests/SkewSignConventionTests.cs (the fixture-based
// FixtureShearReadsPositive lands in the OpenCV phase).
const ShearDeg = 1.0
const PxPerMm = 10.0
const PitchMm = 25.0
const shearTan = Math.tan((ShearDeg * Math.PI) / 180.0)

// A perfect 5x5 grid printed by a machine that shears x' = x + t*y, then imaged: y flipped (image
// rows grow downward) and optionally x-mirrored (a face-down scan).
function shearedGrid(mirrorX: boolean): GridCorrespondence[] {
  const extentMm = 4 * PitchMm
  const pts: GridCorrespondence[] = []
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      const nx = i * PitchMm
      const ny = j * PitchMm
      const printedX = nx + shearTan * ny
      const imgX = mirrorX ? extentMm - printedX : printedX
      const imgY = extentMm - ny
      pts.push({
        col: i,
        row: j,
        nominalXmm: nx,
        nominalYmm: ny,
        measuredXpx: imgX * PxPerMm,
        measuredYpx: imgY * PxPerMm,
      })
    }
  }
  return pts
}

function firstLine(code: string): string {
  return code.split('\n')[0]
}

describe('skew sign convention', () => {
  it('+X shear reads negative in the image frame', () => {
    const m = solveAffine(shearedGrid(false))
    expect(Math.abs(m.skewDegrees - -ShearDeg)).toBeLessThanOrEqual(0.001)
  })

  it('+X shear reads negative in a mirrored image frame', () => {
    const m = solveAffine(shearedGrid(true))
    expect(Math.abs(m.skewDegrees - -ShearDeg)).toBeLessThanOrEqual(0.001)
  })

  it('Klipper correction cancels the measured shear', () => {
    const c = skewCorrection(-ShearDeg, defaultCouponSpec())
    const line = firstLine(c.code)
    const prefix = 'SET_SKEW XY='
    expect(line.startsWith(prefix)).toBe(true)
    const xy = line
      .substring(prefix.length)
      .split(',')
      .map((s) => parseFloat(s))
    expect(xy).toHaveLength(3)
    const [ac, bd, ad] = xy

    const side = Math.sqrt(2 * ac * ac + 2 * bd * bd - 4 * ad * ad) / 2.0
    const factor = Math.tan(Math.PI / 2 - Math.acos((ac * ac - side * side - ad * ad) / (2 * side * ad)))

    expect(ac).toBeGreaterThan(bd)
    expect(Math.abs(factor - shearTan)).toBeLessThanOrEqual(0.001)
  })

  // The emitted reference square side changed from baselineMm to baselineMm/sqrt(2) for Califlower
  // visual parity (owner-approved presentational change, 2026-07-10); factor-equivalence against
  // Klipper's calc_skew_factor formula is verified here for several skew values, including negative
  // and zero, so the change is checked against the firmware's own recovery math rather than pinned
  // literal strings.
  it('Klipper factor recovery matches calc_skew_factor for several skew values', () => {
    const coupon = defaultCouponSpec()
    // calc_skew_factor's side formula is degenerate at exactly zero skew (side collapses to 0), so
    // this uses a near-zero value rather than 0.0 itself; that degeneracy is inherent to the
    // formula for any square side, not something this change introduces.
    for (const skewDegrees of [-2.0, -0.3, 0.01, 0.3, 2.0]) {
      const c = skewCorrection(skewDegrees, coupon)
      const line = firstLine(c.code)
      const prefix = 'SET_SKEW XY='
      expect(line.startsWith(prefix)).toBe(true)
      const [ac, bd, ad] = line
        .substring(prefix.length)
        .split(',')
        .map((s) => parseFloat(s))

      const side = Math.sqrt(2 * ac * ac + 2 * bd * bd - 4 * ad * ad) / 2.0
      const factor = Math.tan(Math.PI / 2 - Math.acos((ac * ac - side * side - ad * ad) / (2 * side * ad)))
      const expected = Math.tan((-skewDegrees * Math.PI) / 180.0)
      // 1e-5, not 1e-9: the emitted values are formatted to 3 decimal places (upTo3), so the
      // recovered factor carries that rounding error, not full floating-point precision.
      expect(Math.abs(factor - expected)).toBeLessThanOrEqual(1e-5)
    }
  })
})
