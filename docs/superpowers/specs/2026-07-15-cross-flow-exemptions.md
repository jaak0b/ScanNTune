# Cross-flow unification: deliberate non-unifications

Date: 2026-07-15. Branch: feature/cross-flow-unification.

These four places look like duplication across flows but are not unified on purpose. Each is a
technical mismatch: forcing a single implementation would either change the measurement (and so
require re-validation of a method that is already the named correct one) or would generalize a
mechanism only one flow needs. Verified against the code on this branch on the date above.

## 1. Per-method sub-pixel edge estimators

Three different sub-pixel estimators exist, and each is the published method matched to its
geometry:

- `web/src/engine/subpixelEdge.ts` (`gradientCentroid`): first-moment (center-of-gravity)
  gradient centroid on a 1D intensity profile. Shared by EM (`em/gapMeasurer.ts`, line edge
  positions for gap widths) and PA (`pa/lineMeasurer.ts`, line width profiles). These two flows
  measure the same thing (an isolated printed bead edge crossed perpendicular to the line), so
  they already share the one implementation.
- `web/src/engine/cardEdgeMeasurer.ts`: ISO 12233 style slanted-edge method. Pixels in a band
  around the fitted card edge are projected onto the edge normal into one densely supersampled
  edge spread function (ESF), whose gradient peak locates the edge. Correct for a long straight
  high-contrast edge where the slight scan rotation gives natural phase diversity; a single-profile
  centroid would throw that information away and be noisier.
- `web/src/engine/is/lineTracer.ts`: thresholded center-of-gravity centroid of the profile's
  deviation from local background, the standard estimator in laser-stripe and stripe-projection
  metrology. The IS flow tracks the lateral center of a wiggling extruded line (a ridge, not a
  step edge), so an edge estimator is the wrong model; the threshold stops one-sided lamp-shadow
  skirts from dragging the centroid.

Unifying these onto one estimator is a measurement change: each would stop being the named
published method for its signal shape and would need full re-validation for no gain.

## 2. Robust over-determined affine vs 3-point corner-hole solve

- The XY ring flow (`web/src/engine/affineSolver.ts`) fits the affine over roughly 23 ring
  centres by iteratively reweighted least squares with a Huber weight (QR solve via ml-matrix).
  The problem is heavily over-determined and individual centres can be outliers, so a robust
  M-estimator is the correct algorithm class.
- The plate-scanned flows (PA, EM, IS) solve the affine exactly from the 3 corner fiducial holes
  (`web/src/engine/cornerFiducialSolver.ts`, `solveAffine3` and `solveFromCornerHoles`). Three
  correspondences determine the six affine parameters exactly; there is nothing to weight and no
  redundancy to exploit.

Both are established methods for their data regime. Feeding 3 exact points through the IRLS
machinery would be pointless indirection; feeding 23 noisy centres through an exact 3-point solve
would discard redundancy and robustness. Different algorithm class by design, not duplication.

## 3. IS multi-candidate fiducial enumeration and content-probe disambiguation

All three plate flows now locate fiducial holes through the shared
`web/src/engine/plateFiducialLocator.ts` (`locatePlateFiducialHoles`), so the common concern is
unified. On top of that, `web/src/engine/is/isFiducialAligner.ts` additionally enumerates every
3-subset of hole candidates, deduplicates the resulting orientation hypotheses, and selects among
survivors by probing known plastic locations (leg run-ups) in the image, with an explicit
score-margin ambiguity rejection. This exists because the IS coupon's fiducial arm lengths are
symmetric enough that geometry alone cannot pick the orientation; PA and EM coupons have
asymmetric layouts where the geometric solve is already unambiguous. The disambiguation is a
model-selection step unique to the IS geometry (the same dual-hypothesis pattern the ring
detector uses for threshold polarity). Hoisting it into the shared locator would add dead
machinery to two flows that cannot need it.

## 4. PA has no scanPlace/partColors settings

EM, IS, and skew flows expose `scanPlace` and `partColors` via the shared `ScanPlanSettings`
fragment in `web/src/stores/createFlowSettingsStore.ts`. `usePaSettings` deliberately does not
spread that fragment (this is documented at the fragment's definition): the PA coupon is a
two-color print scanned photo side up on its own contrasting base layer, so there is no
scan-place choice (it never scans through a plate) and no part-color choice (the base/line
contrast is intrinsic to the coupon). Adding the fields would present settings with no effect.
