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
    paths-ignore:
      - '**/*.md'
  push:
    branches: [main]
    paths-ignore:
      - '**/*.md'

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  wolfstar-desktop:
    uses: wolfstar-project/wolfstar-nuxt/.github/workflows/wolfstar-desktop-site-ci.yml@main
    with:
      runs-on: '["ubuntu-24.04-arm"]'
```

Lint, typecheck and test arrive as three separately failing checks. The job key
becomes the check name, so `wolfstar-desktop` reads as `wolfstar-desktop / lint` on a
pull request, which is also the string a branch rule requires.

The caller ignores Markdown-only changes. If site content needs a build, replace
`paths-ignore` with `paths` and name the Markdown paths. GitHub forbids both filters
on one event.

This event filter suits a site whose default branch requires no checks. If a branch
rule requires `wolfstar-desktop / lint` or another gate check, remove `paths-ignore`.
An event filter starts no run, so the required check never reports and a docs-only
pull request blocks forever. Without a `changes` job in the shared workflow, a
docs-only pull request then runs the full gate. To skip that work, add the job-level
skip from `references/github-actions.md` there.

Inputs worth knowing:

| Input                                               | When to change it                                                                                                                                         |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runs-on`                                           | JSON array of labels. `'["self-hosted", "linux", "x64", "wolfstar-desktop-ci"]'` moves the site onto the workstation pool. **Private repositories only.** |
| `install-args`                                      | Defaults to `--ignore-scripts`. Pass `''` when the site has a `postinstall: nuxt prepare` that vitest or typecheck depends on.                            |
| `prepare-command`                                   | Runs before typecheck and test only. Use `pnpm nuxt prepare` when the checks need generated output but lint does not.                                     |
| `lint-command`, `typecheck-command`, `test-command` | Override, or pass `''` to skip that job entirely. Do not invent a passing stub for a script the site does not have.                                       |

Two traps that have already cost time:

- A site whose `lint` script mutates files cannot be gated by it. Use the
  non-mutating `lint-command: pnpm exec oxlint . && pnpm exec oxfmt --check .`.
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
      - uses: wolfstar-project/wolfstar-nuxt/.github/actions/wolfstar-desktop-setup@main
```

Under the event filter, a Markdown-only change does not start this `workflow_run`
path because CI did not run. Under a job-level skip, CI concludes `success` on that
change, so this deploy runs. `workflow_dispatch` remains the explicit deployment opt-in.

Never compare `head_sha` against `github.sha`. On a `workflow_run` event
`github.sha` is the default branch tip at dispatch time, not the commit the run
covered, so the comparison skips the deploy whenever main advances mid-run and
passes only by coincidence otherwise.

## Self-hosted runners

Only private repositories may use the `wolfstar-desktop-*` labels. A self-hosted
runner on a public repository lets a fork pull request run code on the
workstation. See `wolfstar-project/wolfstar-nuxt`, `infra/github-runner`.
