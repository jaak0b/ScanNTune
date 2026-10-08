import { defineConfig } from 'vitest/config'

// The statistical calibration suite of the input shaper analysis (tests/stats): thousands of
// fixed-seed simulated axes per file, so it runs apart from the default suite. Every file is one
// test; the files run in parallel worker processes (and in shards on CI, --shard=i/n). A file
// takes up to about five minutes on one core; the ten-minute timeout leaves room for a slower or
// busier machine and is a time budget, not a statistical criterion.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/stats/**/*.stats.spec.ts'],
    testTimeout: 600_000,
    pool: 'forks',
    // Every case prints its counts, the numbers the calibration is judged and reported by; the
    // verbose reporter shows them for passing cases too.
    silent: false,
    reporters: ['verbose'],
  },
})
