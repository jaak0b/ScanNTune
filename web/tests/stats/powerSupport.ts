import { isCouponGeometry } from '../../src/engine/is/couponGeometry'
import { DETECTION_GRID_SIZE } from '../../src/engine/is/ringAnalyzer'
import { DETECTION_ALPHA } from '../../src/engine/is/types'
import type { IsTestSpec } from '../../src/engine/is/types'
import type { SimNoise } from '../helpers/isTraceSim'
import { chiSquareCritical, measuredNoncentralityPerMm2, noncentralityForPower } from './statsSupport'

/**
 * The detection threshold amplitude of the coupon's simulated (Y) axis: the top-rung ring
 * amplitude at which the production statistic at the true point, a noncentral chi2 with two
 * degrees of freedom per line, exceeds the axis's Bonferroni critical value with probability
 * 0.95. The noncentrality per squared millimetre is measured on 20 pilot replicates at 0.015 mm.
 */
export function thresholdAmplitudeMm(
  spec: IsTestSpec,
  noise: SimNoise,
  frequencyHz: number,
  dampingRatio: number,
  seedBase: number,
): number {
  const lines = isCouponGeometry(spec).groups.find((g) => g.axis === 'y')!.lines.length
  const dof = 2 * lines
  const perMm2 = measuredNoncentralityPerMm2(spec, { noise }, 0.015, frequencyHz, dampingRatio, dof, 20, seedBase)
  const critical = chiSquareCritical(dof, DETECTION_ALPHA / DETECTION_GRID_SIZE)
  return Math.sqrt(noncentralityForPower(dof, critical, 0.95) / perMm2)
}
