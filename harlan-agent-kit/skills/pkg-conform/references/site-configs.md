# Site Configuration Files

## nuxt.config.ts

```ts
export default defineNuxtConfig({
  future: {
    compatibilityVersion: 5, // Opt-in to Nuxt 5 behavior
  },
  compatibilityDate: '2025-01-01', // Set to a recent date

  modules: [
    '@nuxtjs/seo',
    '@nuxt/ui',
    '@nuxt/content',
    '@nuxt/fonts',
    '@nuxt/image',
    '@nuxt/scripts',
    '@vueuse/nuxt',
    'motion-v',
  ],

  // Nitro preset matches deploy target
  nitro: {
    preset: 'cloudflare-durable', // or 'vercel', 'netlify', etc.
  },
})
```

### Key patterns

- Always set `future.compatibilityVersion: 5` to opt in to Nuxt 5 behavior
- `compatibilityDate` set to a recent date
- Standard module stack: `@nuxtjs/seo`, `@nuxt/ui`, `@nuxt/content`, `@nuxt/fonts`, `@nuxt/image`, `@nuxt/scripts`, `@vueuse/nuxt`, `motion-v`
- Nitro preset matches deploy target (cloudflare-durable, vercel, etc.)
- Enable `experimental.typedPages: true` for type-safe routing

### Route rules & caching

Use helper functions for DRY ISR/caching config:

```ts
// Common pattern for ISR routes
const routeRules = {
  '/api/badge/**': { cache: { maxAge: 60 } },
  '/api/downloads/**': { cache: { maxAge: 60 } },
  '/_content/**': { cache: { maxAge: 86400 } }, // 1 day
  '/icons/**': { cache: { maxAge: 604800 } }, // 7 days
}
```

## vitest.config.ts

Multi-project config with unit + Nuxt environment:

```ts
import { fileURLToPath } from 'node:url'
import { defineVitestProject } from '@nuxt/test-utils/config'
import { defineConfig } from 'vitest/config'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      await defineVitestProject({
        test: {
          name: 'nuxt',
          include: ['test/nuxt/**/*.test.ts'],
          environment: 'nuxt',
          environmentOptions: {
            nuxt: {
              rootDir,
            },
          },
        },
      }),
    ],
    coverage: {
      enabled: true,
      provider: 'v8',
    },
  },
})
```

## tsconfig.json

Minimal — just extends Nuxt's generated config:

```json
{ "extends": "./.nuxt/tsconfig.json" }
```

## eslint.config.js

Note: sites use `.js` extension (not `.mjs`):

```js
import antfu from '@antfu/eslint-config'
import harlanzw from 'eslint-plugin-harlanzw'

export default antfu({
  rules: {
    'node/prefer-global/process': 'off',
    'node/prefer-global/buffer': 'off',
  },
  ignores: [
    '.data/**',
  ],
}, ...harlanzw())
```

## .npmrc

Required for sites (Nuxt module resolution):

```
shamefully-hoist=true
```

## .editorconfig

Same as shared standard — see `configs.md`.

## .gitignore — site-specific additions

Beyond standard patterns, sites need:

```
.nuxt
.output
.data
.wrangler
wrangler.toml
.vercel
.netlify
```

## Node version

Sites should target the latest stable even-numbered Node major (22, 24, 26, etc.). Set `engines.node` to `>=XX.0.0`. Packages may need broader compatibility; sites don't since they're deployed, not consumed.
