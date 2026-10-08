# Input shaper: two-tier corner ladder and correlated-noise detection (as built)

Date: 2026-10-08. Branch: fix/audit-findings. Status: stages 1 and 2 implemented, and the document
updated for the later changes listed in section 6; the owner's test print at the default speeds is still
outstanding and is a required merge step.

This document records the input shaper flow as the code on this branch builds it. It was written from
the approved redesign, its binding amendments after the second physics review, the two implementation
reports and the code itself. Where a source and the code disagree, the code is described and a
"Changed from the plan" line says what moved. Labels such as "amendment M1" or "I11" name the binding
amendments of the physics review; each is restated in words where it is cited.

It supersedes the acceptance test of `2026-07-19-is-joint-fit-design.md`: the extra-sum-of-squares
F-test is gone, while the variable projection fit with shared (f, zeta) across lines remains. An earlier
draft redesign (detection statistics plus a resonant run-up sweep) was never committed; its sweep was
removed outright (3a297ae). The concerns that exist only in this flow, and how the correlated-noise
standard error reached the other flows, are stated in `2026-07-15-cross-flow-exemptions.md`, sections 5
to 8.

## Summary for the owner

- **What the coupon prints.** A square frame with an open window, about 115 mm across with the default
  settings and a 0.4 mm nozzle. Single test lines cross the window. Each line runs in straight, turns a
  sharp 90 degree corner and runs on straight. The corner jolts the toolhead sideways, the printer's
  frame rings like a struck bell, and the line records that ringing as a fading wiggle. Each axis gets
  10 lines: 5 at the line speed (150 mm/s) and 5 at a slower speed (106 mm/s). Within each group of 5,
  every line takes its corner at a different speed, rising from 20 mm/s to the corner speed (100 mm/s),
  so some lines ring clearly on any printer, stiff or soft.
- **How the scan becomes a frequency.** The app follows the centre of each line in the scan to a
  fraction of a pixel and records how far it wiggles sideways. The printer was told exactly how fast to
  move, so each point's distance from the corner converts into the moment the nozzle passed it, and the
  wiggle along the line becomes a wiggle over time. Wiggles per second is the resonance frequency. The
  distances are read off the printed coupon itself (through its three holes), so a printer that prints
  slightly large or plastic that shrinks no longer shifts the frequency.
- **How the app decides it is ringing.** Neighbouring points along a scanned line are not independent
  (the scanner blurs them together), so the app first learns each line's own noise pattern and filters
  it out exactly. It then tries 1,703 combinations of frequency and damping and pays for having tried
  that many, so scanner noise and bead roughness alone pass as ringing at most 1 time in 1,000. It also
  checks that the wiggle grows with the corner speed, the way a real ring does and a fan or a scanner
  pattern does not.
- **Why two speeds.** Real ringing belongs to the machine and keeps its frequency at any line speed.
  Patterns that sit in the print or the scan (belt teeth, scanner compression blocks) are fixed in
  distance, so their apparent frequency changes in step with the speed. The slower speed was chosen so
  that, at the weakest precision the app accepts, a real ring would be confirmed 95% of the time and a
  pattern would pass at most 0.1% of the time. Each speed has only half the lines, though, so a real
  ring at that precision is confirmed only about 60% of the time, an open item (section 5). With two
  speeds printed, an axis is refused when its frequency changes with the speed; a check that cannot
  confirm the ring does not refuse it.
- **How the motors are protected.** No safe corner speed can be computed, because it depends on motor
  torque, step angle and moving mass, none of which the printer profile records. Instead: 100 mm/s stays
  the default, with a warning above it but no hard limit; the fastest corners print last in every layer,
  so a skipped step cannot shift lines printed before it; the printer comes to a full stop between lines,
  so a corner never hits a motor still shaking from the previous one; and only the test corners run
  above the profile's own corner limit, while travels, line starts, wipes and the frame run at the
  profile's own corner limit and acceleration like a normal print. A layer shift that happens anyway is reported
  in the results.

## 1. Coupon and motion design

### 1.1 Layout

The coupon (`web/src/engine/is/couponGeometry.ts`) is a frame band with three fiducial holes and a solid
origin corner (the plate-flow convention), around an open window. Each axis has one group of lines. A
line starts one inset inside the coupon's outer edge, un-retracts standing still and prints its first
3 mm stretch as an ordinary bead inside the band (section 1.8), runs into the window as its run-up at its corner speed, turns the 90 degree ringing corner, crosses the window as the
measured segment at its tier speed, and ends in the opposite band with a deceleration tail, a coast and
a wipe. The Y group runs up in +Y and measures in +X; the X group runs in along -X and measures in -Y.
Corners sit on anti-staggered diagonals so no leg crosses a measured segment of its own group. The two
groups cross each other only beyond both lines' protected spans (the acceleration ramp from the rung to
the tier speed plus the clean read length) plus one inner margin; the window interior is derived exactly
from that constraint with no padding.

Each layer prints the band perimeters, then the test lines, then the band raster, which irons the leg
stretches, weld tips and stop blobs flat. The coupon has one pedestal layer at the narrower pedestal
width and one measured layer (`IS_MEASURED_LAYERS = 1`), optionally on a contrast base with a filament
swap pause. Pedestal lines run at no more than the profile's first layer speed.

The resonant run-up sweep is removed (3a297ae): it swung an axis the lateral trace of its group cannot
see, gave each frequency only one cycle, and its cells at 100 Hz and above were only one or two
microsteps deep. The corner's velocity step is broadband and leaves a residual ring of about dv / omega,
which beats an acceleration-limited swing (about a / omega^2) at high frequency. Stored settings that
still carry the sweep keys load, and the keys drop.

### 1.2 Two interleaved speed tiers

Each axis prints a ladder of lines at two speeds: the line speed v and the derived slower tier
`speedTiersFor(v) = [floor(v / rho), v]` (`web/src/engine/is/types.ts`). The ratio is derived from the
detection level and the confidence gate, not chosen:

    rho = exp((z_0.999 + z_0.95) * sqrt(2) * MAX_CI95_REL / z_0.975) = 1.40728

At the weakest measurement the confidence gate accepts (95% halfwidth of 10% of the frequency, so a
relative standard error of 0.1 / 1.96 per tier), the difference of two independent log frequencies has
the standard error sqrt(2) * 0.1 / 1.96 (delta method). A one-sided z test separates hypotheses ln(rho)
apart at level alpha = 0.001 with power 0.95 when ln(rho) = (z_(1-alpha) + z_(1-beta)) times that
standard error, the standard power relation. With the default 150 mm/s the tiers are [106, 150] (actual
ratio 1.415, never below rho because of the floor). The second tier is always slower, never faster, so
it never raises flow or motion demands above what the user entered. Two tiers need a line speed of at
least ceil(20 * rho) = 29 mm/s; below that the slower tier would fall under the 20 mm/s bottom rung and
is dropped automatically with a worded note (`fitTiersToLadder`).

The power 0.95 is the design target, not what the check achieves. The derivation takes each tier's
relative standard error to be the gate's 0.1 / 1.96, but each tier is fitted from half of the axis's
lines, so its standard error is about sqrt(2) times that of the axis estimate the gate judges. At the
weakest accepted measurement s_d is then about 0.102 and the power about 0.60. Closing that gap is an
open item of the coupon redesign (section 5).

The tiers are interleaved, not blocked (amendment I7). Field slot k sits k pitches from offset zero;
rung j occupies slots 2j and 2j + 1, slower tier first on even rungs and faster tier first on odd rungs
(ABBA counterbalancing, Fisher's blocking principle). Both tiers then sample the same positions along
the ringing axis, so a position-dependent machine property, such as belt stiffness changing towards a
travel end, cannot read as a speed effect. With an even line count the tiers' mean offsets are equal;
with an odd count they differ by one pitch divided by the line count (0.5 mm at 5 lines), the least any
assignment to a uniform pitch grid can reach. The field extent is (2n - 1) pitches.

Changed from the plan: the redesign placed the two tiers as two blocks 14.5 mm apart with a 2 mm block
gap; the interleave removes the gap and makes the default coupon smaller (section 1.10).

### 1.3 Corner-speed ladder and print order

Each tier's lines take their corner at geometrically spaced rungs from 20 mm/s
(`MIN_CORNER_SPEED_MM_S`) up to the tier's ladder top, the smaller of the corner speed and the tier
speed (`tierLadderTopMmS`), one rung per line: the step-excitation idea of Klipper's ringing tower, so
the print self-ranges. The default rungs are 20, 29.91, 44.72, 66.87 and 100 mm/s on both tiers. The
run-up cruises at the rung straight into the corner, which the raised corner limit (section 1.5) passes
with no deceleration, so the corner dumps no nozzle pressure and the bead stays continuous.

Lines print in rung-major order (`linePrintOrder`): corner speed ascending, ties broken by group (Y
first) and then by tier (slower first). With the default ladders every layer therefore starts with the
four 20 mm/s lines (Y slow, Y fast, X slow, X fast) and ends with the four top-rung corners, the hardest
motor kicks, so a step loss there cannot shift any line printed before it. Line positions do not depend
on the order;
`crossingsMm` records each line's crossings with earlier-printed lines of the other group, all beyond
the protected spans.

### 1.4 Lines per speed from bead followability

The number of lines per speed is derived (`ladderLinesPerSpeed`, `followableRungCount`,
`ringPathMinRadiusMm` in `types.ts`). The bead edges are the path's offset curves at plus and minus half
the bead width, and an offset curve stays regular only while the path's radius of curvature exceeds the
offset (Farouki and Neff, "Analytic properties of plane offset curves", CAGD 7, 1990); below that the edge
folds and the traced centreline stops following the nozzle. For a ring at F_MAX = 150 Hz the radius at
the crests is R(s) = u^2 / (A omega^2), evaluated every 0.1 mm from the first traced sample (1 mm past the
corner) to the end of the protected span, with

- A(t) = (c / omega) e^(-zeta omega t), the ring the corner's velocity step c leaves;
- u = min(v, sqrt(c^2 + 2 a s)) - c e^(-zeta omega_a t), the commanded along-track speed after the
  corner, lowered by the along-track axis' own ring (omega_a at F_MIN = 20 Hz, its slowest decay);
- zeta = 0.1, Klipper's `DEFAULT_DAMPING_RATIO` (shaper_defs.py), because the coupon is generated before
  the damping is known and Klipper designs shapers for the same assumed value.

A rung is followable when the smallest R exceeds half the nominal bead width (nozzle times 1.05). The
slowest tier binds. The line count is the smallest n from 3 to 15 that leaves at least 3 followable rungs
(`MIN_ACCEPTED_LINES`) on the slowest tier; when none does, 3 is used and `bandTopWarning` tells the user
to raise the line speed or the acceleration to read a resonance near 150 Hz. Results: 5 for the default
profile, 6 for a 0.6 mm nozzle, 7 at 1000 mm/s^2.

Changed from the plan: the redesign derived the count from the slow tier's cruise speed (a closed form
that gave 7 for a 0.6 mm nozzle); amendment I9 moved it onto the commanded speed profile after the
corner, which the code implements with the Klipper design damping above. There is no longer a Lines per
speed setting (section 4), and `IsTestRequest` no longer accepts a fixed count (a0f9ee1): the count is
always derived.

### 1.5 Per-line corner limits

`junctionLimitCommands(cornerSpeed)` in `web/src/engine/is/firmwareMotion.ts` is the single
home of the mapping from a corner speed to the firmware's corner limit, used both to raise the limit for
a test line and to set the profile's own value back. Values are rounded up to 3 decimals, so the printed
limit never brakes the commanded corner.

- **Klipper:** `SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=c`. A 90 degree junction entered at or below the
  square corner velocity passes unbraked; the command does not flush, and each queued move keeps the
  junction deviation current when it was queued.
- **Marlin and RepRapFirmware:** removed on 2026-10-08 by owner decision; the app supports Klipper only.

Per line and per layer the generator emits: planner stop, travel, the stationary un-retract, planner
stop, the first stretch, the raise to the line's commanded corner feed (round(60 c) / 60, and on the
pedestal min(c, first layer speed)), the run-up, the measured segment, the tail, the coast, planner
stop, the lower back to the profile's square corner velocity, and the wipe with its retract. The raise is emitted only once the first stretch is queued: its
junction with the run-up is colinear, so the raised value governs the ringing corner alone, and every
move that starts from rest (travel, first stretch, wipe) starts under the profile's own limit as in a
normal print.

The per-line scheme came from Marlin's classic-jerk planner (amendment M1). Marlin support was removed
on 2026-10-08 by owner decision; the app supports Klipper only.

Changed from the plan: the redesign raised the limit once for the whole line phase (its motor-safety
item d); amendment M1 replaced that with the per-line raise and lower.

### 1.6 Planner stops, speed factor reset, acceleration

- **Planner stops** (`PLANNER_STOP = 'G4 P0'`), three per line per layer as listed above. Klipper's G4
  flushes the lookahead queue to zero velocity (toolhead.dwell, get_last_move_time, lookahead.flush).
  Every corner kick lands on a motor at rest, never on a rotor still oscillating
  from the previous kick, and the old 180 degree wipe reversal at speed is gone.
- **Speed factor reset** (`SPEED_FACTOR_RESET = 'M220 S100'`, amendment M2) in the motion block. A persisted speed factor s scales every commanded feed rate, so the frequency would read
  as f / s on both tiers alike, which the speed check cannot detect. `IS_OVERRIDDEN_SETTINGS` gains the
  speed factor, so the end-of-print comment says it resumes with the next firmware restart (the coupon
  pages show no restart note since 3f52bcf). This reset is in the input shaper coupon only (section 4).
- **Acceleration**: the test runs at the profile's print acceleration (f4bc3c4). The old 4000 mm/s^2
  floor, `LOW_ACCEL_MM_S2`, `MIN_ACCEL_MM_S2` and the low-acceleration warning are removed: the
  excitation is the corner's velocity step, which the acceleration does not set, and extra acceleration
  only adds motor load after each corner.
- **Motion block** (`isMotionLimitCommands`): Klipper `SET_VELOCITY_LIMIT VELOCITY ACCEL
  MINIMUM_CRUISE_RATIO=0` (plain trapezoids); then `M220 S100`; then the profile's own corner limit. The
  velocity ceiling is raised to the fastest commanded move. Input shaping and pressure advance are
  switched off before any extrusion. Nothing is restored numerically; a firmware restart brings the
  user's settings back.

### 1.7 Firmware corner caps

`fitSpecToFirmware` lowers the corner speed to what the firmware's corner limit can express at the test
acceleration, so the ladder's top rung, the ramps, the packing, the emitted limits and the analysis time
base all agree with the corner the printer actually takes.

- **Klipper:** `Move.calc_junction` also limits every junction by its approximated centripetal velocity,
  v^2 <= 0.5 d a at 90 degrees, over the shortest run-up move d = band + run-up - leg inset - prime
  (`shortestRunUpMoveMm`, 14 mm by default), floored to 0.1 mm/s (`klipperCentripetalCornerCapMmS`). It
  does not bind at 3000 mm/s^2; at 1000 mm/s^2 the band widens to 14.25 mm for the 150 mm/s tail, d is
  16.25 mm and the cap is 90.1 mm/s.
- **Marlin and RepRapFirmware:** removed on 2026-10-08 by owner decision; the app supports Klipper only.

Changed from the plan: the redesign estimated the Klipper cap at 83.7 mm/s for 1000 mm/s^2 assuming a
12 mm band and rounding to nearest; the code uses the widened band and rounds down.

### 1.8 Line start: stationary un-retract

Owner rule: no G-code is designed around a firmware limit the user can configure differently. Each line
therefore starts the way every slicer un-retracts: after the retracted travel, a stationary un-retract of
the full retraction (the shared emitter's `retract(e, p, -1)`, the profile's retract length at its
retract speed, 0.8 mm at 35 mm/s by default), a planner stop (section 1.5), then the first 3 mm of the
leg, the geometry's `prime` segment, as an ordinary bead at the line's own width (0.42 mm on the measured
layer, the 0.3024 mm pedestal width below) at 30 mm/s, capped by the first layer speed on the pedestal.
The coordinates, the planner stops, the per-line raise after this stretch and the filament each line
start restores are the same as before (defaults: 0.8 mm plus the 0.09406 mm bead on the measured layer,
0.8 mm plus 0.06473 mm on the pedestal). The un-retract's start blob lies inside the band, which the band
raster printed after the lines irons flat (section 1.1).

History: the line start used to be a moving prime that folded the 0.8 mm deretract into the 3 mm
stretch, 0.905 mm of filament over 3 mm or about 0.73 mm^2 of cross-section, above Klipper's default
`max_extrude_cross_section` of 4 x nozzle^2 (0.64 mm^2 for a 0.4 mm nozzle), so stock Klipper aborted the
print with "Move exceeds maximum extrusion" (amendment I15 b). 7a9a2d9 capped the moving prime at exactly
that default (0.639997 mm^2) and un-retracted the surplus standing still, but a review found the cap still
fails for a Klipper user whose extrusion factor is above 100% (`M221` persists), whose configured limit is
lower, or whose profile filament diameter is below printer.cfg's. The owner then removed the moving prime:
`primeOnTheMove` and `maxExtrudeCrossSectionMm2` are gone from the shared emitter, and no generator
computes anything from a firmware's default limit. Every forward extrusion of the input shaper, pressure
advance and flow coupons is an ordinary bead of about 0.08 mm^2; the cross-flow test in `emitter.spec.ts`
and the planner oracle (section 1.11) keep stock Klipper's 0.64 mm^2 check only as a sanity tripwire.

### 1.9 Bed fit and placement

`fitSpecToPrinter` is the single place a spec is fitted and the only place a tier is dropped: first the
tiers against the bottom rung, then the firmware cap, then the line count and the bed. The bed fit keeps the requested (or derived) line count and takes the longest
read length, down to 20 mm, that fits; if none fits it reduces the lines per speed towards 3, taking the
longest read length at each count; if that fails it drops the slower tier (with the note "With one tier,
the analysis cannot tell print and scan patterns apart from ringing.") and repeats both reductions. Each
reduction is described in a worded note; a bed too small for even the smallest coupon throws.

The bed depth a placement leaves comes from one shared helper, `availableBedDepthMm` in
`web/src/engine/gcode/couponShell.ts` (bed depth when centred, minus the edge margin when pushed to the
front or back), and `couponOrigin` now throws when a coupon overhangs the far bed edge (9edd4cb).
Previously a front placement on a 120 mm bed overhung the back edge silently. The flow coupon shares
`couponOrigin`, so an overhanging front or back flow coupon is refused the same way.

### 1.10 Figures

Default printer profile (Klipper, 3000 mm/s^2, 0.4 mm nozzle, 220 x 220 mm bed), default request (line
speed 150 mm/s, corner speed 100 mm/s, read length 30 mm, pitch 2.5 mm, both axes), computed from the
code:

| Case | Tiers (mm/s) | Lines per speed | Read length | Corner speed | Coupon |
|---|---|---|---|---|---|
| Default | 106, 150 | 5 | 30 mm | 100 mm/s | 114.806 mm square |
| 120 x 120 bed, centred | 106, 150 | 5 | 30 mm | 100 mm/s | 114.806 mm square |
| 120 x 120 bed, front (scan with plate) | 106, 150 | 5 | 25 mm | 100 mm/s | 109.806 mm square |
| Klipper, 1000 mm/s^2 | 106, 150 | 7 | 30 mm | 90.1 mm/s | 146.05 mm square |
| 0.6 mm nozzle | 106, 150 | 6 | 30 mm | 100 mm/s | 124.806 mm square |
| 80 x 80 bed | 150 | 4 | 23 mm | 100 mm/s | 79.683 mm square |
| Line speed 28 mm/s | 28 | 5 | 30 mm | 28 mm/s | 88.064 mm square |

The old single-tier default (8 lines at 150 mm/s, 4000 mm/s^2 floor) was 105.76 mm square. The pinned
snapshot `web/tests/fixtures/is_default.gcode` has 20 lines per layer (2 tiers x 5 lines x 2 axes), 120
planner stops and 80 per-line raise and lower lines over the two layers, `M220 S100`, and 40 line-start
un-retracts of the full 0.8 mm retraction.

Changed from the plan: the redesign expected 118.81 mm by default and a 21 mm read length on a 120 mm bed
with the front placement; the interleave (section 1.2) gives 114.806 mm and 25 mm. Amendment I6 estimated
about 15 mm of growth at 1000 mm/s^2; the derived line count rises to 7 there, so the coupon grows by
31 mm and a 120 mm bed shortens the lines or drops the tier through the bed fit.

### 1.11 Planner oracle

`web/tests/helpers/plannerReplay.ts` replays the generated G-code through a planner ported from the
Klipper sources and imports no production code. Pinned source: Klipper v0.13.0 (toolhead.py
`Move.calc_junction`, `LookAheadQueue.flush`, `SET_VELOCITY_LIMIT` without flush, `G4` through dwell to
the lookahead flush; extruder.py `calc_junction` and the `max_extrude_cross_section` check). The Marlin
and RepRapFirmware planners were removed on 2026-10-08 by owner decision; the app supports Klipper only.

`web/tests/engine/is/plannerReplay.spec.ts` runs the default coupon through Klipper on Cartesian and
CoreXY kinematics, centred and front placement, with and without contrast base: 8 cases, all passing. A 90% speed factor is
left set before each replay. Each case asserts:

- no move exceeds Klipper's default extrusion cross-section (a sanity tripwire, section 1.8);
- every ladder corner passes at its own planned rung with no braking, with a motor step equal to the
  rung on Cartesian and twice the rung on CoreXY (the reversing motor);
- the corner kicks never fall within a layer (fastest corners last);
- the raised limit covers exactly each line's run-up, measured segment, tail and coast, and every other
  junction touching those moves has a zero Cartesian velocity step;
- every move from rest starts from standstill (at or below 0.05 mm/s);
- each line's travel, first stretch and wipe begin a new planner segment (the planner came to rest);
- after every corner the nozzle covers the measured move on the analysis time base, `timeAtDistance`,
  within 1e-6 s.

The emitted `M220 S100` itself is pinned by the firmware motion and generator specs, and the matrix
guards its effect: each corner's speed and motor step, and the measured move's cruise, end speed and
timing, are compared against the coupon's planned speeds (a hand-pinned rung table, F1200 to F6000,
capped at the 30 mm/s first layer speed on the pedestal, and the line's tier speed), never against the
replayed feeds, which already include any speed factor. Removing `M220 S100` from the generated G-code
fails all 8 cases.

Self-tests cover a Klipper corner at the square corner velocity, the centripetal limit v^2 = 0.5 L a,
the cross-section flag and M220 scaling. Mutations were checked: dropping the per-line raise fails every
case, dropping the stop before the travel or before the wipe fails every case, and removing `M220 S100`
fails every case. Stated limitations, not modelled: Klipper's `limited_cartesian` and `limited_corexy`
`max_x_accel` and `max_y_accel`, the finite lookahead buffer, step quantization, and Z moves (treated as
planner boundaries; the coupon moves Z only between layers).

## 2. Analysis

The pipeline is `lineTracer.ts` (tracing and time base), `ringAnalyzer.ts` (fit window, detection,
estimation, checks, verdict), `ringRegressors.ts` (model columns), `ringGls.ts` (generalized least
squares machinery and variance function), `ringLikelihood.ts` (likelihood ratio with refitted noise),
`artifactSearch.ts` and `inputProportionality.ts` (pattern search and the proportionality test),
`layerShift.ts`, `shaperRecommender.ts`, all under `web/src/engine/is/`, plus the shared
`web/src/engine/correlatedNoise.ts`. Every decision is a hypothesis test at `DETECTION_ALPHA = 0.001`; no
amplitude threshold, fit-quality gate or damping floor decides anything (`AMPLITUDE_RESOLUTION_PX`,
`AMPLITUDE_DETECTION_K`, `ZETA_MIN`, `MIN_R2` and the F-test are removed).

### 2.1 Tracing and the time base

`traceLine` takes a perpendicular intensity profile at every sample (bilinear, 0.25 px across, a 1.0 mm
half window) and locates the bead by the thresholded centre-of-gravity of its deviation from the local
background (the median of the outer eighths of the window), with weights below half the peak deviation
zeroed (the half-maximum level of Fisher and Naidu, "A Comparison of Algorithms for Subpixel Peak
Detection"). Samples without a bead (peak deviation under 8 grey levels) are marked unread; a line with
more than 10% unread samples is dropped, not fabricated. The lateral deviation converts to true
millimetres through the card `ScaleReference` along the perpendicular (`referenceAlongDirection`).

The time base is the deliberate exception to converting through the card (1d5603d). A
sample's time since the corner comes from its commanded coupon-frame distance, the sample position
mapped back through the fiducial affine, and the commanded trapezoid `timeAtDistance` (from the rung c to
the tier speed v at a, then cruise). The printed coupon carries the printer's axis scale error and the
plastic's shrinkage exactly as its fiducials do, so the affine-mapped distance is the distance the
printer executed at the commanded speed; a card conversion biased the frequency by the shrinkage
fraction (0.5% shrinkage read 0.5% high). The tracer also exports, per sample, the scan pixels per
millimetre along the line and the nominal across-image coordinate, which the JPEG and pixel-lock
patterns need.

Klipper's ramps are exact trapezoids. The Marlin S-curve ramp-end fit window start was removed on
2026-10-08 by owner decision; the app supports Klipper only.

Changed from the plan, implementer change: the tracer samples every 1 px along the line instead of every
0.5 px. Under the scanner's optical blur a sample between two pixel columns is almost exactly the mean of
its neighbours, so half-pixel steps made the noise covariance nearly singular and the whitening amplified
the ring columns' sub-sample curvature into false detections (12% of noise-only axes on simulated 1 px
blur). The ring band lies below 0.06 cycles per pixel, so the pixel pitch loses nothing, and tracing is
about three times faster.

### 2.2 Fit window

`analyzeTracedLine` locates the free ringdown on the first half of the trace after a Gaussian regression
filter detrend (ISO 16610-21 form, cutoff period 1 / `DRIFT_CUTOFF_HZ`): the window starts at the first
zero crossing after the largest early excursion (the forced corner overshoot). Only samples the tracer actually read enter the statistics; the
tracer's linear gap fill serves the window search alone. A line without a window, or whose window leaves
no residual degrees of freedom after the null and ring columns and the largest AR order, is reported and
not fitted.

### 2.3 Line model

Per line, on its window (t seconds since the corner, s commanded arc length):

    y(t) = drift (discrete cosine basis below DRIFT_CUTOFF_HZ)
         + detected print or scan patterns (cosine and sine pairs, section 2.11)
         + corner model (flow lag of the commanded flow, or bead drag; section 2.6)
         + e^(-zeta w t) (a cos(w_d t) + b sin(w_d t)),  w = 2 pi f, w_d = w sqrt(1 - zeta^2)
         + AR(p) noise on the sample lattice, innovation scale exp(b g(t) / 2) (section 2.7)

The drift is the discrete cosine basis cos(pi k (t - t0) / T), K = floor(2 T W) + 1 columns for
W = `DRIFT_CUTOFF_HZ` = F_MIN / 3, the regression high-pass of SPM (Friston et al., "Statistical
Parametric Mapping", 2007, ch. 14). By Frisch-Waugh-Lovell it acts as one linear prefilter applied
identically to the data and every column, which settles amendment I11 b. Each line keeps its own linear
coefficients; the lines share (f, zeta) and the corner-model scale.

Changed from the plan: the redesign kept the Gaussian filter detrend of the data with a linear drift
[1, t] in the null design, and its stage 2 moved to the ISO 16610-31 robust Gaussian regression filter.
The code carries the drift as regression columns instead and uses the Gaussian filter only to locate the
window. The robust filter was not built (section 5).

### 2.4 Noise model

Each line's noise is AR(p) on the sample lattice, fitted by Burg's method (J. P. Burg, "Maximum entropy
spectral analysis", 1975) over the runs of read samples, with no prediction across an unread sample
(segment Burg, de Waele and Broersen, IEEE Trans. Signal Processing 48, 2000). The order is chosen by AICc
(Hurvich and Tsai, Biometrika 76, 1989) up to floor(10 log10 n), the default `order.max` of R's
`stats::ar`. Data and every column are whitened by the exact innovations operator
(`correlatedNoise.arWhitener`): the Durbin-Levinson predictors for the first p samples (Brockwell and
Davis, "Time Series: Theory and Methods", 1991, s5.2) and the Kalman filter of the AR state space after
each unread sample (R. H. Jones, Technometrics 22, 1980), so no sample is dropped and gap-filled values
never enter as data (amendment I11 a). Under the model the whitened residuals are iid N(0, 1) whatever
the regressor shapes. Fitting is two-step feasible generalized least squares (Aitken 1935; Cochrane and
Orcutt 1949). `unwhiten` maps whitened residuals back to raw values.

### 2.5 Detection

The per-line statistic at a point theta = (f, zeta) is the generalized likelihood ratio of the ring with
the AR noise model refitted under each hypothesis (S. M. Kay, "Fundamentals of Statistical Signal
Processing, Volume II: Detection Theory", 1998, ch. 9). Each hypothesis is fitted by iterated
Cochrane-Orcutt: GLS under the current noise model, then Burg refitted to the raw residual at the order
the null model's AICc chose, repeated while the exact Gaussian deviance falls (at most 8 refits, stopping
below a thousandth of a chi-square unit). The deviance is the exact -2 log-likelihood of the AR model on
the line's lattice (innovations form, Kalman filter for unread samples), profiled over the innovation
variance. A noise model fitted under the null alone absorbs a slowly decaying ring (a high-order AR
predicts it almost exactly); refitting under the alternative credits it in full.

The difference of deviances is scaled by the Bartlett factor (m - k1 - p) / m (M. S. Bartlett, Proc. R.
Soc. A 160, 1937), in the conditional AR form of Box and Jenkins (1970) that counts the p AR lags as
regressors next to the k1 columns of the alternative (and the variance slope when the axis has one).
Without it the 1 px blur calibration exceeded its chi-square 95% point 144 times in 2,000 (allowed 68 to
132).

The refit is costly, so each line's field over the grid holds a valid lower bound of its statistic: the
ratio with the null noise model held fixed at every grid point, and the refitted ratio at the null
spectrum's in-band peaks and wherever a maximum is taken (every maximum the analysis uses is evaluated
refitted). The axis statistic is Q(theta) = sum over the K lines, chi2_2K under H0 at a fixed point. The
grid G is 20 to 150 Hz in 1 Hz steps times 13 damping ratios (0.001 to 0.4), |G| = 1,703, and the
look-elsewhere effect is paid by the Bonferroni bound (Dunn 1961):

    pBound = min(1, |G| P(chi2_2K >= max_G Q))

The axis is detected when pBound <= 0.001; a lower bound of Q can only raise pBound, so the bound stays
valid. Each line gets its own label from the same bound on its own statistic (chi2_2); the labels feed
the seeds, the screening, the replicate check and the ladder advice, while undetected lines still enter
the joint fit.

Changed from the plan: the redesign's statistic was the whitened sum-of-squares reduction with the AR
fitted once, to the full-fit residual at each line's maximum. Amendment I11 c flagged that as
anti-conservative (the AR notches the spectrum where the statistic peaks), so stage 1 fitted the AR under
the null instead (f04e376). That version absorbed lightly damped rings (zeta 0.002 and 0.005 at 0.03 mm
were missed) and ran conservative in S1 (2 px blur 32 and red AR(2) 55 exceedances, both red). Stage 2
replaced it with the refitted likelihood ratio (be2e712).

### 2.6 Corner model

The corner leaves a disturbance after it that is not ringing. Two models compete, each with one scale
per axis searched by golden section on a log scale (Kiefer 1953) over one sample interval to the longest
window (`ringRegressors.ts`):

- **Flow lag** (amendment M3, in stage 1): with pressure advance off the extruded flow q follows the
  commanded flow through a first-order lag, tau q' = v(t) - q, the linear nozzle model behind pressure
  advance, driven by the known commanded speed (run-up at the rung, the corner, the ramp to the tier
  speed). The columns are the relative flow deficit q_tau(t) / v(t) - 1 and the homogeneous term
  c e^(-t / tau) / v(t), whose free coefficient is the flow state the corner itself disturbs.
- **Bead drag**: the bead dragged at the corner, a lobe exp(-s / lambda) decaying in commanded arc length.

The detection uses the null model with the lower pooled AICc over the axis's lines (Hurvich and Tsai
1989; the summed exact deviance plus 2 K N / (N - K - 1)). The estimation (section 2.8) uses the model
that encompasses both (flow-lag columns with tau free plus the bead-drag lobe at its null-fit length), so
the frequency interval does not rest on the AICc choice (Leeb and Potscher, "Model selection and
inference: facts and fiction", Econometric Theory 21, 2005); with the selected model alone the S3
coverage under bilinear noise fell to 178 of 200.

### 2.7 Variance function

The bead right after a corner, where the extruded flow lags the commanded flow, is rougher than the
steady bead. The innovation variance follows the multiplicative variance function log sigma_t^2 = a + b
g(t) (A. C. Harvey, Econometrica 44, 1976), with g the flow-lag deficit 1 - q / v (or the lobe shape for
bead drag), one slope b per axis. It scales the AR innovations rather than the observations, so the
whitening stays one exact lower-triangular operator and the ring columns keep their closed-form
whitening. The slope is used only when its chi2_1 likelihood ratio test rejects a constant variance at
alpha, and still rejects after each line's strongest ring candidate joins the mean model (a ring left
in the null residual also raises the early variance). Doubled early noise: 0 of 60 axes accepted
(before: 1 false acceptance); quadrupled: 21 of 40 axis detections, 0 acceptances.

The slope and its test use the pooled restricted (residual) maximum likelihood of the AR-whitened data
given each line's mean model, every line's level profiled out (Patterson and Thompson, Biometrika 58,
1971; for a variance function A. P. Verbyla, JRSS B 55, 1993), solved by Fisher scoring (G. K. Smyth,
JCGS 11, 2002). The mean model is the line's null design (and, in the ring check and the joint fit,
the ring columns at the candidate or the first-step estimate). The corner-model columns have the
covariate's own shape (the bead-drag lobe is the covariate; the flow-lag column is its negative), and
the ring sits at the corner too, so the fitted mean absorbs part of the noise exactly where g is large.
The plain maximum likelihood of the fitted residuals read that shortfall as a lower early variance:
on S3 (constant variance) the joint fit's test fired on 3 of 200 seeds, all with negative slopes, and
its mean statistic was 1.59 instead of chi2_1's 1. The restricted likelihood accounts for each
sample's leverage and the degrees of freedom the mean takes.

A slope is defined only against the covariate it was estimated on, so each line's noise model carries
that covariate (corner model, scale and values), and every rebuild of the noise model applies the slope
to it: the second-mode search, and the refits on the along-track lag's deposit times, which rebuild the
same covariate on the corrected times. Before this, the second-mode search recomputed the covariate
from the joint-fit basis (the flow-lag deficit at the joint time constant) while the joint fit had
estimated the slope on the bead-drag lobe; the misplaced weights gave a fake heavily damped mode that
replaced the ring (S3 seed 5,001,171: 101.69 Hz at damping 0.4 instead of 60.44 Hz).

Changed from the plan: the plan applied the variance function to the observations before whitening
(feasible weighted least squares) together with a robust detrend; the code applies it to the innovations
and has no robust step.

### 2.8 Estimation and frequency interval

The seed is the refitted maximum of Q over the lines entering the joint fit. The joint fit is GLS variable
projection (Golub and Pereyra 1973) over (f, zeta, log tau) with each line's noise model refitted under
the alternative at the seed, polished by Levenberg-Marquardt (Levenberg 1944; Marquardt 1963); then the
second feasible GLS step refits each line's AR (order chosen again) to the full-fit residuals, re-tests
the variance slope and fits again. zeta is bounded to [0, 0.4]. Variable projection assumes the linear
design keeps a constant rank near the solution, so a column's dependence on the earlier columns is decided
on its direction alone: each column is scaled to unit size before the decision (column equilibration,
van der Sluis 1969). A tolerance against the design's largest column instead dropped the flow-lag column
of a line whose lag decays before its window starts once tau fell below a scale-dependent edge, a jump in
the cost that Levenberg-Marquardt could not cross, so the fit stalled at its start.

The frequency interval is the 95% profile-likelihood interval (Bates and Watts, "Nonlinear Regression
Analysis and Its Applications", 1988, s6.1): the frequencies whose profile t statistic stays within
t_(0.975, dof), with zeta and tau re-optimized at every fixed f, each end found by bisection to a
hundredth of the linearized standard error. The reported halfwidth is the larger side; the reported
standard error is the interval width over twice the t quantile. The results card states that the
interval covers the statistical error of the fit only.

Changed from the plan: the plan used the linearized covariance sigma^2 (J'J)^-1. With the more powerful
detector, S3 coverage failed at three times the threshold amplitude because that standard error is too
small near the detection threshold; the profile-likelihood interval follows the actual shape of the
least squares surface (2c07f43).

### 2.9 Screening and checks

Screening: each detected line gets its own fit (seeded at its own maximum, axis tau). A line is excluded
when its frequency is within 2 Hz of a band edge or a Hampel identifier (median and MAD, 3 robust
sigmas, floored at the larger of 2 Hz and 5% of the median, the shaper's agreement band) marks it an
outlier. At least 3 lines (`MIN_ACCEPTED_LINES`) must remain. A line's own damping ratio does not
screen it: one line carries little information about the damping, so its own fit often reaches the
0.4 bound on a good trace, and the axis damping comes from the joint fit of all lines.

Checks, each at alpha = 0.001:

- **Input proportionality** (`inputProportionality.ts`, amendment M5, the gate against forced tones such
  as a part-cooling fan imbalance): the ring is the linear response to the corner's velocity step
  (output-error model, Ljung 1999), so each line's ring amplitude at the corner is its rung's speed times
  one scale per tier, through zero. The ordinary least squares fit amplitude = b0 + b_T c (one slope per
  tier, one shared intercept) and the two-sided Student t test of b0 = 0 with K - 1 - T degrees of
  freedom (Student 1908; Seber and Lee, "Linear Regression Analysis", 2003, s4.4) use the lines' own
  scatter as the error. A forced tone keeps its amplitude on every rung, its intercept carries all of it,
  and the test rejects. A failure refuses the axis.
- **Speed check** (two tiers, amendment M4): each tier is tested on its own lines only on a local grid,
  the points within 10% of the axis estimate f and of its pattern images f rho and f / rho, with the
  Bonferroni bound over that local count (closed testing, Marcus, Peritz and Gabriel, Biometrika 63,
  1976), then fitted on its own (tau held at the joint value). With d = ln(f_slow / f_fast) and the
  delta-method standard error s_d from the two tiers' standard errors: "changed with speed" when
  |d| / s_d > z_(1 - alpha/2) = 3.29; "confirmed" when the pattern hypothesis d = -ln(rho) is rejected
  one-sided, (d + ln rho) / s_d > z_(1 - alpha) = 3.09, and d = 0 is not rejected; otherwise "not
  confirmed", which includes a tier whose own detection fails. Only "changed" refuses the axis; "not
  confirmed" is reported and does not refuse (owner decision 2026-10-08, 9ace4a0; section 4). With one
  tier the check is "not assessed". The check's power against a pattern at the weakest accepted
  measurement is about 0.60, not the 0.95 the tier ratio was designed for (section 1.2).
- **Influence check** (one tier only, amendment I12): the detection must survive leaving out any single
  line (Cook 1977), so a dust speck on one line cannot carry the axis.
- **Replicate check**: Cochran's Q homogeneity test (Cochran 1954) on the inverse-variance weighted
  frequencies of the detected joint-fit lines, each fitted from the joint estimate, against chi2_(k-1);
  "not assessed" with fewer than 3 such lines.
- **Damping diagnostic**: the boundary likelihood ratio test of zeta = 0 (Self and Liang, JASA 82, 1987),
  null law 0.5 chi2_0 + 0.5 chi2_1, critical value z_0.999^2 = 9.5495, with f and tau re-optimized under
  zeta = 0. It is reported as "Decay demonstrated: yes/no" and is never a gate (amendment M5): as a gate
  it would refuse about half of real rings at zeta 0.02 and 30 Hz.
- **Guards**: the fitted frequency within 2 Hz of a band edge, and the confidence gate: the 95%
  halfwidth must stay under 10% of the frequency (`MAX_CI95_REL`), the stopband the EI shaper family
  covers.
- **Damping at the bound**: a joint damping ratio at its 0.4 bound is the fit's limit, not a
  measurement, and does not refuse the axis (055f1b3). The axis keeps its frequency, and the shaper is
  designed at Klipper's default damping ratio 0.1 (section 2.10).

Verdict order, the most specific failing gate first: band edge, speed changed, influence,
proportionality, replicate, confidence gate. Each refusal has its own worded
reason; a refusal where only the fastest-corner lines showed ringing adds the ladder advice to raise the
corner speed in small steps.

Changed from the plan, implementer change: amendment M5 specified a nested likelihood ratio test on the
per-line complex amplitudes (proportional model against free amplitudes). The code t-tests the intercept
of the amplitude magnitudes instead (fb1e5f0). The complex-amplitude test measured misfit against the
scan noise alone, so at tiny noise a model misfit of the same order on every line refused correct rings,
and it needed each line's corner-time phase, which a corner position error of hundredths of a millimetre
at a slow corner shifts by tenths of a radian. The t test uses the lines' own scatter, so such a misfit
widens the test instead, and the phase does not enter.

Changed from the plan: the redesign made the zeta = 0 test a refusal gate and checked the tiers and
replicates against a fixed max(2 Hz, 5%) tolerance; amendments M4 and M5 replaced these with the
diagnostic, the proportionality gate, the three-way speed decision and Cochran's Q. The 2 Hz or 5% band
survives only as the Hampel screening floor.

### 2.10 Second mode and shaper choice

After the joint fit a second mode is searched by sequential forward detection (Quinn and Hannan, "The
Estimation and Tracking of Frequency", 2001, ch. 5): the first mode's ring columns join every line's null
design and the same likelihood ratio field and Bonferroni bound test for a further ring at alpha. On
detection both modes are fitted jointly by variable projection over (f1, zeta1, f2, zeta2, log tau) with
a Levenberg-Marquardt polish. The axis reports the dominant mode (the larger median amplitude) and the
other as its second mode, each with its own proportionality check; the dominant mode's confidence
halfwidth then is 1.96 times its linearized standard error from the two-mode fit. When the two-mode fit
gives the dominant mode no standard error, the joint fit's interval stands in only when the dominant
mode is the joint fit's own; a dominant mode the search found then has no interval, and the confidence
gate refuses the axis (59ece65). A found mode whose damping ratio the two-mode fit places at the 0.4
bound is no measurement (the fit's limit, where frequency and damping are not identified): it never
replaces the joint fit's mode and is not reported as a second mode, so the axis keeps its single-mode
fit and the search's p-value bound stays as the diagnostic.

Shaper choice (`shaperRecommender.ts`): with one mode, every shaper (ZV, MZV, EI, 2HUMP_EI, 3HUMP_EI;
Singer and Seering 1990; Singhose, Seering and Singer) is tuned to the measured frequency and judged by
its worst residual vibration over a band of max(5%, the relative 95% halfwidth); among those within the
5% tolerance the one allowing the highest acceleration under Klipper's 0.12 mm smoothing target wins
(when none qualifies, the lowest worst residual). With a second mode whose proportionality check does
not fail (a steady tone next to the ring does not shape the spectrum the shaper must cover), the choice
follows Klipper's `shaper_calibrate.py` (`fit_shaper`, `find_best_shaper`) on a spectrum synthesized from
the fitted modes (Lorentzian lines in acceleration, added incoherently). The Marlin ZV output and its
second-mode residual were removed on 2026-10-08 by owner decision; the app supports Klipper only.

Damping ratio: with one mode the shapers are designed at the fitted damping ratio, or at Klipper's
default 0.1 when the fit sits at its 0.4 bound; with two modes every shaper is designed at 0.1, as
Klipper's `fit_shaper` does. The Klipper snippet always writes the damping ratio the shaper was designed
at, 0.1 included (0fc6cc0), because a `damping_ratio` line already in printer.cfg would otherwise stay
in effect and the firmware would build a different shaper than the one scored.

### 2.11 Print and scan patterns (order tracking) and pixel locking

`artifactSearch.ts` searches for patterns stationary in arc length: fixed along the printed path (the
mesh of a GT2 belt's teeth) or in the scan's pixels (JPEG blocks). In a line's time base they read as
undamped tones whose frequency scales with the line speed (the order-tracking view of a Campbell
diagram: W. Campbell 1924; computed order tracking, Fyfe and Munck, MSSP 11, 1997), so in arc length they
are one sinusoid shared by both tiers. The search needs two tiers; with one tier a pattern cannot be told
from a ring and no search runs.

- **Known stage**: the GT2 pitch of 2 mm and its 1 mm harmonic, the JPEG 8 x 8 px block and the 16 px
  minimum coded unit (ITU-T T.81) through the scan's pixels per millimetre along the line, each kept only
  when its frequency at the line's speed lies in the 20 to 150 Hz band; plus the tracer's pixel locking
  at harmonics m = 1 and 2.
- **Grid stage**: spatial frequencies from F_MIN / v_max to F_MAX / v_min cycles per mm, at the step
  1 Hz / v_max.

Each stage runs at alpha / 2 with the likelihood ratio summed over the lines and the Bonferroni bound over
its candidates. A candidate counts as a pattern only when every tier's own lines also show it at that
level (closed testing) and it FAILS the input proportionality test (a ring grows with the corner speed, a
pattern does not). A detected pattern joins every line's null design as fixed columns and the stage
repeats. The search runs before the corner-model choice and the detection, and again after the joint
fit with the fitted ring in the null design (a ring missed by the first search leaks into a pattern's
columns on its own tier); when that second search finds more patterns, the whole axis analysis repeats
with them.

Pixel locking (peak locking, Westerweel, Meas. Sci. Technol. 8, 1997; Prasad et al. 1992; Roth and Katz,
Meas. Sci. Technol. 12, 2001) pulls the centroid toward pixel centres as a periodic function of the
bead's sub-pixel position across the line. It is modelled by sin and cos of 2 pi m phi, m = 1 and 2, with
phi the sub-pixel phase of the bead's slow position (the nominal across-image coordinate plus the null
fit's lateral motion without the ring, one pass). On a line tilted against the pixel grid the phase
sweeps along the line and the bias reads as a tone, in band at typical placement tilts of 0.3 to 2.4
degrees at 600 dpi and 150 mm/s.

Changed from the plan: the plan put the known periods (GT2 2 mm and 1 mm, JPEG 8 and 16 px) into every
null and full model always, and regressed on the pixel-lock phase always. Always-present columns pushed
the S1 calibration to 151 to 183 exceedances (allowed at most 132), so patterns are searched and carried
only when detected (7a10ca8, 2e7603e).

### 2.12 Layer-shift diagnostic

A stepper that skips during the measured layer moves every later line sideways by the same amount.
`layerShift.ts` takes each traced line's offset (the median lateral deviation over the second half of its
trace) in print order, models it as a linear trend in the line's field slot plus a step, and applies the
likelihood ratio test for a change point in simple linear regression (Kim and Siegmund, Biometrika 76,
1989): the Student t test of the step at every split, with a Bonferroni bound over the K - 1 splits, at
alpha. It needs at least 5 lines and is reported per axis as a raw row (amendment I14); it never refuses
an axis.

### 2.13 Results shown

Per axis, raw rows (`web/src/components/isCheckRows.ts`): lines with ringing detected (k of n), detection
p-value bound, decay demonstrated, grows with corner speed, speed independence (confirmed, changed with
speed, not confirmed, not assessed), the frequency at each tier speed, replicate check, detection without
any single line (one tier), layer shift detected, the second mode's p-value bound, frequency, damping
ratio and proportionality, each detected pattern's period and source,
and the corner model with its time constant or drag length. The line table shows each line's speed and
whether ringing was detected on it.

## 3. Validation

### 3.1 Statistics suite

`web/tests/stats/` (run with `npm run test:stats`, `web/vitest.stats.config.ts`; excluded from the default
`npm test`) simulates traces with the seeded simulator `web/tests/helpers/isTraceSim.ts` (fixed seeds).
Each criterion is a binomial tail a correct implementation fails with probability about 0.001 or less,
unless stated. The suite now holds two files, both under iid scan noise on the default coupon's Y group
(c4c19a2, 3440f51):

- **`pbound-iid.stats.spec.ts`** (no false detection on pure noise): of 400 noise-only axes, at most 35
  reach pBound <= 0.05 and at most 11 pBound <= 0.01; of the first 60, at most 1 is accepted (S2).
- **`s3-iid.stats.spec.ts`** (honest frequency interval, S3): a 60.4 Hz ring at damping 0.043, off the
  detection grid's nodes, at three times the threshold amplitude; of 200 seeds at least 180 intervals
  cover the truth, and the estimates' SD over the mean reported SE lies in 0.85 to 1.15 (dd18e1e).

Current status: the S3 file is red on CI and under diagnosis (wild frequency estimates on some seeds),
so no S3 figure below describes the current code.

History: the stage 2 suite also simulated half-pixel bilinear, 1 px and 2 px blur, in-band red AR(2)
peaking at 60 Hz and per-line noise levels, and the mechanisms flow lag, bead drag, pedestal ring, an
above-band mode, early-noise inflation, impulses, belt teeth, JPEG blocks, pixel locking, a forced tone,
the along-track time warp, two modes and a position gradient. Those files were removed in c4c19a2. The
table records the stage 2 run of that suite (S3 then used a 60 Hz, zeta 0.05 truth); it was not rerun
afterwards:

| Test | What it checks | Criterion | Result |
|---|---|---|---|
| S1 (7 files) | Q at the true point (60 Hz, zeta 0.05, 10 lines) is chi2_20 under H0: 2,000 seeds | above the 95% point: 68 to 132; above the 99% point: at most 35 | iid 83/15, half-pixel 114/29, blur 1 px 116/29, blur 2 px 67/11 (RED), red AR(2) 76/15, per-line levels 87/15, 20 mm/s rung chirp 80/9 |
| pBound (5 files) | the axis Bonferroni bound rejects at most at its level: 400 nulls per noise model | at most 35 at 0.05 and 11 at 0.01; at most 1 of the first 60 accepted | iid 2/1, red AR(2) 9/4, half-pixel 4/1, blur 1 px 12/4, blur 2 px 19/7 |
| S2 (8 files) | false acceptance with no machine ringing: per-line noise levels, unread samples, belt teeth, forced 100 Hz tone, JPEG blocks, pixel locking, flow lag 20 and 60 ms, bead drag over 2 and 3 bead widths, pedestal ring, 200 Hz mode, doubled early noise, 1% impulse outliers | at most 1 of 60 each | all pass (belt teeth, JPEG, pixel locking, pedestal ring, 200 Hz mode, bead drag, doubled early noise, impulses: 0 of 60) |
| S3 (3 files) | coverage of a 60 Hz, zeta 0.05 ring at 3 x the threshold amplitude: 200 seeds | at least 180 cover; estimate SD over mean SE in 0.85 to 1.15 | iid 185 (1.005), half-pixel 182 (1.085), blur 2 px 183 (0.975) |
| S4 | power at the threshold amplitude (0.95 by design): 70 seeds | at least 60 detected (widened from 64 so a correct implementation fails at most 0.1%, amendment I11 d) | 70 of 70 |
| S5 real ring | speed check confirms a real ring at the weakest amplitude both tier tests detect: 80 seeds | at least 72 confirmed | 78 of 80 |
| S5 pattern | a pattern at both tiers is never accepted: 80 seeds | 0 accepted | 0 of 80 |
| S6 (2 files) | the zeta = 0 statistic follows 0.5 chi2_0 + 0.5 chi2_1 under an undamped ring: 200 seeds | count above 2.706 in 2 to 21 | 8 and 10 |
| S7 two modes | 45 and 62 Hz both recovered and covered: 60 seeds | at least 57 found, at least 51 covered per mode | 59 found, 53 and 54 covered |
| S7 one mode | spurious second mode on single-mode axes: 200 seeds | at most 2 | 0 |
| S8 | ring plus a pattern: ring accepted and covered, pattern identified: 60 seeds | 57, 57, 51 | 58 accepted, 58 identified, 56 covered |
| S9 | pixel locking at 0.5, 1 and 2 degrees tilt, 0.08 px | at most 1 of 60 each | 0 of 60 each |
| Proportionality power | 30 Hz, zeta 0.02, 21 mm lines, 3 x threshold: 60 seeds | gate fails at most 1, at least 57 accepted | 60 of 60 |
| Position gradient | ring frequency drifting 0.02 Hz per mm across the field (balanced tiers): 60 seeds | at least 54 confirmed (binomial 0.03 tail) | 60 of 60 |

S1 calibrates `detectionStatisticAt`, which runs the flow-lag null model without the pattern search or
the corner-model choice; the pBound, S2 and later files run the production `poolAxisFits`.

Changed from the plan: S6 runs 2 x 200 seeds with the window 2 to 21 (the plan: 400 seeds, 8 to 35); S4
passes at 60 of 70 (the plan: 64), per amendment I11 d.

### 3.2 Render recovery

`web/tests/engine/is/isAnalyzer.spec.ts` renders coupons from known ground truth (`tests/helpers/isRender.ts`)
through the real tracer and analyzer: a mirrored 0/90 degree scan pair (frequency within 1.5 Hz, damping
within 0.02), faint field-regime ringing, self-ranging ladders, a coupon with no ringing (refused by the
detection bound), replicate scatter (refused), a resonance just outside the band (refused), a wrong figure
on the unused axis of a per-axis (CCD) reference (cannot leak into the frequency), two tiers disagreeing
(refused) and agreeing (recovered), and order independence and orientation mismatch refusals. The time
base case at 75 Hz: a 0.5% shrunk coupon reads 75.010 Hz (the old card time base read 75.389 Hz), pinned
within 0.075 Hz (0.1%). The Marlin S-curve case was removed on 2026-10-08 by owner decision; the app
supports Klipper only.

### 3.3 Planner oracle and G-code

8 of 8 planner cases pass (section 1.11). The G-code snapshot `is_default.gcode` was not changed by
stage 2. `web/tests/engine/is/gcodeGenerator.spec.ts` checks, among others, that the speed factor reset
and the profile corner limit come before any extrusion, that each line raises the limit after its first
stretch and lowers it before its wipe, that the planner comes to rest three times per line, that the lines
print rung by rung, that each line un-retracts the full retraction standing still and then prints its
first stretch as an ordinary bead, that the coupon stays on
the bed and inside its footprint, and the one-tier fallbacks with their notes.

### 3.4 CI

`.github/workflows/web-ci.yml` runs the two statistics files as one `stats` job
(`npm run test:stats -- --maxWorkers=$(nproc)`, one worker per runner vCPU, 25 minute job timeout, no LFS
checkout), and only when a `changes` job finds a changed dependency of the suite (9d6d6fe). Each file is
one test with a 20 minute budget (a time budget, not a statistical criterion) that ends before the job
timeout. The build and unit test job is capped at 15 minutes. The earlier sharded jobs (four shards in
9de025f, thirteen in 0189790) ended when the suite was cut to two files.

## 4. Owner decisions

- **Resonant run-up sweep removed.** Every coupon uses the corner-speed ladder; stored sweep settings
  still load.
- **Zigzag replaced by the motor-safe ladder**: rung-major order, per-line corner limits, planner stops
  between lines, and the profile's own corner limit everywhere except the test corners.
- **Acceleration floor removed.** The test runs at the profile's print acceleration.
- **No G-code designed around a configurable firmware limit.** The moving prime capped at Klipper's
  default `max_extrude_cross_section` is removed; each line un-retracts standing still and prints its
  first stretch as an ordinary bead (section 1.8).
- **`M220 S100` in the input shaper coupon only.** The pressure advance and flow coupons are exempt: their
  measurands do not depend on the absolute speed (`2026-07-15-cross-flow-exemptions.md`, section 6).
- **A "not confirmed" speed check no longer refuses the axis (2026-10-08, 9ace4a0).** This replaces the
  earlier decision to refuse such an axis. Only a frequency that changes with the speed refuses; the
  check's state is still reported. The owner will try out how well this works on real prints.
- **A damping ratio at the fit bound no longer refuses the axis (2026-10-08, 055f1b3).** The shaper is
  designed at Klipper's default damping ratio 0.1, and the Klipper snippet writes that value (0fc6cc0);
  the results card adds no text about it.
- **Two analysis additions were reverted (2026-10-08).** The trace outlier filter, which set additive
  outliers aside as unread samples, together with the running median search of the fit window (954c75e,
  reverted in 084c486), and the refusal of an axis whose forced tone check is underpowered (cb68806,
  reverted in 6f603fa). Neither is part of the analysis.
- **No restart note on the coupon pages (3f52bcf).** The restore is a firmware restart, stated only in
  the end-of-print G-code comments.
- **Corner speed above 100 mm/s gives a warning, no hard cap.** The owner will try the warning out later.
- **Coupons with the old single-speed layout are not supported.** The Speed tiers and Lines per speed
  settings were removed (8fb3d4c); one tier happens automatically on small beds (bed fit) and below a
  29 mm/s line speed, each with a worded note.
- **Red statistics tests stay red** rather than being loosened, unless fixed honestly. Of the two red S1
  files at the end of stage 1 (2 px blur and red AR(2)), stage 2 fixed red AR(2); 2 px blur was still red
  when the S1 files left the suite (section 5).
- **Two implementer method changes, flagged to the owner for review**: input proportionality as a t
  test of the intercept of per-line amplitude against corner speed instead of the complex-amplitude
  likelihood ratio test (the latter refused correct rings at tiny noise and needed an unreliable corner
  phase; section 2.9), and tracing every 1 px instead of every 0.5 px (half-pixel samples of blurred
  noise made the noise model nearly singular, nothing in the ringing band is lost, and tracing is about
  three times faster; section 2.1).
- **Real-scan goldens come from fresh prints**; scans of the old sweep coupons are not ground truth.
- **Klipper only (2026-10-08).** Marlin and RepRapFirmware support was removed from every flow; the
  firmware dropdowns list Klipper as the only option.

## 5. Known limitations and open items

- **S3 coverage under iid noise is red on CI and under diagnosis** (`s3-iid.stats.spec.ts`, wild
  frequency estimates on some seeds). No current S3 figure is recorded here.
- **The speed check's power is about 0.60, not 0.95.** The tier ratio was derived for power 0.95 at the
  weakest accepted measurement, but each tier is fitted from half of the axis's lines, so its standard
  error is about sqrt(2) times that of the axis estimate the confidence gate judges (section 1.2). A
  coupon redesign that restores the design power is open.
- **S1 under 2 px blur was red at 67 exceedances of the 95% point** (allowed 68 to 132; 11 above the 99%
  point) when the S1 files left the suite (c4c19a2). The detection was slightly conservative there, the
  safe direction: it costs some sensitivity and never adds false acceptances. Alternatives measured and
  rejected because none met every S1 file: the unscaled ratio (1 px blur 144), the Berk 1974 m / p F
  reference (2 px blur 44), a delta-method equivalent degrees of freedom (2 px blur 34, red AR(2) 46), and
  the maximum AR order (iid 157).
- **The along-track time warp is corrected (176b55f, 5205e2c); bead transfer is not.** Each corner also
  steps the along-track axis, so the nozzle lags its commanded arc position, which phase-modulates the
  lateral ring and would bias the frequency by up to about 1%, the same on both tiers.
  `alongTrackLag.ts` models the lag as the superposition of that axis's velocity-step response over the
  corner's step and the following acceleration ramp, and `poolCouponAxes` refits each axis on deposit
  times corrected by the other axis's fitted ring at the same corner speed (at most 8 passes), kept only
  when the other axis is accepted. Bead transfer (the bead failing to follow very sharp wiggles:
  compressed first cycles, low zeta, 3f harmonics) has no simulator mechanism to validate against and
  needs the bead width in the analysis.
- **Robustness to dust is not done.** A Hampel rejection cascade broke render recovery and was removed,
  and a later trace outlier filter was reverted by owner decision (section 4). With 1% impulse outliers
  at 0.05 mm the stage 2 run had no false detections (S2 0 of 60), but the frequency standard deviation
  grew from 0.11 Hz to about 0.3 Hz. The ISO 16610-31 robust Gaussian regression filter of the plan was
  not built.
- **Firmware limits not modelled**: Klipper's `limited_cartesian` and `limited_corexy` `max_x_accel` and
  `max_y_accel` can lower the real motion below the commanded profile and so shift the time base. They
  are stated, not detected.
- **Owner test print at the default speeds is a required merge step.** It is the hardware confirmation of
  the ladder, the per-line limits, the planner stops and the motor safety, which were verified from
  firmware source and the oracle, not on a printer.
- **Real-scan goldens are pending fresh prints.** `web/e2e/input-shaper/` holds no webtest or golden yet
  and there is no input shaper real-scan unit spec.
- **Review items**: the edge-of-band unit test tolerance is 0.3 Hz, three times the nine remaining
  lines' profile-likelihood standard error of about 0.10 Hz (`web/tests/engine/is/ringAnalyzer.spec.ts`);
  the mirrored render's replicate check sits near its threshold (Q 34.3 against 27.9 under one
  intermediate variant). The one-tier influence refusal now names the line speed and bed that keep both
  tiers (661960e), and `IsTestRequest.linesPerSpeed` is removed (a0f9ee1).
- **Performance**: a detected axis takes about 1.4 to 1.6 s (stage 1 about 0.8 s); `isAnalyzer.spec.ts`
  takes 173 s of test time, its slowest case 33 s against a 240 s per-case timeout.
- **Motor safety stays empirical**: the 100 mm/s default rests on one tested CoreXY printer. Approaching
  each corner at 45 degrees would halve the CoreXY reversing motor's kick energy but needs a packing
  redesign and is parked.

## 6. Commits

Stage 1: 3a297ae (sweep removed), befc341 (normal quantile, even-dof chi-square tail, correlated-noise
module), f4bc3c4 (profile acceleration), 738066e (two interleaved tiers, rung-major order, derived lines
per speed), 9edd4cb (far bed edge), 7a9a2d9 (prime cross-section), d50823a (per-line corner limits,
planner stops, M220), 1d5603d (commanded-distance time base, Marlin ramp start), 35d86f4 (settings, later
removed), 756dda5 (planner oracle), 04c6b84 (trace simulator), 3d323d4 (segment Burg, gap-aware
whitener, general chi-square tail), f04e376 (GLS detection with the look-elsewhere bound and the checks),
e5ccd22 (result rows), fb1e5f0 (1 px tracing, proportionality t test), 7e83e22 (statistics suite),
20f9fec (statistics CI job), a11d098 (cross-flow exemptions), 8fb3d4c (Speed tiers and Lines per speed
settings removed).

Stage 2: be2e712 (likelihood ratio with refitted noise), 2c07f43 (profile-likelihood interval), c887f68
(variance function), 9de025f (CI shards), bf60247 (second mode and shaper scoring), 7a10ca8 (pattern
search), 0411fa6 (corner model by pooled AICc), 552a4ad (result rows), 2e7603e (pixel locking), daa708b
(closed-form pattern whitening, file budget), 9e2c6d9 (pedestal ring and above-band mode cases), 1ed5b5f
(analysis header).

After stage 2: a0f9ee1 (`IsTestRequest.linesPerSpeed` removed), 661960e (one-tier refusal text),
176b55f and 5205e2c (along-track lag correction, with the acceleration ramp), 0189790 and 9d6d6fe (CI
shards, then the stats job only on changed dependencies), cb68806 (underpowered forced tone refusal,
reverted in 6f603fa), dd18e1e (S3 truth off the grid nodes), c4c19a2 and 3440f51 (suite cut to two
files), 954c75e (trace outlier filter, reverted in 084c486), 3f52bcf (restart note removed from the
coupon pages), 9ace4a0 ("not confirmed" no longer refuses), 055f1b3 (damping bound no longer refuses),
0fc6cc0 (snippet always writes the design damping ratio), 59ece65 (no interval for a swapped dominant
mode without a standard error).
