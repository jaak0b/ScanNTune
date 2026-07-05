import { Matrix, QrDecomposition } from 'ml-matrix'
import type { AffineModel, GridCorrespondence } from './types'
import { median } from './math'

// Solves the over-determined system mapping nominal millimetres to measured pixels:
//   px = a*mx + b*my + tx
//   py = c*mx + d*my + ty
// The X and Y rows share the same per-point weights, so two 3-parameter fits suffice. The 2x2
// linear part is then decomposed into per-axis scale and the skew (departure from 90).
//
// The fit is robust by default (iteratively reweighted least squares with a Huber weight on each
// ring's residual), so a hole whose centre was corrupted by stringing/shadow is down-weighted
// instead of dragging the whole fit. With clean data no point is down-weighted, so it reduces to
// ordinary least squares.

export interface AffineSolverOptions {
  robust?: boolean
  // The residuals weighted here are 2D norms, so the tuning constant is set on the Rayleigh
  // distribution those norms follow under isotropic Gaussian noise: sqrt(2*ln 20) ~ 2.4477 is the
  // Rayleigh 95th percentile (per-axis sigma units), the 2D analogue of Huber's 1D 1.345. A
  // distribution property, not a value fitted to any scan.
  huberTune?: number
  iterations?: number
}

export function solveAffine(
  correspondences: readonly GridCorrespondence[],
  options: AffineSolverOptions = {},
): AffineModel {
  const robust = options.robust ?? true
  const huberTune = options.huberTune ?? 2.4477
  const iterations = options.iterations ?? 4

  const n = correspondences.length
  if (n < 3) throw new Error(`Need at least 3 correspondences, got ${n}.`)

  const design: number[][] = new Array(n)
  const px = new Array<number>(n)
  const py = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const c = correspondences[i]
    design[i] = [c.nominalXmm, c.nominalYmm, 1.0]
    px[i] = c.measuredXpx
    py[i] = c.measuredYpx
  }

  const weights = new Array<number>(n).fill(1.0)
  let cx = weightedSolve(design, px, weights)
  let cy = weightedSolve(design, py, weights)

  if (robust) {
    for (let iter = 0; iter < iterations; iter++) {
      if (!updateWeights(design, px, py, cx, cy, weights, huberTune)) break
      cx = weightedSolve(design, px, weights)
      cy = weightedSolve(design, py, weights)
    }
  }

  const a = cx[0]
  const b = cx[1]
  const tx = cx[2]
  const c2 = cy[0]
  const d = cy[1]
  const ty = cy[2]

  const scaleX = Math.sqrt(a * a + c2 * c2)
  const scaleY = Math.sqrt(b * b + d * d)

  // Skew is the measured corner-angle error (X/Y angle minus 90). Positive = opened past square,
  // negative = closed (part sheared x' = x + t*y). The firmware shear factor is the negation of
  // this error; that conversion lives in the correction formatter. The dot product is invariant
  // under rotation and reflection, so the sign holds at any pose, mirrored or not.
  let cosBetween = (a * b + c2 * d) / (scaleX * scaleY)
  cosBetween = Math.min(1.0, Math.max(-1.0, cosBetween))
  const skewDegrees = (Math.acos(cosBetween) * 180) / Math.PI - 90.0

  // Report the UNWEIGHTED RMS over every hole: a non-affine defect (gantry warp, thermal bow)
  // shows up only here, so down-weighting the very holes that reveal it would hide it. On clean
  // data all weights are 1, so this equals the ordinary least-squares residual.
  let sumSq = 0
  for (let i = 0; i < n; i++) {
    const p = correspondences[i]
    const ex = a * p.nominalXmm + b * p.nominalYmm + tx - p.measuredXpx
    const ey = c2 * p.nominalXmm + d * p.nominalYmm + ty - p.measuredYpx
    sumSq += ex * ex + ey * ey
  }
  const rms = Math.sqrt(sumSq / n)

  return {
    scaleXPxPerMm: scaleX,
    scaleYPxPerMm: scaleY,
    skewDegrees,
    rmsResidualPx: rms,
    pointCount: n,
    a,
    b,
    c: c2,
    d,
    tx,
    ty,
  }
}

function weightedSolve(design: number[][], target: number[], weights: number[]): number[] {
  const n = design.length
  const wDesign: number[][] = new Array(n)
  const wTarget: number[][] = new Array(n)
  for (let i = 0; i < n; i++) {
    const s = Math.sqrt(weights[i])
    wDesign[i] = [design[i][0] * s, design[i][1] * s, design[i][2] * s]
    wTarget[i] = [target[i] * s]
  }
  const qr = new QrDecomposition(new Matrix(wDesign))
  const solution = qr.solve(new Matrix(wTarget))
  return [solution.get(0, 0), solution.get(1, 0), solution.get(2, 0)]
}

// Recomputes Huber weights from the current residuals. Returns false (leaving weights unchanged)
// when the residual scale is ~0, i.e. a clean fit with nothing to down-weight.
function updateWeights(
  design: number[][],
  px: number[],
  py: number[],
  cx: number[],
  cy: number[],
  weights: number[],
  huberTune: number,
): boolean {
  const n = design.length
  const residuals = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const ex = design[i][0] * cx[0] + design[i][1] * cx[1] + cx[2] - px[i]
    const ey = design[i][0] * cy[0] + design[i][1] * cy[1] + cy[2] - py[i]
    residuals[i] = Math.sqrt(ex * ex + ey * ey)
  }

  // Robust scale from the median of the 2D residual norms. Under isotropic Gaussian noise the norm
  // is Rayleigh-distributed with median sigma*sqrt(2*ln 2), so dividing by that constant makes the
  // estimate consistent for the per-axis sigma. Average the two central order statistics for even n.
  const sigma = median(residuals) / Math.sqrt(2.0 * Math.log(2.0))
  if (sigma < 1e-6) return false

  const threshold = huberTune * sigma
  for (let i = 0; i < n; i++) {
    weights[i] = residuals[i] <= threshold ? 1.0 : threshold / residuals[i]
  }
  return true
}
