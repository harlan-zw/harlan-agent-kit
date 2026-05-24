# Configuration Files

## .npmrc

Optional. Only needed for monorepos with hoisting issues:

```ini
shamefully-hoist=true
```

## .editorconfig

```ini
root = true

[*]
indent_size = 2
indent_style = space
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false
```

## .gitignore

```gitignore
node_modules
dist
.output
.idea
.vscode
*.swp
.DS_Store
*.log
coverage
.env
.env.*
!.env.example
```

## eslint.config.mjs

```js
import antfu from '@antfu/eslint-config'
import harlanzw from 'eslint-plugin-harlanzw'

export default antfu(
  {
    rules: {
      'no-use-before-define': 'off',
      'node/prefer-global/process': 'off',
      'node/prefer-global/buffer': 'off',
    },
  },
  {
    ignores: ['docs/**'],
  },
  {
    files: ['**/test/**/*.ts', '**/test/**/*.js'],
    rules: {
      'ts/no-unsafe-function-type': 'off',
      'no-console': 'off',
    },
  },
  ...harlanzw({ link: true, nuxt: true, vue: true }),
)
```

## vitest.config.ts

Basic:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text', 'text-summary'],
    },
  },
})
```

With unit + e2e projects:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text', 'html'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'test/e2e/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
        },
      },
    ],
  },
})
```

## tsconfig.json

```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "preserve",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "baseUrl": ".",
    "rootDir": ".",
    "types": ["node", "vitest/globals"],
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "strict": true,
    "strictNullChecks": true,
    "noUnusedLocals": true,
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

## build.config.ts

```ts
import { defineBuildConfig } from 'obuild/config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: [
        './src/index.ts',
      ],
    },
  ],
})
```

With CLI and multiple entry points:

```ts
import { defineBuildConfig } from 'obuild/config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: [
        './src/index.ts',
        './src/cli.ts',
        './src/types.ts',
      ],
    },
  ],
})
```
