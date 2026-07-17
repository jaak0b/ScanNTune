---
name: writing-webtests
description: Use when adding or changing a Playwright webtest in web/e2e/**/*.spec.ts for a calibration flow (XY/XZ/YZ, pressure advance, extrusion multiplier, input shaper, or any future flow), for coupon gcode generation, or for slicer preset import, or when a measurement-engine change needs a test that would actually catch it, before committing the change.
---

# Writing webtests

This skill was formerly titled "writing golden webtests". The project has exactly two test tiers,
aimed at two different audiences. Unit tests (Vitest) are the internal correctness net for whoever
touches the code: the render-recovery that keeps the CV math honest against its synthetic fixtures.
Webtests (Playwright, real app, real scan) are the owner-facing feature-level assurance that a
feature's approved outputs do not silently drift. The separate "end-to-end suite" concept is
retired, and the tier once called "golden webtest" is now just a webtest. The concepts "golden
value", "golden sample", and "golden sample library" are unchanged: a golden value is the app's
displayed output for a case the owner has approved (in one of the two tiers described under "Why
this exists"), then frozen; a golden sample is the physical part behind an approved scan; and the
golden sample library is the repo convention that stores those approved sample sets. None of them
names the test tier itself.

## The two-phase process (mandatory)

A webtest is created in two separate phases by two separate roles, never by one agent in one
pass. This separation exists because the failure mode of this class of test is the implementer
inventing expectations from the code under test, which reduces the test to a snapshot of today's
bugs.

**Phase 1: test design.** A QA test designer writes a flow specification BEFORE any test code
exists: the exact user journey step by step (page opens, which control is clicked, what state is
checked after every step), and for each field the value the app currently displays for the
approved case, copied verbatim from the running app's on-screen output. The designer performs
NO calculation, converts no units, and reads no expected value out of the engine source; every
number in the spec is what the app showed for a case the owner has approved, plus a tolerance
band. The spec records the provenance of the approval itself, and which tier backs it (see "Why
this exists"): for a hardware-validated case, what was printed, which emitted command was applied
to the printer, how the owner confirmed the defect was removed, and which at-least-two DPI scans
back the capture; for an owner-reviewed case, what the owner inspected and the domain reason it was judged
correct. The spec covers the full happy path from app entry to every displayed output field, plus
the rejection paths of principle 7. The spec is co-located with its test in the feature folder as
`web/e2e/<feature>/<name>.flow.md`, committed alongside the test, so it is reviewable and survives
as the test's contract.

**Phase 2: test implementation.** A QA automation engineer turns the spec into a Playwright test
mechanically, copying the literals straight from the spec. The engineer does no math either: no
computing, deriving, or unit conversion of any expected value, only transcription. The engineer
may not add, drop, weaken, or reinterpret any assertion in the spec; where the spec and the app
disagree, the engineer reports back instead of adapting the test. If a needed testid does not
exist, the engineer adds the testid to the UI, not a workaround selector.

Changing an existing webtest starts over at phase 1: amend the flow spec first (with owner
sign-off for golden-value changes per principle 8), then regenerate the test code from it.

Both phases are dispatched to current-generation Sonnet-class agents: the design phase is
procedural specification and the implementation phase is mechanical translation, neither needs a
larger model. Escalate a phase to a larger model only when a Sonnet attempt has concretely failed.

## The golden sample library

Each feature owns a single `golden/` leaf subfolder inside its feature directory
(`web/e2e/<feature>/golden/`) holding that feature's validated scan sets, gcode goldens, and one
`PROVENANCE.md`. There is no central `golden/` directory; the golden sample library is the whole
set of these per-feature folders taken together. A reused feature keeps its own `golden/` and
dependent features reference it: the card scan lives in `card-calibration/golden/` and other flows
seed the scale reference from it through the shared helper rather than copying the image.

A golden value is the app's displayed output for a case the owner approved, frozen; it is never
computed. Each measurement flow needs scans of the same physical sample at two representative
resolutions, a lower and a higher (for example a native 300 dpi and a native 600 dpi scan taken in
the same session), each with its own frozen displayed value captured at that resolution: errors in
scale and quantization cluster at the input extremes, which is the standard boundary value analysis
argument for testing the low and high ends of a range rather than one middle value. Prefer scanning
the physical sample natively at each resolution over downsampling a high-resolution scan: a native
scan has no resampling artifacts and is exactly what a real user's scanner produces. If a fixture
must be downsampled to keep the repo light, the golden value must be re-captured from the app run
on the downsampled image, not carried over from the original resolution. When the flow includes
scanner calibration, the set must include a card scan made at the same DPI in the same session.

`PROVENANCE.md` records, as the reason the captured values are trusted, and per frozen value which
approval tier backs it: for a hardware-validated value, what was printed, the emitted command that
was applied to the printer, the print confirmation that the correction actually removed the defect,
and the at-least-two DPI scans behind it; for an owner-reviewed value, what the owner inspected and
the domain reason it was judged correct. It then lists the frozen displayed values per resolution
with their tolerance bands, and the downsample re-capture result where applicable. Flow specs and
tests reference a set by its folder and take golden values ONLY from its `PROVENANCE.md`. No
synthetic render ever lives under `web/e2e/`: a synthetic image cannot be physically validated, so
it cannot back a webtest. Synthetic render-recovery stays entirely in the unit test tree
(`web/tests/`).

## Why this exists

A webtest's ongoing job is regression assurance: it guarantees that a feature still outputs the
same values now as the day the owner approved them. It freezes owner-approved output and fails if
that output ever silently drifts. This is the feature-level guarantee the owner relies on, and it
is a different job from the unit tests: the unit tests are the internal net that keeps the CV math
correct for whoever edits the code, while the webtests are the owner-facing net that keeps approved
feature output from moving. The two-phase discipline and the approval gate below are how the
baseline is established as correct before it is frozen.

The gate exists because a sign-inversion bug in the measurement engine once shipped past
`npm test`: the synthetic fixture that "validated" it was generated from the same wrong equations,
so the unit test and the code under test shared one bug and agreed with each other. The bug also
only showed up on real, non-cardinal scans; at perfect 0 degree and 90 degree placement it happened
to cancel out. The defense is human approval before capture: a webtest freezes the app's displayed
output only after the owner has approved that output. Capturing numbers no human ever looked at and
judged would freeze untrusted code and is forbidden. This is the distinction between an approval
test in Emily Bache's sense, where a human approves the behavior against reality before it is
trusted and locked, and a Michael Feathers characterization test, which records current behavior
with no approval behind it and would have frozen the sign-inversion bug as "correct" forever. A
webtest must be the former and must never be the latter.

Approval at creation comes in two tiers, both genuine human approval, both able to be frozen, each
recorded in `PROVENANCE.md` as which tier backs the value:

- **Hardware-validated (strongest).** The owner printed the coupon, applied the emitted correction
  or command to the printer, and confirmed the defect is actually gone: the `SET_SKEW` command
  really eliminated the skew, the input shaper really removed the ghosting, across at least two
  different DPI scans. The owner's physical result is the external truth; the app is only the
  messenger that displays the numbers the agent then copies.
- **Owner-reviewed (when hardware validation is impossible).** For output that cannot be printed on
  hardware the owner has, the owner inspects the app's output and judges it correct from domain
  knowledge. The concrete case is firmware formats for printers the owner does not own: the owner
  runs Klipper, so Marlin and RepRapFirmware output is reviewed, not printed.

What stays banned is freezing output that no human ever looked at and judged. Both tiers are real
approval and both may be frozen; the tier is recorded so a later reader knows how strong the
backing is.

## Principles

1. **One webtest per case, and every webtest is a full user journey.** Start at the app's entry
   page. Pick the calibration flow the way a user would, upload the real scan through the real
   `<input type=file>` via `setInputFiles`, wait for the Web Worker to finish analyzing it, click
   Analyze, then read the answer off the results DOM. Never import a store, call an engine
   function directly, or seed state through anything other than the UI. The one carve-out is a
   prerequisite that is itself covered by its own dedicated webtest: scanner calibration is the
   concrete case, so a dependent test may seed the stored calibration directly by writing the
   store's exact persisted shape, rather than re-running the whole card-calibration flow inside
   every test that needs it. The EM webtest shows the technique, seeding through
   `page.addInitScript` into localStorage (it lives at `web/e2e/em.spec.ts` today and moves to
   `web/e2e/flow/em.spec.ts` after the reorganization). Going forward, such a shortcut must carry a comment
   naming the dedicated webtest that already covers the seeded step. Everything else still goes
   through the UI, and if the journey can't be driven this
   way, the UI is missing a testid, not an excuse to shortcut. A webtest is never a micro test of
   a single button or a single error toast: that granularity belongs in a unit test, and a suite
   of tiny UI-only webtests just adds Playwright's flakiness surface for no extra coverage
   (Google's testing blog documents test size correlating with flakiness, which is why webtest
   coverage is spent on whole critical flows, not individual widgets). A case is
   one (flow, scan/DPI) combination, or one rejection path; split different DPIs and different
   flows into separate webtests rather than looping several scans inside one mega-test, but group
   every assertion that describes one uploaded scan's outcome (the value, its unit, and its
   diagnostic fields) into that same test, because they are one user journey, a single visit to
   the results page. This mirrors Kent C. Dodds's "write fewer, longer tests" and "avoid the test
   user": assert what a user would actually see on one visit to the results page, not an artificial
   slice of it. "Longer" here means one full journey per test, never several scans crammed together
   to amortize an upload.

   Webtest speed is never a design consideration. A webtest that runs a minute or more is
   completely acceptable, and a webtest may upload a scan and wait for the full analyze as many
   times as it naturally needs. The seconds-long upload-and-analyze cost is inherent to this app
   and must never drive test structure: no workarounds, no cramming of unrelated cases into one
   test, and no cleverness whose only purpose is to avoid the wait. Test clarity and correctness
   always come before runtime. Prefer several small readable webtests over one long crammed one:
   two separate tests, one uploading the 300 dpi scan and one uploading the 600 dpi scan, are
   better than a single test that jams both scans together and becomes hard to read, which is the
   same split principle 9 requires for different DPIs. Where a UI step repeats across tests,
   extracting a shared helper is encouraged for readability, for example a helper that uploads the
   calibration card and takes the parameters to enter or the values to check. That is for clarity,
   not to save time, and it never becomes a way to bypass the real UI; the seed-state carve-out
   above remains the only sanctioned bypass, and only for a prerequisite covered by its own
   dedicated webtest.

   When two cases share an identical journey and differ only in fixture and expected literals, the
   300 dpi and 600 dpi captures of one flow being the canonical pair, parametrize rather than
   duplicate. Do not copy the test body (two copies drift apart silently), and do not call one
   helper twice inside a single test (that crams both cases into one test with one pass/fail
   signal). Instead write a data table of cases, each row carrying its fixture and its expected
   literal values, and a loop that generates one separate `test()` per row over a single shared
   body. That yields a separate named test per case with a clear individual failure signal, still
   one webtest per case, and only one body to maintain. The golden numbers stay as visible literals
   in the case table, copied from `PROVENANCE.md` and never computed: the table holds the data, the
   loop shares the structure.

2. **Real scans only under `web/e2e/`; synthetic renders stay in the unit tree.** A real flatbed
   scan of a real print is the only fixture that can carry a bug the code doesn't already know it
   has, and it is the only fixture a webtest may use, because only a real scan can be physically
   validated. Prefer scans placed at an ordinary, non-cardinal angle over a scan squared up to 0
   or 90 degrees: cardinal placement can hide sign and axis-swap bugs that cancel out at right
   angles. Synthetic renders (`*Render.ts` helpers) still cover geometry variants cheaply, but they
   belong to the unit test tree (`web/tests/`) as render-recovery, never as a webtest fixture and
   never under `web/e2e/`.

3. **Freeze owner-approved app output, never unapproved app output.** The golden value is the
   app's displayed output captured for a case the owner approved, in either tier: hardware-validated
   (printed the coupon, applied the emitted correction or command, confirmed the defect is gone,
   across at least two DPI scans) or owner-reviewed (the owner inspected the output and judged it
   correct from domain knowledge, for output that cannot be printed on hardware the owner has). The
   agent copies that displayed value verbatim and never computes, hand-measures, or derives it from
   design parameters. The banned thing is capturing app output that no human ever looked at and
   judged: a pure characterization snapshot pins today's behavior and would have made the
   sign-inversion bug look "correct" forever. The difference is the human approval behind the
   capture, not the source of the number, since both tiers freeze the app's own displayed value; an
   approved capture is the normal case, not the exception. An app output value with no owner
   approval behind it must never be committed as a webtest expectation, labeled or not. There is no
   snapshot tier and no exception to the approval gate: if a value cannot be approved in one of the
   two tiers, it is not asserted.

4. **Assert sign and magnitude, with a small fixed tolerance band.** State the expected sign
   explicitly (`expect(skew).toBeLessThan(0)`, not just `Math.abs`). Never assert exact float
   equality on a number. The tolerance is a stated literal, a small fixed band, not a quantity the
   test computes at runtime: size it tight enough that a sign flip, a missing unit conversion, or a
   factor-of-2 error still fails, since a band loose enough to pass with the wrong sign is worse
   than no test. Justify the band's size by the observed spread between the validated captures (the
   two DPI captures give a natural spread of the same measurement) and record that rationale in
   `PROVENANCE.md`, not in a formula inside the test. Where a band is expressed as an absolute term
   plus a relative term, both are stated literals; the test never derives the band from any
   measurement or calculation of its own.

5. **No math anywhere: not in the spec, not in the test, by neither agent.** The design phase
   and the implementation phase both compute nothing. A webtest reads displayed values and
   compares them to hardcoded literals (a number plus tolerance band, or an exact string); the
   spec carries those same literals, copied from the approved app output. Neither re-derives an
   expected value through a formula, converts units, or implements a helper that mirrors engine
   logic: test-side or spec-side math can be wrong in exactly the way the app is wrong, and it
   rots silently. Relations between figures (a command encoding a measurement, a percent deriving
   from a ratio) are pinned in engine unit tests, where the formula belongs; the webtest asserts
   the literal on-screen outcome. Fixtures are frozen and the engine is deterministic, so a
   literal exists for every field. Expressing a tolerance band as two stated literals, an absolute
   term plus a relative term times the expected literal, is not re-deriving an expected value and
   is allowed under principle 4; what is banned is producing the expected value itself through
   engine-mirroring math or unit conversion, in either the spec or the test.

6. **Read what the user reads, and assert every command the user pastes.** Assert on the same
   `data-testid` text the user sees on the results page (e.g. `scale-X`, `skew-XY`, `em-width`,
   `pa-best`, `pa-code`), parsed with `innerText()`, not on engine return values or intermediate
   objects. If the UI rounds or formats a number, assert against what's actually displayed; a
   hidden precision bug that never reaches the screen isn't this test's job. Every firmware command
   or actionable output the user copies (`SET_SKEW`, `M221`, the flow percent, the size code, the
   PA value, the shaper parameters) is a first-class assertion in its own right, never delegated to
   a unit test and never omitted: a correct measured readout does not imply a correct emitted
   command, because the command carries its own sign convention and has silently flipped in the
   past while the readout stayed right. Assert the command as the exact displayed string (an exact
   match) and each emitted number as the displayed value within its band, with the sign asserted
   explicitly so a flip fails. Like every other assertion, these values are the app's displayed
   output copied verbatim from the approved case, not recomputed.

   All three firmwares live in the webtest layer, not in unit tests. Firmware is chosen per printer
   profile before analysis; there is no post-analysis firmware toggle in the UI, so a measurement
   webtest asserts every firmware's command by re-running the same owner-approved scan under each
   firmware profile through a shared helper (for example `analyzeUnderFirmware`), never by shifting
   firmware coverage into a unit test. Klipper commands are hardware-validated; Marlin and
   RepRapFirmware commands are owner-reviewed and frozen. All three are asserted as exact command
   strings with explicit sign, because a correct measured readout never substitutes for asserting
   the command itself.

7. **Cover the failure paths users actually hit, not just the happy path.** At least one test per
   flow should upload a scan set the app must reject: two scans of the same angle, a mirror-flipped
   pair, a missing fiducial, or an unreadable image. The too-low-resolution rejection case is
   mandatory for every flow and is specified in principle 9. Assert the specific testid the UI
   uses for the actionable message (e.g. `em-failure`, `plane-status-*`), not just that *something*
   failed.

8. **A backend change never authorizes changing a golden expectation.** When only the UI changed,
   selectors and testids may be updated freely as long as the numeric expectations stay untouched.
   When the measurement engine changed, the golden values and tolerances are the judge of that
   change and must not be edited alongside it: if the test fails, the presumption is that the
   engine is wrong. An existing golden value or tolerance may change only after the owner has
   approved the feature again in the tier that backs it (re-printed, re-applied the emitted command,
   and confirmed the defect is still removed across the at-least-two DPI scans for a hardware-validated
   value, or re-reviewed the output for an owner-reviewed value), re-captured the app's displayed
   output for that approved case, and explicitly signed off; `PROVENANCE.md` must record the new
   approval and the new frozen values. Adding assertions for genuinely new outputs is always
   allowed; this rule gates changing or deleting existing ones. If a claimed small improvement
   forces a golden to move, treat that as a signal that either the tolerance band was dishonest or
   the change is larger than claimed.

9. **Multi-DPI coverage is mandatory per flow.** Each flow needs webtests at two representative
   scan resolutions, a lower and a higher, each asserted against its own frozen displayed value
   captured at that resolution from an owner-approved scan: this is boundary value analysis and
   equivalence partitioning applied to scan input, the standard black-box justification for
   testing the ends of a range rather than assuming the middle represents it, because scale,
   quantization, and noise errors cluster at the extremes. The two resolutions are the canonical
   case-table pair of principle 1: one row per resolution carrying its fixture and its expected
   literals, generating one separate named test each over a shared body, never one test that
   uploads both. The two captures also fix the tolerance band of principle 4 by showing the natural
   spread of the same measurement. Beyond those two passing resolutions, every flow's rejection
   coverage (principle 7) must include a deliberately-too-low-resolution scan that the resolution
   gate is required to refuse, so the gate itself is exercised on each flow rather than assumed.

10. **Determinism is not negotiable.** A webtest waits on a real signal only: a specific testid
    becoming visible, a DOM state that appears when the Web Worker finishes, Playwright's own
    web-first auto-retrying assertions. It never waits on a fixed sleep or any other wall-clock
    or timing dependence.
    This follows Kent Beck's Test Desiderata, where "Deterministic" is a first-class property of
    a trustworthy test, and Martin Fowler's observation that non-deterministic tests get muted or
    ignored rather than fixed, which quietly deletes their coverage. A webtest that fails
    intermittently and gets re-run until green, or gets skipped "for now", is worthless: fix the
    wait condition or delete the test, there is no acceptable middle state.

## Non-measurement webtest targets

Two features have no scan to analyze but are still driven as webtests through the real UI.

**Coupon gcode generation.** The PA, EM, and IS coupon gcode generators produce deterministic
output with no timestamps or randomness, so their output is frozen by an exact byte comparison to a
golden gcode file the owner printed and verified. The webtest drives the real UI: select the
printer profile, generate, download the file, and compare it byte-for-byte to the golden (through a
shared helper, for example `downloadAndCompareGcode`). The owner's own firmware gcode golden is
hardware-validated because it was printed; the other two firmwares' gcode goldens are owner-reviewed.
There is no math: the comparison is file-equals-golden, and the golden was captured from an approved
generation, never hand-derived. XY, XZ, and YZ have no gcode target, because that coupon is an STL
the user slices, so gcode webtests exist only for PA, EM, and IS.

**Slicer preset import.** Printer management imports OrcaSlicer and PrusaSlicer presets into a
printer profile. Test it as a webtest at the level the owner uses: upload the owner's real Orca
preset and real Prusa preset through the actual import UI and assert the resulting profile fields
come out as the owner approved them at creation. One general happy-path webtest per slicer is
enough; this is not an exhaustive edge-case matrix.

## Practical Playwright guidance for this repo

- **Folder layout is one level deep, one folder per feature.** Filenames carry test identity in
  the Playwright `*.spec.ts` convention. Each feature folder holds its own specs, its co-located
  `<name>.flow.md`, and a single `golden/` leaf subfolder with its validated sample sets, gcode
  goldens, and `PROVENANCE.md`; that `golden/` data subfolder is the only nesting, so navigation
  stays one level deep:
  ```
  web/e2e/
    helpers/              cross-feature step helpers (uploadCard, seedCalibration,
                          analyzeUnderFirmware, downloadAndCompareGcode)
    card-calibration/     card.spec.ts, card.flow.md, golden/ (card_300dpi.png, card_600dpi.png,
                          PROVENANCE.md)
    printer-management/   slicer-import.spec.ts, slicer-import.flow.md, golden/ (real orca + prusa
                          presets, PROVENANCE.md)
    skew-shrinkage/       xy.spec.ts, xz.spec.ts, yz.spec.ts, xy-rejection.spec.ts, skew.flow.md,
                          golden/ (xy/xz/yz scans 300+600, PROVENANCE.md)
    pressure-advance/     pa.spec.ts, pa-gcode.spec.ts, pa-rejection.spec.ts, pa.flow.md,
                          golden/ (scans + per-firmware gcode goldens, PROVENANCE.md)
    flow/                 em.spec.ts, em-gcode.spec.ts, ..., golden/
    input-shaper/         is.spec.ts, is-gcode.spec.ts, ..., golden/
  ```
  Reused features (`card-calibration`, `printer-management`) are their own folders and their
  `golden/` is referenced by dependent features: the card is the shared scale reference other flows
  seed from through the helper. There is no central `golden/` folder and no central `flows/` folder
  (not to be confused with the extrusion multiplier feature's own `flow/` folder, which is a
  feature directory like any other).
  Rejection is feature-specific: must-refuse inputs and their tests live inside the owning feature
  as `*-rejection.spec.ts` files or cases, never in a global rejection folder. Name real scans with
  their resolution (`card_300dpi.png`, `card_600dpi.png`) so DPI is obvious from the filename. If a
  real scan is large (35 MP+), it may be downsampled to keep the repo light, but only after
  re-capturing the golden values from the app run on the downsampled image, because scale changes
  with resolution and a value captured on the original would silently drift against a resized image.
- **Golden filenames encode flow, orientation, dpi, and colors, ranked by importance.** A golden
  sample filename is `<flow>_<orientation>_<dpi>_<colors...>.<ext>`, tokens ranked flow, then
  orientation, then dpi, then colors: the flow is the short flow tag (`pa`, `em`, `is`, `skew`,
  `card`); the orientation is the printed or scanned rotation when the flow distinguishes one
  (`0d`, `90d`, `180d`, `270d`), omitted only for a flow with no orientation concept (the card); the
  dpi is the scan resolution (`300dpi`, `600dpi`). Colors are ordered by proximity to the scanner
  glass, nearest first (the part touching or closest to the glass first, background last). For
  example, `xy_90d_300dpi_black_white.jpg` is a black part scanned on a white background. A PA
  (pressure advance) part with black lines on a white solid base scanned against a grey backdrop
  would be `pa_..._black_white_grey.jpg`: line color nearest the glass, base color next, backdrop
  last. Card calibration goldens are exempt from the orientation and color tokens, since the card
  has no per-flow geometry to encode (`card_300dpi.png` stays flow plus dpi only).
- **Track every real scan and gcode golden with Git LFS.** `.gitattributes` should cover
  `web/e2e/**/*.png` and the gcode golden extension so the feature-local `golden/` binaries and
  gcode files do not leak into plain git history.
- **Upload and wait pattern**, mirrored from the EM webtest (`web/e2e/em.spec.ts` today, moving to
  `web/e2e/flow/em.spec.ts` after the reorganization):
  ```ts
  await page.getByTestId('em-scan-input').setInputFiles(fixturePath)
  await expect(page.getByTestId('em-width')).toBeVisible({ timeout: 120000 })
  await expect(page.getByTestId('em-scan-error')).toHaveCount(0)
  await expect(page.getByTestId('em-failure')).toHaveCount(0)
  const width = parseFloat(await page.getByTestId('em-width').innerText())
  ```
  A 120 second visibility timeout is standard here because a 35 MP scan genuinely takes that long
  to analyze in the Web Worker. The timeout reflects real analysis time; it is not a budget to
  minimize, and it must never be shrunk to make a test file "look tidy" or to speed a run up.
- **Two-scan flows** (XY/XZ/YZ) upload both scans via `scans-input`, wait for each `scan-island`
  to show a `ring-count`, then wait for `plane-status-{plane}` before clicking `analyze-btn`.
- **Existing testid inventory** (`web/src/components/ScanPage.vue` and the results pages):
  `calibrate-btn`, `scans-input`, `scan-island`, `ring-count`, `plane-group-{plane}`,
  `plane-status-{plane}`, `analyze-btn`, `status`, `startover-btn`, `scale-{axis}`,
  `skew-{plane}`, `skew-code`, `size-code`, `zero-note-*`; the PA and EM flows follow the same
  `{flow}-{field}` convention (`em-width`, `em-failure`, `pa-best`, `pa-code`). Add a new testid rather than
  matching on visible text or CSS classes, which drift.
- **Config**: `web/playwright.config.ts` sets a 120 second per-test timeout and a 240 second
  webServer startup against the production build (`npm run build && npm run preview`), so a
  webtest runs against the real bundle, not the dev server.
- **Run with `npm run e2e`** from `web/`. A new webtest must pass locally before it is
  considered part of the verification bar.
