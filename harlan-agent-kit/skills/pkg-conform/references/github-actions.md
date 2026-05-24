# GitHub Actions

## .github/workflows/ci.yml (Package)

```yaml
name: CI

on:
  push:
    paths-ignore:
      - '**/README.md'
      - 'docs/**'

concurrency:
  group: ${{ github.workflow }}-${{ github.event.number || github.sha }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  lint:
    runs-on: ubuntu-24.04-arm
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v6
        with:
          node-version: lts/*
          cache: pnpm
      - run: pnpm i
      - run: pnpm lint

  typecheck:
    runs-on: ubuntu-24.04-arm
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v6
        with:
          node-version: lts/*
          cache: pnpm
      - run: pnpm i
      - run: pnpm typecheck

  build:
    runs-on: ubuntu-24.04-arm
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v6
        with:
          node-version: lts/*
          cache: pnpm
      - run: pnpm i
      - run: pnpm build

  test:
    runs-on: ubuntu-24.04-arm
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v6
        with:
          node-version: lts/*
          cache: pnpm
      - run: pnpm i
      - run: pnpm test --run
```

## .github/workflows/release.yml

### Single repo

```yaml
name: Release

permissions:
  contents: write
  id-token: write

on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    runs-on: ubuntu-24.04-arm
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v6
        with:
          node-version: lts/*
          cache: pnpm
          registry-url: https://registry.npmjs.org

      - run: npx changelogithub
        env:
          GITHUB_TOKEN: ${{secrets.GITHUB_TOKEN}}

      - run: pnpm i

      - run: pnpm build

      - run: pnpm publish --access public --no-git-checks
        env:
          NODE_AUTH_TOKEN: ${{secrets.NPM_TOKEN}}
```

### Monorepo

```yaml
name: Release

permissions:
  contents: write
  id-token: write

on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    runs-on: ubuntu-24.04-arm
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v6
        with:
          node-version: lts/*
          cache: pnpm
          registry-url: https://registry.npmjs.org

      - run: npx changelogithub
        env:
          GITHUB_TOKEN: ${{secrets.GITHUB_TOKEN}}

      - run: pnpm i

      - run: pnpm build

      - run: pnpm publish -r --access public --no-git-checks
        env:
          NODE_AUTH_TOKEN: ${{secrets.NPM_TOKEN}}
```

## .github/workflows/ci.yml (Site)

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.event.number || github.sha }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  lint:
    runs-on: ubuntu-24.04-arm
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v6
        with:
          node-version: lts/*
          cache: pnpm
      - run: pnpm install --filter . --ignore-scripts
      - run: pnpm lint

  typecheck:
    runs-on: ubuntu-24.04-arm
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v6
        with:
          node-version: lts/*
          cache: pnpm
      - run: pnpm install
      - run: pnpm build
      - run: pnpm typecheck

  test:
    runs-on: ubuntu-24.04-arm
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v6
        with:
          node-version: lts/*
          cache: pnpm
      - run: pnpm install
      - run: pnpm test:run
```

## CI Rules

### Runner

- Always use `ubuntu-24.04-arm` — never `ubuntu-latest`
- 4 vCPUs on public repos (vs 2 on x64), ~37% cheaper on private repos
- Most Node.js native deps ship `linux-arm64-gnu` binaries; WASM deps are platform-independent

### Job structure

- **Parallel jobs**: Split lint, typecheck, build, test into separate jobs — wall-clock time = slowest job, not sum
- **Concurrency control**: Always add `concurrency` with `cancel-in-progress: true` to avoid wasting resources on superseded runs
- **Selective install**: Lint-only jobs in monorepos/sites can use `pnpm install --filter . --ignore-scripts`

### Caching

- Always set `cache: pnpm` on `actions/setup-node` — caches pnpm store across runs (~30-60s savings on warm cache)

## Action Versions (latest)

- `actions/checkout@v6`
- `actions/setup-node@v6`
- `pnpm/action-setup@v4`
