// Shared sub-pixel edge primitive used by the measurement stages (the PA line-width profiler and
// the EM gap measurer). The estimate is the first moment (centroid, center-of-gravity) of the
// gradient magnitude in a window around a seed sample. For a symmetric edge-spread function the
// gradient centroid is the true edge position, and unlike a parabolic fit of the gradient peak it
// stays continuous where bilinear resampling makes the gradient piecewise constant (flat plateaus),
// where a parabola quantizes the edge to whole pixels.

// Half-window, in pixels, over which the gradient centroid is integrated: the support of a scanned
// edge's gradient ramp. Callers convert it to samples with their own profile step.
export const EDGE_REFINE_WINDOW_PX = 2

// Gradient centroid over samples [seedK - windowSamples, seedK + windowSamples], clamped to the
// differentiable interior [lo, hi]. Returns null when the window carries no gradient weight, so the
// caller can apply its own seed as the fallback.
// Bilinear intensity at a fractional pixel position; NaN outside the image.
export function bilinear(data: Uint8Array, cols: number, rows: number, x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  if (x0 < 0 || y0 < 0 || x0 + 1 >= cols || y0 + 1 >= rows) return NaN
  const fx = x - x0
  const fy = y - y0
  const p = (yy: number, xx: number) => data[yy * cols + xx]
  return (
    p(y0, x0) * (1 - fx) * (1 - fy) +
    p(y0, x0 + 1) * fx * (1 - fy) +
    p(y0 + 1, x0) * (1 - fx) * fy +
    p(y0 + 1, x0 + 1) * fx * fy
  )
}

export function gradientCentroid(
  grad: (k: number) => number,
  seedK: number,
  windowSamples: number,
  lo: number,
  hi: number,
): number | null {
  const a = Math.max(lo, seedK - windowSamples)
  const b = Math.min(hi, seedK + windowSamples)
  let weight = 0
  let moment = 0
  for (let k = a; k <= b; k++) {
    const gk = grad(k)
    weight += gk
    moment += gk * k
  }
  return weight > 0 ? moment / weight : null
}
