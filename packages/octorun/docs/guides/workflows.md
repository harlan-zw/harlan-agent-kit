# Configure workflows

A workflow selects events and runs an ordered chain of tasks.
Each run pins its definition, event, repository snapshot, and repository policy.
Task outputs become available to later tasks.

## Select presets

Set `workflowSource` on each operator repository mapping:

```yaml
workflowSource:
  _tag: Presets
  presets:
    - adversarial-review
    - change-summary
```

The review preset captures changes, proposes findings, verifies them, and publishes a grouped review.
The summary preset classifies changes, writes a summary, and updates a comment.
Both run through the same task scheduler.

The operator policy limits capabilities for every task.
The initial CLI supports repository reads, agent requests, comments, reviews, and checks.
It does not enable shell execution, branch writes, or merges.
A repository definition cannot expand that policy.

## Load trusted repository definitions

Set a repository workflow source:

```yaml
workflowSource:
  _tag: Repository
  path: .github/octorun.yaml
```

Octorun reads this file from the repository's trusted default branch.
It records the source revision and definition digest on the run.
A pull request cannot change its own effective workflow by modifying that file.
The file contains data, with no JavaScript imports or executable configuration.

Use this document shape:

```yaml
version: 1
workflows:
  - version: 1
    id: change-summary
    name: Change summary
    on:
      - event: pull_request
        actions: [opened, synchronize, reopened, observed]
    concurrency:
      mode: replace
      group: target
    limits:
      maxAttempts: 3
      timeoutMs: 120000
      maxTokens: 50000
      maxCostUsd: null
      maxDurationMs: 600000
    tasks:
      - id: classify
        uses: changes.classify
        with: {}
      - id: summarize
        uses: changes.summarize
        with:
          changes:
            $ref: tasks.classify.output
      - id: comment
        uses: changes.comment
        with:
          summary:
            $ref: tasks.summarize.output
```

Operator-owned definitions use `_tag: Inline` with a `definitions` list in the same format.
Use `maxCostUsd: null` with the HTTP provider, which cannot establish the next request's price before sending it.
Token and duration budgets still apply.
Run `octorun validate` after changing operator configuration.
Run `octorun plan --repository owner/repository --pr 7` to inspect selected workflows before execution.
For the summary workflow above, select its ID explicitly:

```bash
octorun plan --repository owner/repository --pr 7 --workflow change-summary
octorun run --repository owner/repository --pr 7 --workflow change-summary
```

The preview pins the current head and base revisions and checks registered tasks against repository policy.
It starts no task and writes no GitHub result.
Without `--workflow`, manual requests select `adversarial-review`.

## Register a custom task type

The library supports operator-registered task types.
The CLI registers its packaged review and summary task types.
Use the library to register additional executable behavior.
Keep that code in your trusted host application.

The [complete custom task example](../../examples/custom-task.ts) runs in memory without GitHub access or provider credentials.
In a separate directory, install the package locally and run its example:

```bash
pnpm add /tmp/octorun.tgz
cp node_modules/@harlan-zw/octorun/examples/custom-task.ts ./custom-task.ts
node --experimental-strip-types custom-task.ts
```

It prints the `Succeeded` run state and the task's repository and target output.
The smaller snippet below shows the registration contract.

```ts
import type { TaskType } from '@harlan-zw/octorun'
import { createRunner, openStore, parseJsonValue } from '@harlan-zw/octorun'

const describeTarget: TaskType = {
  id: 'example.describe-target',
  version: '1',
  capabilities: ['repository:read'],
  input: parseJsonValue,
  output: parseJsonValue,
  execute: async context => ({
    _tag: 'Succeeded',
    output: {
      repository: context.event.repository.fullName,
      target: context.event.target,
    },
  }),
}

const store = openStore({ path: '/srv/my-octorun/state.sqlite' })
const runner = createRunner({ store, taskTypes: [describeTarget] })
// Supply parsed events, workflows, configuration sources, and repository policy through runner.ingest().
// Call runner.tick() to process admitted tasks. Close the runner and store when your host stops.
```

The final lines show host integration points.
A standalone host must also supply event ingestion, scheduling, and lifecycle handling.
The packaged CLI already supplies these for its built-in task types.

Each task declares a version and required capabilities.
Its input and output parsers return `Result` values.
Expected domain failures return a tagged task failure.
Capacity waits return `Deferred`, so admission holds do not consume execution attempts.
Use `context.signal` to stop external work after cancellation or timeout.

Before a paid agent request, call `context.reserveUsage(ceiling)` with its maximum usage.
If reservation fails, return the failure before sending the request.
After the provider confirms usage, call `context.settleUsage(reservationId, actual)`.
Settle only usage that the provider positively reports.
Repeating an identical settlement is safe; a changed settlement is rejected.
For an attempt with reservations, the runtime uses its ledger instead of the task's aggregate usage.
A timeout or crash keeps unknown usage charged at the reserved ceiling.

Use `context.publish(key, effect)` for durable GitHub writes.
Octorun records the desired comment, review, reply, or check before dispatch.
An unknown result must be reconciled against GitHub before another write.
External effects cannot share a database transaction with SQLite.
The runtime preserves identities and reconciles uncertain results to resist duplicates.
