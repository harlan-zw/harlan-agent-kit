# Interface Design (TS Package)

When the user wants to explore alternative interfaces for a chosen deepening candidate, use this parallel sub-agent pattern. Based on "Design It Twice" (Ousterhout) — your first idea is unlikely to be the best.

Uses the vocabulary in [LANGUAGE.md](LANGUAGE.md) — **module**, **interface**, **seam**, **adapter**, **leverage** — and the seam catalogue in [TS-PKG-SEAMS.md](TS-PKG-SEAMS.md).

## Two flavours of candidate

The design space depends on what kind of candidate the user picked:

- **Seam-shaped candidate** — the question is *which TS-pkg seam should host the deepened module* (factory vs subpath export vs workspace package vs ports & adapters). Use the four seam-anchored sub-agents below.
- **Convention-shaped candidate** — the user picked a missing convention (factory shape, hook bus, error mode, CLI, config loader, etc. from [PKG-CONVENTIONS.md](PKG-CONVENTIONS.md)). The seam is already chosen by the convention. The design space is the convention's *interface shape*. See "Convention-shaped sub-agents" below.

## Process

### 1. Frame the problem space

Before spawning sub-agents, write a user-facing explanation of the problem space for the chosen candidate:

- The constraints any new interface would need to satisfy (runtime targets — node/browser/edge/workerd/bun; public vs private; SemVer impact; treeshake/`sideEffects` contract; hook ordering; sync vs async).
- The dependencies it would rely on, and which category they fall into (see [DEEPENING.md](DEEPENING.md)).
- A rough illustrative code sketch to ground the constraints — not a proposal, just a way to make the constraints concrete (e.g. a tiny `package.json` `exports` fragment, a usage line for the proposed factory).

Then proceed to Step 2.

### 2. Spawn sub-agents

#### Seam-shaped sub-agents

Spawn 4 sub-agents in parallel using the Agent tool. Each must produce a **radically different** interface for the deepened module, anchored in a different TS-pkg seam from [TS-PKG-SEAMS.md](TS-PKG-SEAMS.md).

Prompt each sub-agent with a separate technical brief (file paths, coupling details, dependency category from [DEEPENING.md](DEEPENING.md), what sits behind the seam). The brief is independent of the user-facing problem-space explanation in Step 1. Give each agent a different TS-pkg-shaped design constraint:

- **Agent 1 — Single factory**: "Design as a single `createX(opts): X` factory exported from the package root. Minimise the options surface — aim for 3–5 keys. Maximise leverage per option. Hide all existing files as private implementation under `src/<feature>/`. No hook bus unless an extension point is genuinely real."
- **Agent 2 — Factory + hook bus**: "Design as `createX(opts)` returning `{ ..., hooks }` backed by `hookable`. Define the typed hook map as the extension interface. Optimise for the case where consumers want to observe or extend specific lifecycle points without forking. List the hooks and their ordering."
- **Agent 3 — New subpath export**: "Design as a new subpath in `package.json` `exports` (e.g. `./pipeline`). Decide what's at the subpath vs at the root. Define the subpath's public surface and what stays private. Optimise for discoverability — a consumer should know whether to import from `pkg` or `pkg/pipeline` without reading docs."
- **Agent 4 — Ports & adapters**: "Design around an explicit port at the seam, with at least two adapters (production + test, or node + browser). Inject the adapter through factory options. Optimise for testability and for swapping providers (and runtimes if relevant)."

#### Convention-shaped sub-agents

Spawn 3 sub-agents, each designing a different *interface shape* for the chosen convention. Example, for **Hook bus** (PKG-CONVENTIONS.md §2): Agent A = `hookable` typed map; Agent B = callback options (`onBeforeRun`, `onAfterRun`); Agent C = event emitter with `.on(name, fn)`. Derive analogous trios from the relevant PKG-CONVENTIONS.md section for factory shape, error modes, CLI, config loader.

Each sub-agent's brief includes the convention file's "Gap" + "Seam" entries plus the constraints from Step 1.

Include [LANGUAGE.md](LANGUAGE.md) vocabulary, [TS-PKG-SEAMS.md](TS-PKG-SEAMS.md) vocabulary, the relevant convention section, and CONTEXT.md vocabulary in each brief so every sub-agent names things consistently.

Each sub-agent outputs: (1) interface — options + return / subpath surface / port type / hook map, plus invariants, ordering, error modes, runtime targets; (2) usage example with realistic import specifiers; (3) what hides behind the seam (which files become private, resulting `exports` map); (4) dependency strategy and adapters (see [DEEPENING.md](DEEPENING.md)); (5) trade-offs and SemVer impact.

### 3. Present and compare

Present sequentially, then contrast by **depth**, **locality**, **seam placement**, **runtime portability**, and **SemVer impact**. Give a recommendation; propose a hybrid if elements combine well.
