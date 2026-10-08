import { additiveOutlierStatistics, additiveOutliers } from '../correlatedNoise'
import { lineBasis, noiseModel, nullDesign } from './ringGls'
import type { LineBasis, LineNoise, LineRecord } from './ringGls'
import type { NullFit } from './ringLikelihood'
import { cornerDeficit } from './ringRegressors'
import { DETECTION_ALPHA } from './types'

// Additive outliers of a traced line: a speck of dust or a hair on the scan displaces single
// readings of the trace far beyond the scan noise. They are found by additive-outlier detection in
// AR noise (W. Chang, G. C. Tiao and C. Chen, Technometrics 30, 1988; C. Chen and L.-M. Liu, JASA
// 88, 1993; correlatedNoise.additiveOutlierStatistics): each read sample's statistic is taken from
// the whitened innovations of the line's null fit against the fit's own innovation scale and
// compared with the Bonferroni critical value at DETECTION_ALPHA. A sample found is set aside, not
// deleted: it becomes an unread position of the line's lattice, which the segment Burg fit and the
// Kalman filter of the whitening skip (Jones 1980). Treating an observation as missing gives the
// same estimates as estimating its outlier effect jointly with the model (V. Gomez, A. Maravall
// and D. Pena, "Missing observations in ARIMA models: skipping approach versus additive outlier
// approach", Journal of Econometrics 88, 1999), so the analysis that follows on the cleaned line,
// which fits every model again, is the joint estimation. The null fit is the model of both
// hypotheses of every later test, so the cleaning favours neither. A ring the null fit leaves out
// is absorbed by its AR noise model, which predicts a decaying sinusoid from the samples before
// it, so a ring does not pose as an outlier.

/** A line's window without the samples at the given indices: they become unread positions. */
export function withoutSamples(rec: LineRecord, drop: readonly number[]): LineRecord {
  const dropped = new Set(drop)
  const keep: number[] = []
  for (let i = 0; i < rec.tS.length; i++) if (!dropped.has(i)) keep.push(i)
  const pick = (x: Float64Array) => Float64Array.from(keep, (i) => x[i])
  return {
    ...rec,
    tS: pick(rec.tS),
    lattice: Int32Array.from(keep, (i) => rec.lattice[i]),
    y: pick(rec.y),
    acrossImagePx: pick(rec.acrossImagePx),
    ...(rec.depositTimeS ? { depositTimeS: pick(rec.depositTimeS) } : {}),
  }
}

/** The whitened residual of a window under a line's null fit: the regression refitted by
 *  generalized least squares, the noise model (AR coefficients, variance-function slope) and the
 *  corner-model scale held at the null fit's. */
function heldNullResidual(rec: LineRecord, h0: NullFit): { residual: Float64Array; noise: LineNoise } {
  const basis = lineBasis(rec)
  const deficit = cornerDeficit(rec, basis.cornerModel, h0.tauS)
  const shape = { coefficients: h0.noise.fit.coefficients, noiseVariance: 1 }
  const noise = noiseModel(basis, shape, h0.noise.varianceSlope, deficit)
  return { residual: nullDesign(basis, noise, h0.tauS).yr, noise }
}

/**
 * The additive outliers of one line (indices into its window's samples, ascending), judged against
 * its null fit `h0` on its basis without patterns under the flow-lag corner model. The detection
 * runs with the null fit's noise model held (Chen and Liu 1993, s3, the inner loop): the samples a
 * pass flags are set aside, the regression and the innovation scale are estimated again without
 * them, and the next pass looks again, until a pass flags nothing.
 */
export function lineAdditiveOutliers(basis: LineBasis, h0: NullFit): number[] {
  const rec = basis.rec
  const flagged: number[] = []
  for (;;) {
    const current = flagged.length > 0 ? withoutSamples(rec, flagged) : rec
    const { residual, noise } = flagged.length > 0 ? heldNullResidual(current, h0) : { residual: h0.design.yr, noise: h0.noise }
    const statistic = additiveOutlierStatistics(noise.whitener, residual, noise.scale)
    const found = additiveOutliers(statistic, current.lattice, h0.order, DETECTION_ALPHA)
    if (found.length === 0) return flagged
    // Indices of the current window back to the original window's samples.
    const dropped = new Set(flagged)
    const original: number[] = []
    for (let i = 0; i < rec.tS.length; i++) if (!dropped.has(i)) original.push(i)
    for (const i of found) flagged.push(original[i])
    flagged.sort((a, b) => a - b)
  }
}
