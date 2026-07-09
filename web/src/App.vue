<script setup lang="ts">
import { useApp } from './stores/useApp'
import ScanPage from './components/ScanPage.vue'
import CalibrationPage from './components/CalibrationPage.vue'
import PaPage from './components/PaPage.vue'
import EmPage from './components/EmPage.vue'
import ProfilePage from './components/ProfilePage.vue'
import AppLogo from './components/AppLogo.vue'

const app = useApp()
const version = __APP_VERSION__
</script>

<template>
  <v-app>
    <v-app-bar density="compact" flat color="surface" class="brandbar">
      <div class="brand">
        <AppLogo :size="24" />
        <span class="brand-name">ScanNTune</span>
        <span class="brand-version">v{{ version }}</span>
      </div>
      <nav class="topnav ml-4">
        <v-btn
          variant="text"
          size="small"
          :active="app.screen === 'scan' || app.screen === 'calibration'"
          data-testid="nav-skew"
          @click="app.goScan()"
        >
          Skew / size
        </v-btn>
        <v-btn
          variant="text"
          size="small"
          :active="app.screen === 'pa' || app.screen === 'profile'"
          data-testid="nav-pa"
          @click="app.goPa()"
        >
          Pressure advance
        </v-btn>
        <v-btn variant="text" size="small" :active="app.screen === 'em'" data-testid="nav-em" @click="app.goEm()">
          Flow
        </v-btn>
      </nav>
      <v-spacer />
      <v-btn
        icon="mdi-github"
        variant="text"
        href="https://github.com/jaak0b/ScanNTune"
        target="_blank"
        rel="noopener"
        title="View on GitHub"
        aria-label="View on GitHub"
        class="mr-2"
      />
    </v-app-bar>
    <v-main>
      <ScanPage v-if="app.screen === 'scan'" />
      <PaPage v-else-if="app.screen === 'pa'" />
      <EmPage v-else-if="app.screen === 'em'" />
      <ProfilePage v-else-if="app.screen === 'profile'" />
      <CalibrationPage v-else />
    </v-main>
  </v-app>
</template>

<style scoped>
.brandbar {
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.08);
}
.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  padding-left: 12px;
  flex-shrink: 0;
}
.brand-name {
  font-weight: 600;
  font-size: 15px;
}
.brand-version {
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), 0.5);
}
/* The nav scrolls horizontally instead of overflowing the bar on narrow screens. */
.topnav {
  display: flex;
  flex-wrap: nowrap;
  overflow-x: auto;
  scrollbar-width: none;
  min-width: 0;
}
.topnav::-webkit-scrollbar {
  display: none;
}
.topnav .v-btn {
  flex-shrink: 0;
}
@media (max-width: 700px) {
  .brand-version {
    display: none;
  }
}
@media (max-width: 560px) {
  .brand-name {
    display: none;
  }
  .topnav {
    margin-left: 4px !important;
  }
  .topnav .v-btn {
    padding: 0 8px;
    min-width: 0;
  }
}
</style>
