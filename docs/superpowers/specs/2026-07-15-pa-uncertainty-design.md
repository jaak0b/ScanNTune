# PA uncertainty reporting parity: mini-design (design only, no implementation)

Date: 2026-07-15. Branch: feature/cross-flow-unification. Owner review required before any code.

## Problem

EM reports `seMm` and IS a `frequencyCi95Hz`, both derived from `medianStandardError` in
`web/src/engine/math.ts`. PA (`web/src/engine/pa/paAnalyzer.ts`) reports a bare best PA value
with no uncertainty. The PA estimate is the three-point parabolic vertex (`parabolicMinimum`)
over the per-line transition scores, where each line's score is the RMS width deviation inside
the +/- 2 mm windows around its two speed transitions (`scoreLine`).

## Options considered

1. Least-squares parameter covariance of the parabola fit. Rejected: the vertex is fit from
   exactly 3 points with 3 parameters, so the fit is exact with zero residual degrees of freedom.
   There is no residual variance to propagate; the standard covariance formula is undefined here.
2. Between-transition spread mapped through the parabola curvature. Rejected: each line has only
   two transition windows, so the replicate spread would rest on 2 samples per line. A standard
   error estimated from 2 replicates is itself so noisy as to be uninformative.
3. Nonparametric bootstrap over the per-transition window samples (Efron). Chosen.

## Chosen design: nonparametric bootstrap of the vertex

Established estimator: the nonparametric bootstrap (Efron 1979), resampling the raw width
samples and re-running the exact estimation pipeline per replicate. It requires no linearization,
no distributional assumption, and it propagates correctly through the non-smooth argmin plus
parabola composition, which is exactly why it fits here and a delta-method approach does not.

Procedure, per analysis:

1. For each of the three bracket lines (best line and its two neighbours), collect the width
   samples inside the transition windows (the same samples `scoreLine` already consumes).
2. For each bootstrap replicate: resample each line's window samples with replacement (within
   line, preserving the per-line sample counts), recompute the three RMS scores, and re-run
   `parabolicMinimum` to get a replicate PA value.
3. The reported standard error is the sample standard deviation of the replicate PA values.
   B = 200 replicates, the textbook standard for standard-error estimation (Efron and
   Tibshirani, "An Introduction to the Bootstrap", chapter 6); B is a convergence parameter of
   the published method, not a tuned constant.

Edge cases: if the best line is at the sweep boundary (no bracket, no parabola today), the
uncertainty is `null`, matching the existing behavior of skipping refinement. Clamped replicate
vertices stay in the sample (the clamp is part of the estimator being bootstrapped).

## Revision (2026-07-17): full-curve bootstrap

The bootstrap now wraps the whole estimator, not just the bracket. Per replicate, every measured
line's cleaned in-window deviations are resampled with replacement (counts preserved, steady
medians fixed), all line scores are recomputed, and both the discrete argmin and the parabolic
refinement are re-run (a replicate whose best line lands at a sweep edge contributes its discrete
value and stays in the sample). The original bracket-only variant held the argmin fixed at the
point estimate's line, so it ignored the jitter of the argmin itself and underestimated the
standard error. On the golden scan this moves sePa from 0.00101 to 0.00114 (best PA unchanged at 0.03091).

## Where it lives and how it is shown

- Module: `web/src/engine/pa/paAnalyzer.ts` computes and exposes `sePa: number | null` on the
  analysis result, next to the existing best PA value (types in `web/src/engine/pa/types.ts`).
  No new module; this is the concept's existing home.
- UI: `PaPage.vue` results mirror EM's presentation, the estimate followed by a +/- value in
  the same units (dimensionless PA, e.g. "0.042 +/- 0.004"). Raw value, own labeled row, per the
  diagnostics convention.

## Validation plan

Via the existing ground-truth renderer `web/tests/helpers/paRender.ts`:

- Accuracy guard stays: recovered PA still matches ground truth within existing tolerances.
- Coverage test: render N coupons (differing noise seeds) at fixed ground-truth PA; assert the
  ground truth falls inside recovered PA +/- 1.96 * sePa in approximately 95 percent of runs
  (with a binomial tolerance band on the count).
- Sanity monotonicity: a render with higher width noise must report a larger sePa than a clean
  render.
- Determinism for tests: the bootstrap RNG is seedable so the spec is reproducible.
