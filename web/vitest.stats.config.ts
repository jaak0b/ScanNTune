import { defineConfig } from 'vitest/config'

// The statistical calibration suite of the input shaper analysis (tests/stats): thousands of
// fixed-seed simulated axes per file, so it runs apart from the default suite. Every file is one
// test with a five-minute budget; the files run in parallel worker processes.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/stats/**/*.stats.spec.ts'],
    testTimeout: 300_000,
    pool: 'forks',
    // Every case prints its counts, the numbers the calibration is judged and reported by; the
    // verbose reporter shows them for passing cases too.
    silent: false,
    reporters: ['verbose'],
  },
})
