import { defineConfig } from 'vitest/config'

// The statistical calibration suite of the input shaper analysis (tests/stats): thousands of
// fixed-seed simulated axes per file, so it runs apart from the default suite. The files run in
// parallel worker processes (and in shards on CI, --shard=i/n). On CI the slowest test took
// about 13.5 minutes (s10-alongTrackLag, with three files running at once on a four-vCPU
// runner). The twenty-minute timeout leaves room for a slower or busier machine and ends before
// the 25-minute CI job timeout, so a hung test fails under its own name; it is a time budget,
// not a statistical criterion.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/stats/**/*.stats.spec.ts'],
    testTimeout: 1_200_000,
    pool: 'forks',
    // Every case prints its counts, the numbers the calibration is judged and reported by; the
    // verbose reporter shows them for passing cases too.
    silent: false,
    reporters: ['verbose'],
  },
})
