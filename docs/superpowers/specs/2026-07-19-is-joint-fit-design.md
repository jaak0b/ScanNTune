# Input shaper joint estimation across lines (stage A)

## Problem

The input shaper flow estimated the resonance per line and gated each line with amplitude
and fit-quality thresholds, so faint but real ringing (a few hundredths of a millimetre on
stiff printers) was refused line by line even though the lines jointly carry the resonance.

## Method

Variable projection (Golub and Pereyra 1973) global fit with shared nonlinear parameters
across records. All screened lines of one axis share (f, zeta); line i keeps its linear
parameters (c0_i, c1_i, a_i, b_i):

y_i(t) = c0_i + c1_i t + exp(-2 pi f zeta t) (a_i cos(w_d t) + b_i sin(w_d t)),
w_d = 2 pi f sqrt(1 - zeta^2), t measured from that line's fit-window start.

For fixed (f, zeta) the projected linear solve is block-diagonal: the existing per-line
variable-projection solve runs per record and the joint SSR is the sum. The search is a grid
over f (PERIODOGRAM_GRID_HZ steps, +/-20 percent band around the joint seed) times the
existing damping grid, followed by a Levenberg-Marquardt polish of (f, zeta) on the reduced
projected functional (two parameters, forward-difference Jacobian, re-solving the block
linear systems per perturbation; the Kaufman form). The joint fit is unweighted ordinary
least squares (owner decision 3).

Seed: the median of the per-line fitted frequencies of the screened lines whose ring was
individually detectable; fallback, the maximizer of the summed per-record periodograms
(the multi-record Rife and Boorstyn estimator).

Frequency standard error: asymptotic NLS covariance sigma^2 (J^T J)^-1 on the full stacked
Jacobian over all 2 + 4N parameters, dof = total samples - (4N + 2) (Seber and Wild 1989);
ci95 = 1.96 se.

## Acceptance (axis verdict)

Extra-sum-of-squares F-test between nested models (Seber and Wild 1989, ch. 5): the null is
per-line drift only (c0_i + c1_i t, linear least squares), the alternative the joint ring
model. F = ((SSR_null - SSR_ring) / (p_ring - p_null)) / (SSR_ring / (n - p_ring)) with
p_null = 2N and p_ring = 4N + 2. The axis is accepted when F exceeds the upper critical
value of F(p_ring - p_null, n - p_ring) at alpha = 0.001, computed by the standard
continued-fraction regularized incomplete beta function (Numerical Recipes betacf) added to
engine/math.ts with table-value tests. A joint (f, zeta) at a bound of its search range is
additionally refused as an unresolved optimum (forced-transient residue latches there).
The existing CI95 stopband gate (MAX_CI95_REL) applies unchanged to the joint standard
error, as do the per-tier invariance check (now per-tier joint sub-fits, owner decision 4)
and the replicate-agreement check over the informative per-line frequencies.

## Screening (excluded lines never decide the axis)

Per-line fits still run for seeds and diagnostics. Excluded from the joint fit: no
free-response window, out-of-band fits, seed/fit disagreement, damping at a bound, and a
Hampel (median/MAD, 3 robust sigmas, floored at the replicate agreement tolerance) outlier
on the per-line fitted frequency. Lines previously refused for weak ringing or low R^2
ENTER the joint fit; a line with no per-line fit enters too, carried by the joint seed.
A weak line's own fitted frequency is uninformative and feeds neither the seed, the outlier
screen, nor the replicate check. MIN_ACCEPTED_LINES is now the minimum count of lines
entering the joint fit. The per-line R^2 floor and the 4x amplitude gate no longer decide
the axis; they remain as screening labels and diagnostics.

## Rule 13 exemption

PA and EM flows measure static printed geometry where each record estimates a different
quantity (per-line PA value, per-block pitch), no shared latent parameter, pooling already
sample-level; per-record-gating concern does not exist there.
