# Plate fiducial locator: unifying the triplicated plate-detect preamble

Date: 2026-07-15

## Problem

The EM, PA, and IS fiducial aligners each carry a byte-for-byte copy of the same four-stage
preamble on every threshold-band binary: find the plate as the largest external contour with a
minimum-resolution area floor, gate it by aspect ratio against the nominal coupon shape,
majority-filter the cropped plate ROI, and extract its hole contours (RETR_CCOMP children of the
re-located plate) filtered by area band and squareness. Three copies of one concept invite
divergent bug fixes.

## Canonical home

`web/src/engine/plateFiducialLocator.ts`, a new shared engine module (framework-agnostic, takes
the `cv` instance as a parameter like every engine stage).

## API

```ts
export interface PlateFiducialParams {
  /** Nominal plate outline in coupon-frame millimetres. */
  plateWidthMm: number
  plateHeightMm: number
  /** Nominal fiducial hole side length in millimetres. */
  fiducialSizeMm: number
  /** Accepted hole area as multiples of the expected fiducial area (per-flow). */
  holeAreaBand: { min: number; max: number }
  /** Optional morphological close kernel in millimetres, applied before hole extraction
   *  (per-flow policy: EM derives it from the widest comb pitch, PA uses half the fiducial
   *  size, IS closes nothing). */
  closeKernelMm?: number
}

export type PlateFiducialResult =
  | { ok: true; holes: Point[]; estimatedPxPerMm: number }
  | { ok: false; reason: string; stage: 0 | 1 }

export function locatePlateFiducialHoles(
  cv: OpenCv,
  objectWhite: Mat,
  params: PlateFiducialParams,
): PlateFiducialResult
```

`stage` keeps the aligners' existing deepest-failure reporting: 0 means no plate-sized blob,
1 means the largest blob failed the aspect gate. The two failure messages are identical across
the three flows today, so the locator owns them.

## What the locator owns

- Largest-external-contour plate find with the `MIN_ALIGN_PX_PER_MM` area floor.
- Aspect-ratio gate (10 percent relative tolerance on the long/short ratio).
- ROI crop (`roiAround`) with a margin of the larger of the close and denoise kernels, then
  `majorityFilterBinary` denoise at one fifth of the fiducial size.
- Optional morphological close (rectangular kernel, `max(3, round(closeKernelMm * pxPerMm))`).
- Re-locating the plate in the processed binary and collecting its RETR_CCOMP hole children
  gated by the area band and the squareness limit (min-area-rect long/short at most 2), with
  centroids mapped back to full-scan coordinates.

## What stays per-flow

- The threshold-band sweep and its result plumbing (each aligner's `analyzeThresholdBands`
  callback, stage numbering above 1, and result shape).
- Geometry-specific candidate selection and the affine solve: EM and PA keep
  `selectCornerHoles` + `solveFromCornerHoles`; IS keeps its hole-count gates, 3-subset
  search over `solveCornerHoleCandidates`, and the content-probe model selection on top.
- The per-flow close-kernel derivation (EM computes it from the pitch schedule) and the
  per-flow hole-area band values.

## What it must not duplicate

Nothing new is computed: the locator is an exact extraction of the existing code, reusing
`majorityFilterBinary`, `roiAround`, `MIN_ALIGN_PX_PER_MM`, and the `Point` type from
`cornerFiducialSolver`. Behavior per flow is unchanged; the render-recovery and real-scan
specs are the gate.
