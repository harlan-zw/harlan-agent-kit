# GitHub Actions (Site)

Do not copy `references/github-actions.md` into a site. That file is the Package
template, and its jobs each carry their own checkout, pnpm, Node and install
steps. Sites share one gate instead.

Ten sites used to hold ten copies of those four steps, and the copies drifted:
Node was pinned at 22, 24, `24.x`, `lts/*`, `24.11.0` and `24.18.0` across them,
and action refs ranged from floating `@v6` tags to pinned digests in the same
repository. The shared workflow exists to stop that recurring.

## The pull request gate

`.github/workflows/ci.yml`, roughly ten lines:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  harlan-desktop:
    uses: harlan-zw/harlan-nuxt/.github/workflows/harlan-desktop-site-ci.yml@main
    with:
      runs-on: '["ubuntu-24.04-arm"]'
```

Lint, typecheck and test arrive as three separately failing checks. The job key
becomes the check name, so `harlan-desktop` reads as `harlan-desktop / lint` on a
pull request, which is also the string a branch rule requires.

Inputs worth knowing:

| Input | When to change it |
| --- | --- |
| `runs-on` | JSON array of labels. `'["self-hosted", "linux", "x64", "harlan-desktop-ci"]'` moves the site onto the workstation pool. **Private repositories only.** |
| `install-args` | Defaults to `--ignore-scripts`. Pass `''` when the site has a `postinstall: nuxt prepare` that vitest or typecheck depends on. |
| `prepare-command` | Runs before typecheck and test only. Use `pnpm nuxt prepare` when the checks need generated output but lint does not. |
| `lint-command`, `typecheck-command`, `test-command` | Override, or pass `''` to skip that job entirely. Do not invent a passing stub for a script the site does not have. |

Two traps that have already cost time:

- A site whose `lint` script is `eslint . --fix` cannot be gated by it. The fix
  rewrites the tree and exits 0, so the check never fails. Pass
  `lint-command: pnpm exec eslint .`.
- `--ignore-scripts` skips `postinstall: nuxt prepare`, and vitest resolves
  aliases through `.nuxt/tsconfig.json`. Without it every suite fails to
  transform. Set `install-args: ''` or `prepare-command`.

## Build and deploy

Build stays in the site's own workflow. It needs that site's production secrets
and a reusable workflow cannot take an open-ended `env` block.

Deploy should wait on the gate rather than repeat it:

```yaml
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
  workflow_dispatch:

concurrency:
  group: deploy-production
  # A deploy in flight must finish. Wrangler uploads and activates a Worker
  # version, and cancelling part-way leaves it uploaded but not activated.
  cancel-in-progress: false

jobs:
  deploy:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.head_branch == 'main')
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.workflow_run.head_sha || github.sha }}
      - uses: harlan-zw/harlan-nuxt/.github/actions/harlan-desktop-setup@main
```

Never compare `head_sha` against `github.sha`. On a `workflow_run` event
`github.sha` is the default branch tip at dispatch time, not the commit the run
covered, so the comparison skips the deploy whenever main advances mid-run and
passes only by coincidence otherwise.

## Self-hosted runners

Only private repositories may use the `harlan-desktop-*` labels. A self-hosted
runner on a public repository lets a fork pull request run code on the
workstation. See `harlan-zw/harlan-nuxt`, `infra/github-runner`.
