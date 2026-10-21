# Source audit

Audit date: 2026-10-21.
Source: [harlan-agent-kit at 2d184d86](https://github.com/harlan-zw/harlan-agent-kit/tree/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e).
All code findings below refer to this revision.

Recommend extracting mechanisms behind a new workflow contract.
Publishing the existing service wholesale would expose personal policy and a much larger installation surface.
The findings distinguish current defects from intentional behavior that limits the proposed product.

## Scope and evidence

Three parallel audits covered runtime architecture, portability, and [GitHub](https://github.com) interactions.
The sweep queried all open issues and pull requests in the repository on the audit date.
The query returned seven issues and three pull requests.
It also fetched the four Routine report threads and examined their latest reports.
Historical reports supplied leads. Current source and API reproductions determined the conclusions.

The architecture and UX audits exercised exported APIs.
The UX audit also passed 91 existing tests across eight focused files.
No live GitHub App or paid provider execution formed part of these findings.

## Architectural findings

| Finding | Classification | Evidence |
| --- | --- | --- |
| Webhooks discard payloads and retain delivery deduplication in memory. | Intentional reconciliation design; durable-event blocker | [webhook.ts:54](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/webhook.ts#L54), [webhook.ts:184](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/webhook.ts#L184) |
| Task planning lives inside the SQL store. | Extraction coupling | [store.ts:8096](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/store.ts#L8096) |
| Task kinds and agent roles form closed unions. | Custom-workflow limitation | [types.ts:635](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/types.ts#L635), [types.ts:770](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/types.ts#L770) |
| Routine configuration selects compiled handlers. | Deliberate authority boundary; different contract | [routine-spec.ts:13](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/routine-spec.ts#L13) |
| Existing workflow events record telemetry rather than complete execution history. | Persistence limitation | [types.ts:1097](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/types.ts#L1097) |
| Startup recovery assumes exclusive controller ownership. | Single-controller operating assumption | [store.ts:11262](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/store.ts#L11262) |
| Lease fencing and remote publication reconciliation exist. | Reusable strength | [worker-task-scheduler.ts:75](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/worker-task-scheduler.ts#L75), [publication-scheduler.ts:86](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/publication-scheduler.ts#L86) |

## Reproduced source defects

### Provider pauses consume Routine attempts

The store increments Routine attempts on claim.
Its failure path does not distinguish a provider admission pause from failed execution.
Task and worker-task failure paths already refund these pauses.
The reservation race can occur after the provider-availability precheck.

An in-memory exported-API reproduction returned:

| Pause | Attempt | Result |
| --- | --- | --- |
| First | 1 | Retrying |
| Second | 2 | Retrying |
| Third | 3 | Failed |

Evidence: [claim accounting](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/store.ts#L16116), [Routine failure](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/store.ts#L16239), [worker-task pause handling](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/store.ts#L10992).

Fix the category through a deferred-admission result shared by every task type, as specified in C05.
Avoid another sentence-matching refund branch.

### Deterministic provider settings still retry

The wrapped `Variant unavailable` rejection classifies as transient `agent_provider`.
The exported API reports immediate retry permission and automatic recovery through round eleven.
Recovery stops at round twelve. The historical infinite-loop description overstates this source revision.
The provider health path separately recognizes `provider_config` and excludes the failure from circuit health.

Evidence: [classification](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/failure.ts#L297), [recovery cap](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/failure.ts#L380), [health exclusion](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/store.ts#L13901).

Reconcile [issue 604](https://github.com/harlan-zw/harlan-agent-kit/issues/604) and [pull request 606](https://github.com/harlan-zw/harlan-agent-kit/pull/606) before introducing another repair.
Use the same typed failure classification for task retry and provider health, as specified in C06.

### Information commands become change requests

Calling exported `parsePullRequestCommand` returns `Change` for addressed help, pause, status, and review commands.
Only the exact re-run command returns `Rerun`.
The controller routes `Change` to `requestPullRequestChange`.
This behavior follows the existing parser contract. It becomes unsafe for a public information-command interface.

Evidence: [parser](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/review-rerun.ts#L19), [controller](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/review-rerun-controller.ts#L38).

## Other public interaction gaps

| Gap | Evidence | Work |
| --- | --- | --- |
| Owner-login checks cannot express organization collaborator authority. | [service.ts:1387](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/service.ts#L1387), [controller:29](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/review-rerun-controller.ts#L29) | U02 |
| Comment scans stop at the latest 100; old thread roots can disappear from context. | [github.ts:446](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/github.ts#L446) | C09 |
| Finding replies request full reviews rather than in-thread answers. | [github.ts:478](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/github.ts#L478) | U04 |
| Check runs support only running, success, and neutral; headings supply part of the state. | [review-check-run.ts:9](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/review-check-run.ts#L9), [outcome parsing:3128](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/store.ts#L3128) | U03 |
| Native check re-run events only wake reconciliation. | [webhook event handling](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/webhook.ts#L20) | U03 |
| Native finding publication fixes locations to RIGHT. | [publisher:1368](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/github-agent-source.ts#L1368) | U06 |

## Portability blockers

| Blocker | Evidence | Work |
| --- | --- | --- |
| Private package; dashboard, terminal, emergency, and workspace build dependencies. | [package manifest](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/package.json) | U08 |
| Root Skill manifest and personal instructions enter runtime setup. | [agent-context.ts:8](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/agent-context.ts#L8) | U09 |
| Fixed checkout roots and service storage paths. | [config.ts:888](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/config.ts#L888) | U09 |
| Personal actor defaults and hardcoded publication identity. | [discovery:143](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/repository-discovery.ts#L143), [review-comment.ts:6](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/review-comment.ts#L6) | U09 |
| Both agent binaries and personal host-capacity tooling enter execution setup. | [sandbox:215](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/agent-sandbox.ts#L215), [service:540](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/service.ts#L540) | C06, U09 |
| Dashboard password and commit identity enter preflight for all modes. | [preflight:77](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/service-preflight.ts#L77) | U07 |
| Update operations assume a source checkout and personal deployment scripts. | [service-update.ts:104](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/packages/harlan-github-agent/src/service-update.ts#L104) | U10, U11 |

Existing token scoping, sandbox restrictions, private provider homes, and proof controls are valuable extraction inputs.
Preserve them through explicit capability contracts, rather than removing them to make installation easier.

## GitHub work reconciliation

The following table records relevance, rather than durable open or closed status.
Query each linked issue and pull request before implementation.

| Work | Relevance and treatment |
| --- | --- |
| [604](https://github.com/harlan-zw/harlan-agent-kit/issues/604), [606](https://github.com/harlan-zw/harlan-agent-kit/pull/606) | Provider configuration retries. Reconcile with C06. |
| [605](https://github.com/harlan-zw/harlan-agent-kit/issues/605), [608](https://github.com/harlan-zw/harlan-agent-kit/pull/608) | Dependency baseline, including dashboard-only changes. Choose the extraction baseline deliberately. |
| [607](https://github.com/harlan-zw/harlan-agent-kit/issues/607), [609](https://github.com/harlan-zw/harlan-agent-kit/pull/609) | Dashboard and notes-viewer build warnings. Retain with those apps. |
| [109](https://github.com/harlan-zw/harlan-agent-kit/issues/109) | Agent-feedback report thread. Historical signals require current-source confirmation. |
| [271](https://github.com/harlan-zw/harlan-agent-kit/issues/271) | CI report thread. Supplies context for 607. |
| [272](https://github.com/harlan-zw/harlan-agent-kit/issues/272) | Dependency report thread. Supplies context for 605. |
| [513](https://github.com/harlan-zw/harlan-agent-kit/issues/513) | Runtime report thread. Supplied leads for the two reproduced provider faults. |

The audited source includes canary renewal from [600](https://github.com/harlan-zw/harlan-agent-kit/pull/600).
It also excludes deterministic configuration failures from provider health through [611](https://github.com/harlan-zw/harlan-agent-kit/pull/611).
Do not reopen those historical mechanisms as new defects.
The remaining admission-accounting and task-classification faults require their own current-source checks.

## Verification boundary

The 91 focused tests prove existing interaction behavior, including the existing parser contract.
The in-memory reproduction proves the described current retry and pause-accounting results.
Neither establishes the proposed Octorun runtime or a public installation.
Use C12 and U11 for those end-to-end acceptance paths.

The local repository Check passed lint and typecheck, then failed its CLI installation test.
The same test failed on the unchanged source checkout.
It expects a desktop service URL, while this host selects Hogwild loopback.
Evidence: [host-dependent assertion](https://github.com/harlan-zw/harlan-agent-kit/blob/2d184d86bf2aebd9c22ca7d17e30898a7e7f759e/scripts/agent-cli.test.ts#L38).
U11 requires test fixtures that do not depend on the real host's identity.
