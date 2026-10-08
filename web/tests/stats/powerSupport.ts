import { DETECTION_GRID_SIZE } from '../../src/engine/is/ringAnalyzer'
import { DETECTION_ALPHA } from '../../src/engine/is/types'
import type { IsTestSpec } from '../../src/engine/is/types'
import type { SimNoise } from '../helpers/isTraceSim'
import { chiSquareCritical, measuredNoncentralityPerMm2, noncentralityForPower } from './statsSupport'

/**
 * The detection threshold amplitude of a 10-line axis: the top-rung ring amplitude at which the
 * production statistic at the true point, a noncentral chi2_20, exceeds the axis's Bonferroni
 * critical value with probability 0.95. The noncentrality per squared millimetre is measured on
 * 20 pilot replicates at 0.015 mm.
 */
export function thresholdAmplitudeMm(
  spec: IsTestSpec,
  noise: SimNoise,
  frequencyHz: number,
  dampingRatio: number,
  seedBase: number,
): number {
  const perMm2 = measuredNoncentralityPerMm2(spec, { noise }, 0.015, frequencyHz, dampingRatio, 20, 20, seedBase)
  const critical = chiSquareCritical(20, DETECTION_ALPHA / DETECTION_GRID_SIZE)
  return Math.sqrt(noncentralityForPower(20, critical, 0.95) / perMm2)
}
