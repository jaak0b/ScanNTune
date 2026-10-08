# Cross-flow unification: deliberate non-unifications

Date: 2026-07-15. Branch: feature/cross-flow-unification.

These four places look like duplication across flows but are not unified on purpose. Each is a
technical mismatch: forcing a single implementation would either change the measurement (and so
require re-validation of a method that is already the named correct one) or would generalize a
mechanism only one flow needs. Verified against the code on this branch on the date above.

Sections 5 to 8 were added on 2026-10-08 (branch fix/audit-findings) with the input shaper
redesign (ladder-only excitation, two speed tiers, correlated-noise detection). They state which of
its concerns exist only in the input shaper flow, and how the correlated-noise standard error
reached the other flows.

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

## 5. Input shaper only: the look-elsewhere detection test

`web/src/engine/is/ringAnalyzer.ts` first decides whether an axis rings at all. It maximizes the
whitened detection statistic over a grid of candidate rings (20 to 150 Hz in 1 Hz steps, times the
13 damping ratios of `ZETA_GRID`, 1,703 points) and pays for that search with the Bonferroni bound
of Dunn (1961),
`pBound = min(1, |G| P(chi2_2K >= max_G Q))`; `is/layerShift.ts` uses the same bound for its search
over the split point of a layer shift. The bound exists because the decision is taken at the best
of many tried parameter values: without it, the largest of 1,703 noise statistics would pass as a
detection far more often than the nominal rate.

No other flow takes a detection decision by searching a parameter. PA always reports an estimate,
the argmin of its score over the 16 printed lines plus a parabolic vertex, and its sweep-bracket
diagnostic is a sign test over the fixed per-line bulges, with nothing maximized. EM reports the
median of its measured bead widths and tests no hypothesis. The XY ring flow finds rings with a
geometric gate (size cluster, grid mapping, the two-ring orientation marker) and maximizes no
statistic over a parameter. With no search there is no multiplicity, so the bound has nothing to
correct in those flows.

## 6. Input shaper only: planner stops, per-line corner limits and the speed factor reset

The input shaper ladder takes a 90 degree corner on every line at that line's own corner speed,
rising from 20 mm/s to the corner speed (100 mm/s by default), well above the corner limit a
slicer prints with, because the corner's velocity step is the excitation being measured. Three
mechanisms in `web/src/engine/is/firmwareMotion.ts` and `is/gcodeGenerator.ts` keep that safe and
the measurement honest:

- Per-line corner limits (`junctionLimitCommands`): after a line's prime move is queued, the limit
  is raised to that line's corner speed, and after the line's coast it is lowered back to the
  profile value, so every move that starts from rest (travel, prime, wipe) starts under the
  profile's own limit, as in a normal print.
- Planner stops (`PLANNER_STOP`, `G4 P0`) before each travel, prime and wipe: the planner drains to
  standstill, so each corner kick lands on a motor at rest and never on a rotor still oscillating
  from the previous kick, and no reversal junction is taken at speed.
- The speed factor reset (`SPEED_FACTOR_RESET`, `M220 S100`): the analysis converts distance to
  time with the commanded speeds (section 7), and a persisted speed factor s would scale every
  feed rate, so the frequency would read as f / s on both speed tiers alike, which the speed check
  cannot detect.

PA and EM have none of these concerns. Their test lines are straight: a PA line is three colinear
extrusions (slow, fast, slow), an EM line a single straight bead, so no corner is taken at test
speed and both print under the profile's own acceleration and corner limit from the shared
`motionLimitCommands`, with nothing raised and no kick to isolate. Neither depends on the absolute
speed either. Pressure advance K is the time constant of the linear nozzle-pressure model behind
pressure advance itself (the extruder is advanced by K times the extrusion velocity, which cancels
the first-order pressure lag for any velocity profile), so a uniform speed factor scales every
line's flow step, and with it how strongly a wrong K shows, but does not move the K that cancels
the lag, which is what the argmin over the lines reads. EM's bead width is the extruded volume per
millimetre of travel over the layer height: the G-code fixes E per millimetre, a speed factor
changes only the feed rate, and the factor that does change E per millimetre (`M221`) is already
an overridden setting of the EM coupon. Neither flow converts a distance to a time, so neither
needs the reset.

## 7. Input shaper only: the commanded-distance time base

`web/src/engine/is/lineTracer.ts` maps each traced sample to a time since the corner from its
commanded coupon-frame distance, the sample's position mapped back through the fiducial affine,
and the commanded velocity profile (the trapezoid Klipper executes). This deliberately does not
convert through the card `ScaleReference`: the printed coupon carries the printer's axis scale error and the plastic's shrinkage exactly as its
fiducials do, so the affine-mapped distance is the distance the printer executed at the commanded
speed, while a card conversion would bias the frequency by the shrinkage fraction. The lateral
deviation, the ring itself, still converts through the card reference along its measurement
direction, like every other flow's true-millimetre figure.

Only the input shaper flow estimates a quantity in time (a frequency in Hz). PA positions its
transition windows in coupon-frame millimetres and reports the PA value of a printed line, EM
reports bead widths and pitches in true millimetres through the card (the lengths are its
measurand, so the card is the correct conversion there), and XY reports scale ratios and skew
angles. None of them has a time base to define.

## 8. Correlated-noise standard errors: adopted in PA, EM and XY exempt

The input shaper analysis models the serial correlation of neighbouring along-line samples
(`web/src/engine/correlatedNoise.ts`: Burg AR fit, AICc order selection, exact prewhitening) so
its detection and standard errors do not treat correlated samples as independent. Each other flow
was checked for the same concern.

**PA: the concern exists and was fixed.** `bootstrapSePa` in `web/src/engine/pa/paAnalyzer.ts`
resampled each line's in-window width deviations one by one. Measured on the golden scan
(`web/e2e/pressure-advance/golden/pa_0d_600dpi_black_white_black.jpg`, default spec): per line the
cleaned deviations inside the two transition windows of plus and minus 2 mm, at the profiler's
0.25 mm sample spacing (17 samples per window), 536 samples in 36 runs of consecutive samples over
the 16 lines after Hampel rejections, centred per line.

| series | lag 1 to 5 autocorrelation | AICc AR order (pooled, max 10) | integrated autocorrelation time | Ljung-Box Q(10) |
|---|---|---|---|---|
| deviation d | 0.63, 0.58, 0.61, 0.40, 0.33 | 8 | 7.6 (SE 2.1) | 815.2 |
| squared deviation d^2 | 0.40, 0.34, 0.38, 0.16, 0.09 | 10 | 3.06 (SE 0.86) | 268.6 |

The independent-sample band for a lag autocorrelation is 2 / sqrt(536) = 0.086, and the 0.999
point of chi2 with 10 degrees of freedom is 29.6. Per line (n = 31 to 34), AICc picks AR orders
from 0 to 6 for d^2 (median 3), and the per-line integrated autocorrelation time of d^2 averages
2.85 with a standard error of 0.40 across the 16 lines.

Criterion: the integrated autocorrelation time tau = 1 + 2 sum_h rho(h) (the long-run variance
ratio; Sokal's automatic window, M = 10, standard error from the Madras and Sokal 1988 variance
2 (2M + 1) tau^2 / n) is the factor by which the true variance of a mean of n correlated samples
exceeds the independent-sample value the one-by-one bootstrap reports. The RMS score averages d^2,
so its tau governs the bootstrap: 3.06 plus or minus 0.86 puts 1 more than two standard errors
away, and a variance understated about threefold (the standard error by about 1.75) is material.

Decision: the one-by-one resampling was replaced by the moving-block bootstrap (Kunsch 1989), in
the new shared module `web/src/engine/blockBootstrap.ts`. Blocks are drawn only from runs of
consecutive samples (never across a window edge or a rejected sample), and each line's block
length is chosen from that line's own squared deviations by the Politis and White (2004) rule as
corrected by Patton, Politis and White (2009); on the golden scan the per-line block lengths are 1
to 5 samples. The seedable mulberry32 stream is kept. `bestPa` is unchanged by construction (the
bootstrap runs after the point estimate): 0.03095 on the golden scan. The golden scan's `sePa`
rises from 0.00114 to 0.00234 (0.0016 to 0.0030 over bootstrap seeds 1 to 8). No band was pinned
on `sePa`: the unit regression (`tests/engine/pa/realScan.spec.ts`) and the webtest assert it
finite and positive, which still holds, and the golden's `PROVENANCE.md` records the new value.
The synthetic coverage test (40 renders, at least 34 inside `bestPa` plus or minus 1.96 `sePa`)
stays green.

**EM: exempt, the standard error is formed over physically separate blocks.**
`widthStandardErrorMm` in `web/src/engine/em/emAnalyzer.ts` groups the cleaned per-gap samples by
test block (row and block index, two rows of 9 blocks per scan with the default spec), summarizes
each block by its
median, and reports the asymptotic standard error of the median over those block medians. The
serial correlation `correlatedNoise.ts` models is between neighbouring samples along one feature;
in EM it lies inside a block, and the block median absorbs it before the standard error is formed.
The block medians come from physically separate prints (different beads at different pitches,
separated by the block separators), which is the replication unit by design: their spread is
meant to carry the per-pitch systematic residuals. A correction for serial correlation would act
on a sample series the standard error never sees.

**XY: exempt, there are no along-line samples.** Each XY scan's figures come from the affine
fitted to about 23 ring centres, each the area centroid of a distinct ring, and the per-ring
residuals never feed a standard error. The uncertainty (`web/src/engine/scanCombiner.ts`) is formed
across N of at least 4 separate scans of the plate at different angles, each contributing one
scale pair and one skew observation to a feasible GLS fit with hat-matrix degrees of freedom.
Separate scans are separate acquisitions; no series of neighbouring samples exists whose serial
correlation could enter.
