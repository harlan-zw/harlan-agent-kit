# Core implementation work

Recommend **C01 first**. Follow dependencies before comparing independent work by score.
Impact measures progress toward a portable workflow agent.
Confidence measures audit evidence and design fit. It does not certify implementation.
Effort includes implementation, verification, and rollout.

| Next step | Impact /100 | Effort S/M/L | Confidence /100 | Why |
| --- | --- | --- | --- | --- |
| C01. Define workflow and task contracts | 100 | M | 97 | All extraction boundaries depend on these contracts. |
| C02. Persist normalized events | 99 | M | 99 | Current webhooks discard the event after reconciliation hints. |
| C03. Pin configuration and authority | 99 | M | 97 | Untrusted pull requests must not grant their own execution rights. |
| C04. Extract planner, journal, and scheduler | 98 | L | 98 | Planning currently lives inside the application-wide SQL store. |
| C05. Separate admission holds from failures | 97 | M | 100 | Three provider pauses reproduced Routine attempt exhaustion. |
| C06. Generalize provider adapters | 94 | M | 98 | Configuration errors remain retryable; roles and providers are closed registries. |
| C07. Preserve isolation behind capabilities | 99 | L | 97 | Custom tasks expand the existing review-only trust boundary. |
| C08. Generalize publication reconciliation | 99 | M | 98 | Remote writes can succeed before local acknowledgement. |
| C09. Add polling recovery and parity | 95 | M | 98 | Recent-comment reads stop at 100; event transitions need separate recovery. |
| C10. Extract the adversarial-review preset | 97 | L | 96 | Review must consume the engine without owning its scheduler. |
| C11. Prove a custom task chain | 94 | M | 96 | A second workflow disproves hidden review-specific assumptions. |
| C12. Prove lifecycle and trust invariants | 99 | L | 95 | Source tests do not establish the extracted runtime's guarantees. |

## C01. Workflow and task contracts

Dependencies: none. Read [architecture](architecture.md) and [vocabulary](../../GLOSSARY.md).

- Define versioned selectors, ordered tasks, conditions, typed input references, capabilities, and limits.
- Define output schemas, artifact references, task implementation versions, and tagged failure outcomes.
- Reject unknown fields, duplicate IDs, invalid references, unsupported conditions, and missing task types.
- Acceptance: two repositories select different chains without editing planner code.

## C02. Durable events

Dependencies: C01. Read [event semantics](events-and-recovery.md).

- Persist authenticated delivery identity and bounded normalized data before acknowledgement.
- Separate delivery keys, semantic trigger keys, manual request IDs, and deliberate re-run identities.
- Acceptance: crash after acknowledgement loses no accepted event.
- Acceptance: webhook redelivery plus a matching poll observation creates one intended automatic run.

## C03. Trusted configuration and authority

Dependencies: C01.

- Compile definitions from a trusted commit and intersect their capabilities with operator limits.
- Pin definition, task versions, provider settings, policy digest, repository IDs, and relevant SHAs on every run.
- Keep secret references out of agent inputs, artifacts, and logs unless an authorized adapter needs them.
- Acceptance: a fork changes its workflow configuration and gains no execution or publication authority.
- Acceptance: configuration edits preserve run meaning; live access revocation blocks pending effects.
- Acceptance: an invalid configuration explains its exact path. A later policy expansion cannot widen an old run.

## C04. Planner, journal, and scheduler

Dependencies: C01, C02, C03.

- Extract a pure planner and a small transactional store. Keep review records outside generic runtime state.
- Share leases, heartbeats, timeouts, completion, concurrency groups, and cancellation across task types.
- Persist outputs and successor scheduling atomically. Acquire an exclusive controller lock before recovery.
- Acceptance: a stale worker cannot complete a task. A second controller refuses the same state directory.
- Acceptance: restart resumes unfinished work without rerunning completed tasks or reviving cancelled work.

## C05. Admission and retry accounting

Dependencies: C04. The source audit contains the reproduced pause-accounting defect.

- Represent deferred admission separately from execution failure, with structured wake conditions and retry times.
- Count claims, admitted executions, and failed executions separately. Bound attempts, elapsed time, and spend.
- Acceptance: four provider pauses consume no execution-failure allowance and stage no failure report.
- Acceptance: a later admitted attempt completes. Expired budgets produce one actionable terminal result.

## C06. Agent providers

Dependencies: C01, C05. Reconcile existing [issue 604](https://github.com/harlan-zw/harlan-agent-kit/issues/604) and [pull request 606](https://github.com/harlan-zw/harlan-agent-kit/pull/606).

- Decouple provider transport from review roles. Validate model and reasoning support for enabled providers only.
- Return typed configuration, authorization, capacity, transient, and permanent failures consistently.
- Keep per-task configuration failures outside provider health accounting.
- Acceptance: an unsupported model variant stops without repeated paid turns or provider-circuit changes.
- Acceptance: a host with one provider installed can run a selected workflow.

## C07. Restricted execution

Dependencies: C03, C04, C06.

- Inject checkout roots, protected paths, tool locations, process limits, and explicit network policy.
- Preserve credential exclusion, egress checks, private provider homes, and proof authority.
- Treat repository content, comments, and agent results as untrusted input.
- Acceptance: missing isolation refuses executable work before an agent starts.
- Acceptance: fork code cannot read controller credentials. Cancellation and OOM leave no child process alive.

## C08. Publication outbox

Dependencies: C03, C04.

- Persist desired effects with run generation, typed target snapshot, App identity, output key, and authorization evidence.
- Reconcile unknown remote results before retrying. Preserve stable comment and finding identities.
- Serialize conflicting mutations. Recheck target preconditions, cancellation, and permissions before dispatch.
- Acceptance: crash after a [GitHub](https://github.com) write produces one intended visible effect after recovery.
- Acceptance: durable cancellation or supersession blocks new dispatches. Reconcile writes already in flight without unauthorized retries.

## C09. Polling and delivery recovery

Dependencies: C02, C03, C08.

- Add pagination, durable cursors, overlap windows, stable IDs, and missing-thread lookup.
- Declare selectors supported by observations versus exact events. Recover failed deliveries explicitly.
- Provide explicit backfill selection and complete command controls in poll-only operation.
- Acceptance: command 101 and a reply to an old finding reach the same command path as webhooks.
- Acceptance: interrupted pagination resumes without losing commands or duplicating accepted requests.

## C10. Adversarial-review preset

Dependencies: C04, C06, C07, C08.

- Extract snapshot, context selection, bounded reviewers, finding verification, and review publication.
- Keep read-only review, optional repair, and CI readiness as separate capabilities and outcomes.
- Bound changed-file scope, context, findings, parallel reviewers, duration, and provider usage.
- Acceptance: clean, actionable, skipped, failed, cancelled, and superseded reviews produce distinct results.
- Acceptance: new-head and base-change tests prevent stale findings. Unsupported proof stays visibly unverified.

## C11. Custom-chain proof

Dependencies: C04, C06, C08.

- Register a classify, release-summary, and comment chain with typed outputs and conditional continuation.
- Acceptance: it runs without review records, review roles, or changes to scheduler internals.
- Acceptance: webhook and manual requests both work; recovery resumes at the interrupted task.

## C12. Lifecycle and security proof

Dependencies: C02 through C11. Write failing behavior tests before fixing reproduced defects.

- Cover duplicate deliveries, ordering, cancellation races, permission revocation, forks, and reaction loops.
- Cover crash boundaries, database migration, schema rejection, resource limits, and unknown write results.
- Run the exported contracts against fake providers and real process isolation in hosted CI.
- Acceptance: both presets pass the same lifecycle suite. One disposable live repository proves the GitHub path.
- Acceptance: review fixtures measure false positives, duplicates, evidence quality, latency, and bounded usage.
