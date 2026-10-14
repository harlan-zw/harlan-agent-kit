import { defineConfig } from 'vitest/config'

// The Worker uses only Web APIs, so the tests run in Node against plain binding fakes.
export default defineConfig({
  test: {},
})
