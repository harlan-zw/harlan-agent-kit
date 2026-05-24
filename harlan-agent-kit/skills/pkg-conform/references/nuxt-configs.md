# Nuxt Module Configs

## Additional Catalogs

Add to `pnpm-workspace.yaml` alongside base catalogs from `/pkg-conform`:

```yaml
catalogs:
  # ... base catalogs from /pkg-conform ...

  # Nuxt testing
  dev-test:
    vitest: ^4.0.16
    happy-dom: ^20.1.0
    '@vue/test-utils': ^2.4.6
    '@nuxt/test-utils': ^3.23.0
    playwright: ^1.57.0

  # Vue build
  dev-build:
    typescript: ^6.0.0
    unbuild: ^3.6.1
    vue-tsc: ^3.2.2
    bumpp: ^10.3.2
    '@arethetypeswrong/cli': ^0.18.2

  # Nuxt ecosystem
  nuxt:
    '@nuxt/kit': ^4.2.2
    '@nuxt/module-builder': ^1.0.2
    '@nuxt/schema': ^4.2.2
    nuxt: ^4.2.2
    nitropack: ^2.12.9
```

## tsconfig.json

Nuxt modules extend generated config:

```json
{
  "extends": "./.nuxt/tsconfig.json"
}
```

**Important**: Requires `nuxi prepare` before typecheck works.

## vitest.config.ts

```ts
import { defineVitestProject } from '@nuxt/test-utils/config'
import { defineConfig, defineProject } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    reporters: 'dot',
    projects: [
      defineProject({
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      }),
      defineVitestProject({
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          environment: 'nuxt',
          environmentOptions: {
            nuxt: {
              rootDir: './test/fixtures/basic',
            },
          },
        },
      }),
    ],
  },
})
```

## eslint.config.mjs

```js
import antfu from '@antfu/eslint-config'
import harlanzw from 'eslint-plugin-harlanzw'

export default antfu(
  {
    type: 'lib',
    ignores: [
      'CLAUDE.md',
      'test/fixtures/**',
      'playground/**',
    ],
  },
  ...harlanzw({ link: true, nuxt: true, vue: true }),
)
```

## build.config.ts

```ts
import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  declaration: true,
  entries: [
    'src/module',
    // Additional entries for separate bundles
    { input: 'src/content', name: 'content' },
  ],
  externals: [
    // Nuxt core
    'nuxt',
    'nuxt/schema',
    '@nuxt/kit',
    '@nuxt/schema',
    'nitropack',
    'nitropack/types',
    'h3',
    // Vue
    'vue',
    'vue-router',
    '@vue/runtime-core',
    // Common deps
    '#imports',
  ],
})
```

## .gitignore additions

```gitignore
# Nuxt
.nuxt
.output
playground/.nuxt
playground/.output
test/fixtures/**/.nuxt
test/fixtures/**/.output
```

## package.json exports

```json
{
  "name": "@nuxtjs/my-module",
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/module.mjs",
      "require": "./dist/module.cjs"
    }
  },
  "main": "./dist/module.cjs",
  "types": "./dist/types.d.ts",
  "files": ["dist"],
  "peerDependencies": {
    "nuxt": "^3.0.0 || ^4.0.0"
  }
}
```

## package.json scripts

```json
{
  "scripts": {
    "build": "nuxt-module-build build",
    "dev": "nuxi dev playground",
    "dev:prepare": "nuxt-module-build prepare && nuxi prepare playground",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "typecheck": "nuxt typecheck",
    "prepare:fixtures": "nuxi prepare test/fixtures/basic",
    "test": "pnpm prepare:fixtures && vitest",
    "test:run": "pnpm prepare:fixtures && vitest run",
    "release": "bumpp && pnpm publish"
  }
}
```

## Typecheck Difference

| Project Type | Command | Why |
|--------------|---------|-----|
| Nuxt module | `nuxt typecheck` | Uses generated `.nuxt/tsconfig.json` with auto-imports |
| Non-Nuxt lib | `tsc --noEmit` | Standard TypeScript check |
