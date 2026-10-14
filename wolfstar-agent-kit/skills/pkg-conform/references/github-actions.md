# GitHub Actions

**Packages only.** For a Site, use `references/site-github-actions.md` instead.
Sites call one shared reusable workflow rather than repeating the setup steps
below; copying this file into a site re-creates the drift that workflow exists to
remove.

## .github/workflows/ci.yml (Package)

This template filters Markdown at the event. Use it only when the default branch requires no checks.
If the branch requires checks, use the job-level skip below instead. See [Markdown paths](#markdown-paths).

```yaml
name: CI

on:
  push:
    paths-ignore:
      - '**/*.md'
  pull_request:
    paths-ignore:
      - '**/*.md'

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

### Required checks: job-level skip

Remove the event filter. Add a `changes` job, and give every other job `needs: changes` and the same `if:`.
A skipped job still reports its check, and GitHub passes a skipped required check.
The Nuxt SEO packages call `wolfstar-project/nuxt-seo/.github/workflows/reusable-ci.yml@main`, which holds this job already.

```yaml
on:
  # No event filter. The `changes` job skips the other jobs instead.
  push:
    branches: [main]
  pull_request:

jobs:
  changes:
    runs-on: ubuntu-24.04-arm
    outputs:
      code: ${{ steps.diff.outputs.code }}
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
          filter: blob:none
      - id: diff
        env:
          BASE: ${{ github.event.pull_request.base.sha || github.event.before }}
          HEAD: ${{ github.event.pull_request.head.sha || github.sha }}
        run: |
          # No usable base, such as a new branch: every job runs.
          if [ -z "${BASE//0/}" ] || ! changed=$(git diff --no-renames --name-only "$BASE...$HEAD" -- . ':(exclude,glob)**/*.md'); then
            echo "code=true" >> "$GITHUB_OUTPUT"
          elif [ -z "$changed" ]; then
            echo "code=false" >> "$GITHUB_OUTPUT"
          else
            echo "code=true" >> "$GITHUB_OUTPUT"
          fi

  lint:
    needs: changes
    # `!cancelled()` replaces the implicit `success()`, so a failed `changes` job still runs this job.
    if: ${{ !cancelled() && needs.changes.outputs.code != 'false' }}
    runs-on: ubuntu-24.04-arm
    steps:
    # The lint steps from the template above.
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

      - run: pnpm dlx changelogithub
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

      - run: pnpm dlx changelogithub
        env:
          GITHUB_TOKEN: ${{secrets.GITHUB_TOKEN}}

      - run: pnpm i

      - run: pnpm build

      - run: pnpm publish -r --access public --no-git-checks
        env:
          NODE_AUTH_TOKEN: ${{secrets.NPM_TOKEN}}
```

## .github/workflows/ci.yml (Site)

This event filter suits a site whose default branch requires no checks. See [Markdown paths](#markdown-paths).

```yaml
name: CI

on:
  push:
    branches: [main]
    paths-ignore:
      - '**/*.md'
  pull_request:
    branches: [main]
    paths-ignore:
      - '**/*.md'

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

### Markdown paths

- Test, build, and deploy workflows skip Markdown-only changes by default.
- Pick the shape from the required checks. Read rulesets with `gh api repos/OWNER/REPO/rules/branches/main`.
  Classic branch protection shows in the repository settings.
- If the branch requires no checks, filter at the event: `paths-ignore: ['**/*.md']` on `push` and `pull_request`.
- If the branch requires checks, never filter at the event. An event filter starts no run, so a required check never reports and a docs-only pull request blocks forever.
- Skip at the job level instead, as [Required checks: job-level skip](#required-checks-job-level-skip) shows. GitHub passes a skipped required check.
- A docs-only change then reports one passed `changes` check and skipped checks. CI concludes `success`, so a `workflow_run` deploy starts.
- A docs-only push to `main` also reads green when the commit before it failed. Read the last code commit for the real verdict.
- Use `paths` when a workflow must run for named Markdown files or directories.
- Never add `paths-ignore` to an event that already uses `paths`. GitHub rejects both on one event.
- Tag, schedule, and manual events keep their existing behavior. GitHub does not apply path filters to tag pushes.

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
