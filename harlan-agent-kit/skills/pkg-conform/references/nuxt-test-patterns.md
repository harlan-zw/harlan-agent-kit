# Test Patterns

## Playground Setup

### playground/nuxt.config.ts

```ts
export default defineNuxtConfig({
  modules: ['../src/module'],

  myModule: {
    // module options
  },

  devtools: { enabled: true },
  compatibilityDate: '2025-01-01',
})
```

### playground/app.vue

```vue
<template>
  <div>
    <NuxtPage />
  </div>
</template>
```

### playground/pages/index.vue

```vue
<template>
  <div>
    <h1>My Module Playground</h1>
  </div>
</template>
```

## Test Fixtures

### test/fixtures/basic/nuxt.config.ts

```ts
export default defineNuxtConfig({
  modules: ['../../../src/module'],

  myModule: {
    // test options
  },
})
```

### test/fixtures/basic/app.vue

```vue
<template>
  <div>
    <NuxtPage />
  </div>
</template>
```

## E2E Test Patterns

### Basic module test

```ts
import { $fetch, setup } from '@nuxt/test-utils/e2e'
import { describe, expect, it } from 'vitest'

describe('my-module', async () => {
  await setup({
    rootDir: './test/fixtures/basic',
  })

  it('renders page', async () => {
    const html = await $fetch('/')
    expect(html).toContain('My Module')
  })
})
```

### Testing composables

```ts
import { setup, useTestContext } from '@nuxt/test-utils/e2e'
import { describe, expect, it } from 'vitest'

describe('composables', async () => {
  await setup({
    rootDir: './test/fixtures/basic',
  })

  it('useMyComposable works', async () => {
    const ctx = useTestContext()
    // test composable behavior
  })
})
```

## GitHub Actions (Nuxt variant)

### .github/workflows/test.yml

```yaml
name: Test

on:
  push:
    paths-ignore:
      - '**/README.md'
      - 'docs/**'

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v6
        with:
          node-version: lts/*
          cache: pnpm

      - run: pnpm i

      - name: Lint
        run: pnpm lint

      - name: Prepare
        run: pnpm dev:prepare

      - name: Typecheck
        run: pnpm typecheck

      - name: Build
        run: pnpm build

      - name: Test
        run: pnpm test:run
```

## Common Issues

1. **"Cannot find module '#imports'"** - add to externals in build.config.ts
2. **Typecheck fails without prepare** - run `pnpm dev:prepare` first
3. **E2E tests fail** - check fixture nuxt.config points to `../../../src/module`
4. **Runtime code bundled wrong** - ensure runtime/ files use runtime imports only
5. **Server composables not found** - use `addServerImportsDir()` not `addImports()`
6. **Plugin runs twice** - check `mode` is set correctly
