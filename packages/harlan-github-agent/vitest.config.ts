import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Several tests spawn git and wt against real temporary repositories. They
    // finish in well under a second alone and crossed the five second default
    // under parallel load, failing the suite that gates every commit while
    // passing on their own. The ceiling is for a genuine hang, not for pace.
    testTimeout: 30_000,
  },
})
