// =====================================================================
//  Printer Auto-Calibrate  -  Scan-based shrinkage / skew coupon
// ---------------------------------------------------------------------
//  An open lattice of measurement RINGS held together by thin ribs. The
//  ring CENTRES give true scale and skew for the plate's plane (centres
//  are immune to over/under-extrusion: extrusion changes a ring's wall
//  width, not its centre).
//
//  One parametric design, three plates selected by `plane`:
//    XY  - printed FLAT on the bed, scanned face down. Measures X/Y.
//    XZ  - the same lattice, thick and printed ON-EDGE (standing), then
//          laid flat to scan. Measures X/Z.
//    YZ  - as XZ, rotated. Measures Y/Z.
//  Each is exported pre-oriented so it drops onto the slicer bed ready to
//  print. Render one at a time, e.g.:
//    openscad -D 'plane="XZ"' -o calibration_coupon_xz.stl calibration_coupon.scad
//
//  Orientation marker: the origin-corner ring AND its +X neighbour are
//  printed SOLID (no hole). origin -> neighbour is the plate's +X, which
//  pins rotation and tells a mirror-flip from a rotation at any placement.
//
//  Plane-ID: 1/2/3 DIAGONAL ribs across the bottom-row lattice cells next to
//  the origin marker encode the plane (XY=1, XZ=2, YZ=3). A diagonal is a
//  full-width solid bar between two ring centres, so stringing, shadow and
//  over-extrusion (which only ADD dark to a scan) cannot erase it, unlike the
//  earlier drilled dots which closed up on rough on-edge prints. A positive
//  count means "no diagonals" reads as an unknown plate rather than a silent XY.
//
//  On-edge holes (XZ/YZ only): a symmetric bicone funnel opens the hole
//  toward BOTH faces (so the plate scans equally well either side down) and
//  narrows to a short central throat, the only part that bridges when the
//  hole prints horizontally. Symmetric about the hole axis: the centre is
//  unmoved, and there is no "correct" side to scan.
//
//  Flat (XY) holes are COUNTERSUNK from the top face: the measured 5 mm
//  bore survives only in a thin land at the scan (bed) face and the rest
//  opens as a 45 deg cone. A scanner reads a deep bore as a tunnel, not a
//  2D aperture: a CCD's non-telecentric lens compresses hole spacing on
//  the sensor axis in proportion to edge depth, the offset lamp shadows
//  one side of the rim, and a CIS defocuses everything above ~0.5 mm.
//  The land puts the whole measured edge at the glass; the 45 deg wall
//  can neither occlude nor shadow the aperture. The cone only widens
//  upward, so it prints with zero overhang. The XY plate must therefore
//  be scanned bed-face down (the flattest face, already the natural one).
//
//  The measured holes get NO elephant-foot relief: an inclined chamfer
//  annulus at the rim reads asymmetrically off-axis on a CCD and shifts
//  the detected edge with field position, i.e. a scale error. A squished
//  first-layer edge is symmetric, and ring centres are immune to
//  symmetric size changes, so the bare bore is the more accurate rim.
//  The plate's outer edges keep the chamfer for easy removal.
//
//  Everything below is parametric - change a value and re-render.
// =====================================================================

// ---- Plate selection ------------------------------------------------
plane = "XY";       // "XY" | "XZ" | "YZ"  (override with -D on the CLI)

// ---- Grid -----------------------------------------------------------
baseline   = 100;   // centre-to-centre span of the outermost rings (mm)
grid_n     = 5;     // rings per side  -> grid_n x grid_n rings

// ---- Rings ----------------------------------------------------------
ring_outer_d = 9;   // outer diameter of each ring (mm)
ring_wall    = 2.0; // wall thickness (mm)  -> inner_d = outer_d - 2*wall
ring_h       = 2.0; // FLAT (XY) plate thickness above the bed (mm)

// ---- On-edge plates (XZ / YZ) ---------------------------------------
plate_thickness = 6.0;   // slab thickness of a standing plate (mm)
wall_boost      = 1.0;   // extra ring-wall + rib material on standing plates (mm),
                         // so the thin vertical features print cleaner
bore_boost      = 2.0;   // extra hole bore on standing plates (mm). Scanner defocus on a rough
                         // on-edge face smears ~1 mm of dark into the hole from each side; the
                         // bigger bore keeps a bright core the detector can find. The ring CENTRE
                         // (the measured quantity) is unmoved, and symmetric blur does not move
                         // a centroid, so the measurement is unaffected.
funnel_depth    = 2.25;  // countersink depth from EACH face (bicone: both faces open, so the plate
                         // scans equally well either side down)
funnel_margin   = 4.0;   // countersink mouth = bore + funnel_margin (mm);
                         // central throat = plate_thickness - 2*funnel_depth (straight bore)
base_h     = 6.0;   // solid COPLANAR skirt below the bottom ring row (mm); no lip,
                    // so a standing plate still lies flat to scan and the lid closes
foot_depth = 0.0;   // >0 adds a printed foot behind the plate for print stability,
                    // but then the scanner lid can't close. Default 0 keeps the plate
                    // a flat slab: use a peel-off slicer brim for bed adhesion instead

// ---- Ribs / frame (the lattice that holds the rings together) -------
rib_w   = 2.5;      // width of the interior ribs (mm)
frame_w = 3.0;      // width of the four outer-edge ribs (stiff frame, mm)
rib_h   = 2.0;      // FLAT (XY) rib height (mm)

// ---- Anti elephant's-foot chamfer (FLAT XY plate underside only) ----
// Applies to the plate's outer edges (rings, ribs, diagonals), NOT to the measured holes:
// a chamfer ring at a hole rim reads as a field-dependent edge shift on a CCD (see the header).
chamfer   = 0.4;    // horizontal relief at the bottom edge (mm)
chamfer_h = 0.4;    // height of the chamfer band (mm); = chamfer -> 45 deg

// ---- Countersunk holes (FLAT XY plate only) --------------------------
land_h = 0.4;       // thickness of the land carrying the measured bore at the scan face (mm);
                    // 2 layers at 0.2 mm. Above it the hole opens as a 45 deg countersink, so
                    // the bore wall cannot occlude or shadow the aperture and prints overhang-free.
                    // Thin on purpose: the rim parallax scale error grows with land thickness.
                    // Print in an opaque filament so the land does not glow through

// ---- Orientation marker ---------------------------------------------
fiducial_solid = true;   // make the two orientation rings solid disks

// ---- Plane-ID diagonals ----------------------------------------------
// Solid diagonal ribs across the bottom-row cells starting at the origin
// marker: cell k runs from ring (k,0) up to ring (k+1,1). Additive dark
// geometry, so a rough print can only make the code MORE visible, never
// erase it. Count encodes the plane (XY=1, XZ=2, YZ=3). Width matches the
// interior ribs so the code prints like the rest of the lattice.

// ---- Optional printed reference strip (FLAT XY only) ----------------
include_reference = false;
ref_pitch = 10;     // spacing of reference dots (mm)
ref_dot_d = 2.5;    // reference dot diameter (mm)

// ---- Quality --------------------------------------------------------
// The solid STL export is fine at 96. The flat scan_view projection, however, needs a
// high facet count (pass -D '$fn=200' when rendering fixtures): at low $fn the union of
// ribs and faceted ring walls leaves hairline slivers that break a hole's enclosure and
// drop a ring. (A conditional $fn here does not work: OpenSCAD resolves it before the
// scan_view override, so the CLI flag is the reliable lever.)
$fn = 96;

// ---- Test render ----------------------------------------------------
// When true, emit a flat 2D projection of the scanned face (dark on light)
// instead of the pre-oriented STL. Used to generate synthetic "scan" images
// for the engine tests: the ring/hole/diagonal centres are exactly the model's, so
// the pipeline and plane-ID can be verified against known geometry.
scan_view = false;
scan_rotate = 0;    // in-plane rotation (deg) of the scan_view image, for a quarter-turn pair

// =====================================================================
//  Derived values  (don't edit)
// =====================================================================
on_edge   = (plane != "XY");
thickness = on_edge ? plate_thickness : ring_h;
cf        = on_edge ? 0 : chamfer;      // no elephant-foot relief when standing
cfh       = on_edge ? 0 : chamfer_h;
diag_count = (plane == "XY") ? 1 : (plane == "XZ") ? 2 : 3;

pitch   = baseline / (grid_n - 1);
inner_d = ring_outer_d - 2 * ring_wall;
half    = baseline / 2;

// standing plates get a wider bore plus thicker rings/ribs; the flat XY plate is unchanged
bore           = on_edge ? inner_d + bore_boost : inner_d;
ring_outer     = on_edge ? bore + 2 * (ring_wall + wall_boost) : ring_outer_d;
funnel_mouth_d = bore + funnel_margin;
rib_w_eff   = on_edge ? rib_w + wall_boost : rib_w;
frame_w_eff = on_edge ? frame_w + wall_boost : frame_w;
// 45 deg countersink mouth at the top face, capped so a 0.5 mm face rim survives on each side
xy_mouth_d  = min(inner_d + 2 * (ring_h - land_h), ring_outer_d - 1);
assert(xy_mouth_d > inner_d,
       "the XY countersink mouth must exceed the bore: increase ring_wall or ring_outer_d");

function pos(i) = i * pitch - half;   // centre coordinate of index i

// where the plate edge falls
edge_lo   = pos(0) - ring_outer / 2;
edge_hi   = pos(grid_n - 1) + ring_outer / 2;
zlift     = half + ring_outer / 2 + base_h; // lift a standing plate onto z=0

echo(str("plane = ", plane, ",  pitch = ", pitch, " mm,  bore = ", bore,
         " mm,  rings = ", grid_n * grid_n, ",  thickness = ", thickness,
         " mm,  diagonals = ", diag_count));
assert(inner_d > rib_w + 1,
       "inner_d too small for the rib width - increase ring_outer_d or reduce ring_wall/rib_w");
assert(chamfer < ring_wall / 2,
       "chamfer too large - it would eat through the bottom of the ring wall");
assert(diag_count <= grid_n - 1,
       "not enough bottom-row cells for the plane-ID diagonals - increase grid_n");
assert(2 * funnel_depth < plate_thickness,
       "2*funnel_depth must leave a central throat - reduce funnel_depth below plate_thickness/2");
assert(!on_edge || (funnel_mouth_d > bore && funnel_mouth_d <= ring_outer - 1),
       "the countersink mouth must sit between the bore and 1 mm inside the ring outer diameter, so a face rim survives");
assert(land_h >= 0.4,
       "land_h must be at least two 0.2 mm layers so the land prints reliably");
assert(land_h < ring_h,
       "land_h must be thinner than the flat plate so a countersink remains above it");

// =====================================================================
//  Chamfered primitives  (45 deg relief on the underside; off when on-edge)
// =====================================================================
module ch_cyl(d, h) {                 // solid post, chamfered at the bottom
    if (cf > 0 && cfh > 0) {
        cylinder(d1 = max(0.1, d - 2 * cf), d2 = d, h = cfh);
        translate([0, 0, cfh]) cylinder(d = d, h = h - cfh);
    } else cylinder(d = d, h = h);
}

module ch_hole_funnel(mouth_d, bore_d, fdepth, thick) {   // symmetric bicone: funnels from BOTH faces
    // Opens wide at each face and narrows to a short straight throat in the middle, so the plate
    // scans equally well from either side down; symmetric, so the hole centre is unmoved. The throat
    // is the only part that bridges when the hole prints horizontally (on-edge).
    land = thick - 2 * fdepth;
    translate([0, 0, -0.5]) cylinder(d = mouth_d, h = 0.5 + 0.001);
    cylinder(d1 = mouth_d, d2 = bore_d, h = fdepth);                                  // funnel from face 0
    translate([0, 0, fdepth]) cylinder(d = bore_d, h = land);                         // central throat
    translate([0, 0, fdepth + land]) cylinder(d1 = bore_d, d2 = mouth_d, h = fdepth); // funnel to far face
    translate([0, 0, thick]) cylinder(d = mouth_d, h = 0.5 + 0.001);
}

module ch_hole_countersunk(bore_d, mouth_d, land, h) {   // flat XY: thin land at the scan face
    // The measured bore survives only through the land at the bed (scan) face; above it the hole
    // opens as a 45 deg cone toward the top face, so nothing overhangs when printed flat and the
    // wall cannot occlude or shadow the aperture on the scanner. Deliberately NO elephant-foot
    // relief here: the bare bore edge sits flat on the glass (see the header).
    translate([0, 0, -0.5]) cylinder(d = bore_d, h = land + 0.5 + 0.001);         // straight bore through the land
    translate([0, 0, land]) cylinder(d1 = bore_d, d2 = mouth_d, h = h - land);    // countersink
    translate([0, 0, h]) cylinder(d = mouth_d, h = 0.5);                          // top clearance
}

module ch_bar_x(x0, yc, L, w, h) {     // bar along +X, chamfered long sides
    translate([x0, yc, 0])
        if (cf > 0 && cfh > 0) {
            hull() {
                translate([0, -(w / 2 - cf), 0]) cube([L, w - 2 * cf, 0.01]);
                translate([0, -w / 2, cfh])      cube([L, w, 0.01]);
            }
            translate([0, -w / 2, cfh]) cube([L, w, h - cfh]);
        } else translate([0, -w / 2, 0]) cube([L, w, h]);
}

module ch_bar_y(xc, y0, L, w, h) {     // bar along +Y, chamfered long sides
    translate([xc, y0, 0])
        if (cf > 0 && cfh > 0) {
            hull() {
                translate([-(w / 2 - cf), 0, 0]) cube([w - 2 * cf, L, 0.01]);
                translate([-w / 2, 0, cfh])      cube([w, L, 0.01]);
            }
            translate([-w / 2, 0, cfh]) cube([w, L, h - cfh]);
        } else translate([-w / 2, 0, 0]) cube([w, L, h]);
}

// =====================================================================
//  Geometry
// =====================================================================
module ribs() {
    for (j = [0 : grid_n - 1])          // rows (along X)
        // On a standing plate the solid base is the bottom edge, so skip the bottom frame rib: a rib
        // just above the base would trap a thin gap that reads as spurious holes near the marker.
        if (!(on_edge && j == 0))
            ch_bar_x(-half, pos(j), baseline,
                     (j == 0 || j == grid_n - 1) ? frame_w_eff : rib_w_eff, thickness);
    for (i = [0 : grid_n - 1])          // columns (along the other axis)
        ch_bar_y(pos(i), -half, baseline,
                 (i == 0 || i == grid_n - 1) ? frame_w_eff : rib_w_eff, thickness);
}

module base_block() {                   // standing-plate foundation: solid fill from the
                                        // bottom edge up to just below the bottom-row holes
    yb = -half - ring_outer / 2 - base_h;
    yt = -half - bore / 2 - 1;          // stop 1 mm short of the bottom holes
    translate([edge_lo, yb, 0])
        cube([edge_hi - edge_lo, yt - yb, thickness + foot_depth]);
}

module plane_diagonals() {              // plane-ID code: solid diagonals across bottom-row cells
    for (k = [0 : diag_count - 1])
        hull() {
            translate([pos(k),     pos(0), 0]) ch_cyl(rib_w_eff, thickness);
            translate([pos(k + 1), pos(1), 0]) ch_cyl(rib_w_eff, thickness);
        }
}

module ring_holes() {                   // punch every ring except the two solid markers
    for (i = [0 : grid_n - 1])
        for (j = [0 : grid_n - 1])
            if (!(fiducial_solid && j == 0 && (i == 0 || i == 1)))
                translate([pos(i), pos(j), 0])
                    if (on_edge) ch_hole_funnel(funnel_mouth_d, bore, funnel_depth, thickness);
                    else         ch_hole_countersunk(inner_d, xy_mouth_d, land_h, thickness);
}

module reference_strip() {
    ys  = -half - ring_outer * 1.5;
    cnt = floor(baseline / ref_pitch);
    for (k = [0 : cnt])
        translate([-half + k * ref_pitch, ys, 0]) ch_cyl(ref_dot_d, thickness);
    ch_bar_x(-half, ys, baseline, rib_w, thickness);            // backbone
    for (lx = [pos(0), pos(grid_n - 1)])                        // links up
        ch_bar_y(lx, ys, (-half) - ys, rib_w, thickness);
}

module plate() {
    difference() {
        union() {
            for (i = [0 : grid_n - 1])
                for (j = [0 : grid_n - 1])
                    translate([pos(i), pos(j), 0]) ch_cyl(ring_outer, thickness);
            ribs();
            plane_diagonals();
            if (on_edge) base_block();
            if (include_reference && !on_edge) reference_strip();
        }
        ring_holes();
    }
}

// =====================================================================
//  Export orientation  (pre-oriented so it loads sitting on the bed)
// =====================================================================
if (scan_view)          rotate([0, 0, scan_rotate]) color([0.12, 0.12, 0.12]) projection(cut = false) plate();
else if (plane == "XY") plate();
else if (plane == "XZ") translate([0, 0, zlift]) rotate([90, 0, 0]) plate();
else /* YZ */           rotate([0, 0, 90]) translate([0, 0, zlift]) rotate([90, 0, 0]) plate();
