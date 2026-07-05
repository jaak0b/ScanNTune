<script setup lang="ts">
import { useApp } from './stores/useApp'
import ScanPage from './components/ScanPage.vue'
import CalibrationPage from './components/CalibrationPage.vue'
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
}
.brand-name {
  font-weight: 600;
  font-size: 15px;
}
.brand-version {
  font-size: 12px;
  color: rgba(var(--v-theme-on-surface), 0.5);
}
</style>
