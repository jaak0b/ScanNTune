<script setup lang="ts">
// Diagram: the resonance coupon. One solid frame band with an open window (the window and
// the fiducial holes are cut out via a mask, so they show the page background and read as
// holes in a single object). One highlighted test line demonstrates the measurement: the
// run-up leg enters through the band, takes a sharp corner, rings as a decaying wiggle,
// settles into a straight measured stretch, and ends in the far band.
</script>

<template>
  <svg
    viewBox="0 0 480 212"
    class="diagram"
    role="img"
    aria-label="The resonance coupon: one solid frame band with an open window, three fiducial holes and a solid origin corner. A highlighted test line enters through the band, turns a sharp corner, rings as a decaying wiggle, settles into a straight line and ends in the far band."
  >
    <defs>
      <!-- The window and the three fiducial holes are cut out of the band, so the coupon
           renders as one object with holes, not nested panels. -->
      <mask id="is-coupon-cutout">
        <rect x="40" y="24" width="220" height="164" rx="6" fill="#fff" />
        <rect x="64" y="48" width="172" height="116" rx="3" fill="#000" />
        <rect x="50" y="34" width="12" height="12" rx="2" fill="#000" />
        <rect x="238" y="34" width="12" height="12" rx="2" fill="#000" />
        <rect x="238" y="166" width="12" height="12" rx="2" fill="#000" />
      </mask>
    </defs>

    <!-- Coupon: the frame band as a single surface with the cutouts. -->
    <rect
      x="40"
      y="24"
      width="220"
      height="164"
      rx="6"
      class="couponFill"
      mask="url(#is-coupon-cutout)"
    />

    <!-- Solid origin corner: the fourth corner has no hole, only a marker dot. -->
    <circle cx="56" cy="172" r="3" class="solidDot" />

    <!-- Faint neighbour lines of the same group, for context only. -->
    <path d="M78 186 V132 H250" class="plain" fill="none" stroke-width="1.6" />
    <path d="M98 186 V152 H250" class="plain" fill="none" stroke-width="1.6" />

    <!-- The highlighted test line: run-up leg through the band, sharp corner, decaying
         ringing wiggle, straight measured stretch into the far band. -->
    <path d="M88 186 V142" class="runup" fill="none" stroke-width="2.5" />
    <path
      d="M88 142 C92 133 96 151 100 142 C104 134 108 149 112 142 C115 137 118 146 121 142 C124 139 127 144 130 142 L250 142"
      class="measured"
      fill="none"
      stroke-width="2.5"
    />
    <circle cx="88" cy="142" r="4.5" class="cornerRing" fill="none" stroke-width="1.6" />

    <!-- Callouts: each leader starts on the feature it names. -->
    <polyline points="108,135 150,52 286,52" class="callout" fill="none" />
    <text x="290" y="56" class="lbl">ringing recorded as a decaying wiggle</text>

    <polyline points="93,139 168,96 286,96" class="callout" fill="none" />
    <text x="290" y="100" class="lbl">sharp corner excites the axis</text>

    <polyline points="90,176 186,150 286,150" class="callout" fill="none" />
    <text x="290" y="154" class="lbl">run-up leg enters through the band</text>

    <polyline points="60,174 200,196 286,196" class="callout" fill="none" />
    <text x="290" y="200" class="lbl">solid corner marks the origin</text>
  </svg>
</template>

<style scoped>
.diagram {
  width: 100%;
  max-width: 440px;
  height: auto;
}
.lbl {
  fill: rgba(var(--v-theme-on-surface), 0.6);
  font-size: 11px;
}
.couponFill {
  fill: rgba(var(--v-theme-on-surface), 0.22);
}
.solidDot {
  fill: rgba(var(--v-theme-on-surface), 0.55);
}
.callout {
  stroke: rgba(var(--v-theme-on-surface), 0.35);
  stroke-width: 1;
}
.runup {
  stroke: rgb(var(--v-theme-primary));
}
.measured {
  stroke: rgb(var(--v-theme-success));
}
.plain {
  stroke: rgba(var(--v-theme-on-surface), 0.25);
}
.cornerRing {
  stroke: rgb(var(--v-theme-warning));
}
</style>
