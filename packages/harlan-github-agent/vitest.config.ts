import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Fixture commits must not use the operator's hooks or signing key. Signing tests supply their own config.
    env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    // Several tests spawn git and wt against real temporary repositories. They
    // finish in well under a second alone and crossed the five second default
    // under parallel load, failing the suite that gates every commit while
    // passing on their own. The ceiling is for a genuine hang, not for pace.
    testTimeout: 30_000,
  },
})
