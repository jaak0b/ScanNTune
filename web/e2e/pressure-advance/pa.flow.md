# Flow spec: pressure advance calibration, Micron ASA golden scan

Feature folder: `web/e2e/pressure-advance/`. Golden sample and its provenance:
`web/e2e/pressure-advance/golden/PROVENANCE.md`. All literal values in this spec are copied
verbatim from that file; none are computed here.

This flow needs no scanner calibration seed: pressure advance is dimensionless and the analyzer
prices every distance from the coupon's own fiducial geometry, so nothing is written into
`localStorage` before the journey. It does depend on a printer profile existing; one is created
fresh through the real profile UI (defaults are valid, only the name is entered).

## Case table

| case | fixture | notes |
|---|---|---|
| 600 dpi golden scan | `golden/pa_0d_black_white.jpg` | single scan, default 16-line 0 to 0.06 spec |

Only one approved scan of this sample exists; the second-resolution case is an open gap recorded
in `PROVENANCE.md` and is to be added as a second case-table row when the owner rescans the
coupon at another native resolution.

## User journey

1. Open the app at its entry page and click the "Pressure advance" nav button
   (`data-testid="nav-pa"`). The page heading reads "Pressure advance calibration".
2. Since no printer profile exists yet, click `profile-new` (`data-testid="profile-new"`), wait
   for `profile-page` (`data-testid="profile-page"`) to be visible, fill the field labeled
   "Profile name" with `E2E Printer` (defaults for every other profile field are valid and left
   untouched), then click `profile-save` (`data-testid="profile-save"`). This returns to the
   Pressure advance calibration page with the new profile selected.
3. Leave every "Test range" field at its default (the defaults reproduce the golden spec: 16
   lines, PA 0 to 0.06).
4. Upload the fixture through the real file input `pa-scan-input`
   (`data-testid="pa-scan-input"`, `<input type="file">`) via `setInputFiles`. The analysis
   starts on file pick; there is no separate analyze button in this flow.
5. Wait for `pa-best` (`data-testid="pa-best"`) to become visible (analysis on a real scan can
   take over a minute; do not shrink the wait timeout below 120000 ms, per the skill's standard
   wait precedent). Assert `scan-error` (`data-testid="scan-error"`) and `pa-failure`
   (`data-testid="pa-failure"`) both have count 0: the scan must not have been rejected.
6. Read the result tiles and facts off the result panel, per "Assertions" below.

## Assertions

Every value below is copied verbatim from `PROVENANCE.md`; the tolerance bands are the literal
bands recorded there, not computed by the test.

| testid | assertion |
|---|---|
| `pa-best` | text is `"<value> ± <uncertainty>"`; leading number `0.0309` within ± 0.004 and positive; the text contains `" ± "` and the trailing number parses greater than 0 (the uncertainty row is present) |
| `pa-best-line` | exact text `9 of 16` |
| `pa-lines-readable` | exact text `16 / 16` |
| `pa-bracket` | text `Sweep bracketed the optimum: yes` (trimmed) |
| `pa-bracket-direction` | count 0 (no direction row when bracketed) |
| `pa-edge-warning` | count 0 (no out-of-range warning) |

The leading and trailing numbers are read with `innerText()` on the `data-testid` element and
parsed with `parseFloat` on the two number tokens around the `" ± "` separator.

## Notes for the phase 2 implementer

- No rejection case is added by this spec; the flow's rejection coverage (too-low resolution,
  contrast, blank scan) is pinned in the engine unit tier today and a webtest rejection case is
  a recorded gap, not part of this golden addition.
- The emitted firmware command (`pa-code`) is not asserted by this spec because no owner-approved
  displayed command string was captured for this scan in this session; adding it requires a new
  capture with owner review, recorded in `PROVENANCE.md` first.
