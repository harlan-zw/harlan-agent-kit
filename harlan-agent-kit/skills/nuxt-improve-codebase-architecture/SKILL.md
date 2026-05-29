---
name: nuxt-improve-codebase-architecture
description: Find deepening opportunities in a Nuxt codebase, leaning on Nuxt-native seams (hooks, modules, layers, plugins, composables, server routes, nitro, runtime config). Use when the user wants to improve architecture, find refactoring opportunities, consolidate tightly-coupled modules, or make a Nuxt app/module more testable and AI-navigable.
effort: high
---

# Improve Nuxt Codebase Architecture

Surface architectural friction in a Nuxt codebase and propose **deepening opportunities** — refactors that turn shallow modules into deep ones, using Nuxt's own extension points as seams. The aim is testability and AI-navigability.

## Vocabulary and principles

Use the terms in [LANGUAGE.md](LANGUAGE.md) exactly — **module**, **interface**, **implementation**, **depth**, **seam**, **adapter**, **leverage**, **locality**. Don't drift into "component," "service," "API," or "boundary."

Load-bearing principles (full list in LANGUAGE.md):

- **Deletion test**: if deleting the module just inlines 1-2 lines into each caller, it was a pass-through.
- **The interface is the test surface.**
- **One adapter = hypothetical seam. Two = real.**
- **No import-time side effects** — critical for `shared/`, composables, server utils.
- **Prefer Nuxt-native seams** over hand-rolled equivalents.
- **Default feature-local, promote on evidence.** New `composables/useFoo.ts` or `components/Foo.vue` is a claim of app-wide ownership; the rename blast radius and naming-collision risk make global auto-import the most expensive seam decision. Colocate + `_`-prefix until ≥2 unrelated features consume it.

This skill is _informed_ by the project's domain model. The domain language gives names to good seams; ADRs record decisions the skill should not re-litigate.

## Companion files

- [LANGUAGE.md](LANGUAGE.md) — full vocabulary and principles.
- [DEEPENING.md](DEEPENING.md) — dependency categories, seam ladder (`shared/` → `packages/*` → Nuxt module/layer), testing strategy.
- [NUXT-SEAMS.md](NUXT-SEAMS.md) — catalogue of Nuxt's framework-native seams and the scope boundaries between nitro / nuxt server / nuxt client.
- [NITRO-CONVENTIONS.md](NITRO-CONVENTIONS.md) — server-side conventions Nitro doesn't ship (validators, policies, presenters, error handling, service providers, event/listener registry, tasks, job dispatch, per-layer schema + migrations).
- [VUE-CONVENTIONS.md](VUE-CONVENTIONS.md) — framework-agnostic Vue patterns (service composables as factory + `provide` + `use`, component thinness).
- [NUXT-APP-CONVENTIONS.md](NUXT-APP-CONVENTIONS.md) — Nuxt-specific app layer (`$fetch` as port, async resource composables, `useState` for SSR-safe app-wide state, client policy mirror).
- [INTERFACE-DESIGN.md](INTERFACE-DESIGN.md) — design-it-twice with parallel sub-agents for chosen candidates.

## Process

### 1. Explore

**Always run ripast first.** Every claim about depth, caller counts, locality, or cross-scope leaks must cite a ripast invocation. Text search misses shadowed identifiers, type-only imports, Vue template refs, and Nuxt auto-imported callers.

Pass `--tsconfig .nuxt/tsconfig.json` on `tree`/`rename`/`move`/`rename-file` so auto-imports resolve. Run `nuxi prepare` first if `.nuxt/` is stale. For `scan` (rg-driven) and when trimming `tree`, scope with `--glob`:

```
--glob 'app/**,server/**,composables/**,plugins/**,modules/**,layers/**,shared/**,nuxt.config.ts'
```

Adjust per project: drop `app/**` pre-Nuxt-4 (use `pages/**,components/**`), drop `layers/**` if none, add `packages/**` or a module's `src/**`.

Opening pass — run before forming any candidate:

| Command | What it surfaces |
| --- | --- |
| `npx -y @ripast/cli unused --tsconfig .nuxt/tsconfig.json --exports local` | Top-level declarations with zero project references → deletion-test slam-dunks |
| `npx -y @ripast/cli tree --exports exported --tsconfig .nuxt/tsconfig.json` | Public surface per file → shallow modules (tiny interface + tiny impl) |
| `npx -y @ripast/cli tree --exports local --tsconfig .nuxt/tsconfig.json` | Internals per file → locality opportunities |
| `npx -y @ripast/cli css-class-scan --glob 'app/**,layers/**,components/**,pages/**'` | Class-token inventory → design-token consolidation candidates |

Per-candidate, before listing (`scan` is rg-driven — use `--glob` here):

| Command | What it surfaces |
| --- | --- |
| `npx -y @ripast/cli scan <symbol> --glob ...` | Caller count + kind classification → drives deletion test + §2 thresholds |
| `npx -y @ripast/cli scan <symbol> --kind identifier-reference,import-specifier --glob ...` | Same, minus string-literal noise |
| `npx -y @ripast/cli scan <symbol> --graph mermaid --glob ...` | Importer graph → cross-scope leaks (graph spanning `server/` + `composables/` + `plugins/`) |

Cite numbers when presenting ("`scan` returns 2 callers, both in `server/api/` — single-scope, deletion test fails").

Read the project's domain glossary and any ADRs in the area first. Then orient on the Nuxt shape of the project:

- Is this a Nuxt **app**, a Nuxt **module**, or a workspace with **layers**?
- Which Nuxt extension points are already in use: `modules/`, `layers/`, `plugins/`, `composables/`, `server/api`, `server/middleware`, `nitro` plugins, `runtimeConfig`, `app:*`/`nitro:*`/`build:*` hooks, `addImports`, `addServerHandler`, `addComponent`, `addPlugin`?
- Where does the project hand-roll its own seam (a singleton, a custom plugin pattern, a global registry) instead of using one Nuxt provides?

Then use `subagent_type=Explore` to walk the codebase. Friction signals:

- Feature requires bouncing across `composables/`, `plugins/`, `server/api`, `runtimeConfig` — `scan --graph mermaid` spanning ≥3 Nuxt scopes = no central seam.
- **Shallow modules**: composable wrapping a single `useState`, plugin providing one untyped value, server util that's a one-line `$fetch` passthrough. Spot via `tree --exports exported`.
- Pure functions extracted for testability while real bugs hide in plugin order / hook timing / SSR vs client divergence (no locality).
- Cross-cutting concerns (auth, logging, telemetry) smeared across `app/`, `server/`, `nitro` instead of sitting behind one hook/module.
- A cluster of plugins + composables + server handlers that wants to be a Nuxt module or layer with a small options + hooks interface.
- Walk the convention files for missing seams: each "Gap" entry is a candidate when present in the codebase.
- **Cross-scope leaks.** `types/`/`utils/`/`constants/` imported from both `server/` and `composables/` — move to `shared/`. Detect with `scan --graph mermaid`: importer set straddling both = leak.
- **Import-time side effects** in `shared/`, composables, or server utils — fire in every consumer, break SSR/treeshaking/tests.

### 2. Present candidates

Present a numbered list of deepening opportunities. For each candidate:

- **Files** — which files/modules are involved (include the Nuxt-flavoured paths: `modules/foo.ts`, `layers/billing/`, `server/api/x.post.ts`, `plugins/auth.client.ts`, `composables/useBar.ts`, `nuxt.config.ts`)
- **Problem** — why the current architecture is causing friction
- **Solution** — plain English description of what would change, named in Nuxt terms (e.g. *"collapse these three plugins and two composables into a single Nuxt module that registers `addImports` for the public composables and an `app:created` hook for the singleton wiring"*)
- **Benefits** — explained in terms of locality and leverage, and also in how tests would improve (e.g. *"the module can be tested with `@nuxt/test-utils` against a fixture; today the plugin's behaviour can only be observed through a full app boot"*)

**Use CONTEXT.md for the domain, [LANGUAGE.md](LANGUAGE.md) for the architecture, [NUXT-SEAMS.md](NUXT-SEAMS.md) for the framework seam, and the relevant convention file + section number when the candidate is a convention gap.** Example phrasings: *"the Order intake module exposed as a Nuxt layer"*, *"establish NITRO-CONVENTIONS.md §1 for the Order create handler"* — not *"the FooBarHandler"*, not *"the Order service"*.

**Reject before listing.** Bias toward fewer, sharper candidates. Validate caller counts with `scan --kind identifier-reference,import-specifier` scoped to the **whole project** (no `--glob` narrowing to the candidate's own layer/dir), and confirm the shape they consume — a uniform interface for the wrapper is a precondition for collapsing it. Cross-layer callers with a different state shape break the candidate. No guesswork.

- **Deletion test fails.** Thresholds: single caller = adapter, not a seam; Nuxt layer/module needs ≥3 plugins/composables/handlers + shared config or hooks; schema/policy/presenter/validator/async-resource composable earns its keep at ≥2 callers OR real branching/transform; pure value/type mapping (just destructure/rename) needs ≥4 callers.
- **No locality win.** "Testable in isolation" / "future-proof" without bugs/changes concentrating is relocation, not depth. Includes defensive re-validation of invariants a zod schema, typed event, or DB column already enforces.
- **Renames or file reshuffles** dressed up as architecture. Note separately or skip.
- **Smuggles import-time side effects.**
- **Already matches a NITRO/VUE/NUXT-APP convention.**
- **Meta-handler with no work.** `defineApiHandler` earns its keep only when ≥2 of {validation, auth, presenter, domain-error mapping} fire per call.
- **Render-factory composable.** Mostly `h()` calls / column defs / template output with little reactive state. Acceptable at ≥4 callers; otherwise inline or slot-scope.
- **Promotes to global auto-import without cross-feature consumers.** Reject if `scan --tsconfig .nuxt/tsconfig.json` shows callers in a single feature dir — keep colocated + `_`-prefixed. Promote only at ≥2 unrelated feature consumers. See [NUXT-SEAMS.md](NUXT-SEAMS.md) §"Internal vs global scope".
- **Bundled-concern composable** fusing ≥3 concerns (fetch + cache + optimistic + rollback + retry) with no override seams.
- **Wrapper-collapse without project-wide caller audit.** A "delete this pass-through wrapper, inline into N callers" candidate is invalid until `scan <Wrapper> --kind identifier-reference,import-specifier` (no `--glob`) has been run and every caller's consumed-shape verified. Wrappers in most cases have cross-layer callers (admin pages, ad-hoc usages) that don't share the "obvious" caller's state shape; collapsing on a partial census produces a narrower interface that breaks the outliers at typecheck.
- **Config threaded through ≥3 layers unchanged** = missing seam. Consume at creation layer or place adapter at deepest meaningful seam.
- **Single-reader `runtimeConfig` key.** Confirm with `scan --kind property,member-access`; one hit = fails unless genuinely env-overridable at deploy.
- **Hides `event` behind a global accessor.** Server abstractions thread `H3Event` through — reject module-level singletons, ambient `useRuntimeConfig()` without `event`, implicit `getRequestEvent()`.
- **Contradicts a current ADR without a load-bearing reason.**

**Forbidden patterns** — always flag, never propose. Full lists in NITRO-CONVENTIONS.md and NUXT-APP-CONVENTIONS.md "Forbidden patterns". Headline: **never wrap an authenticated route in `defineCachedEventHandler`** — the cache wrapper strips request headers, breaking session/auth. Hoist auth to an outer `defineEventHandler` and cache the data fetch via `defineCachedFunction` keyed on the resource.

**ADR conflicts**: if a candidate contradicts an existing ADR, only surface it when the friction is real enough to warrant revisiting the ADR. Mark it clearly (e.g. _"contradicts ADR-0007 — but worth reopening because…"_). Don't list every theoretical refactor an ADR forbids.

Do NOT propose interfaces yet. Ask the user: "Which of these would you like to explore?"

### 3. Grilling loop

Once the user picks a candidate, drop into a grilling conversation. Walk the design tree with them — constraints, dependencies, the shape of the deepened module, what sits behind the seam, what tests survive. For Nuxt candidates, also walk: which Nuxt hook fires when, SSR vs client behaviour, build-time vs runtime, where `runtimeConfig` ends and component state begins.

Side effects happen inline as decisions crystallize:

- **Naming a deepened module after a concept not in `CONTEXT.md`?** Add the term to `CONTEXT.md` — same discipline as `/grill-with-docs` (see [CONTEXT-FORMAT.md](../grill-with-docs/CONTEXT-FORMAT.md)). Create the file lazily if it doesn't exist.
- **Sharpening a fuzzy term during the conversation?** Update `CONTEXT.md` right there.
- **User rejects the candidate with a load-bearing reason?** Offer an ADR, framed as: _"Want me to record this as an ADR so future architecture reviews don't re-suggest it?"_ Only offer when the reason would actually be needed by a future explorer to avoid re-suggesting the same thing — skip ephemeral reasons ("not worth it right now") and self-evident ones. See [ADR-FORMAT.md](../grill-with-docs/ADR-FORMAT.md).
- **Want to explore alternative interfaces for the deepened module?** See [INTERFACE-DESIGN.md](INTERFACE-DESIGN.md). Sub-agents are pre-seeded with Nuxt-native shapes (module + hooks, layer, plugin + composable, nitro plugin) so the design space is grounded in what Nuxt already offers.
- **Need to know the true blast radius of a rename/move before committing?** `npx -y @ripast/cli scan <symbol>` (counts) or `npx -y @ripast/cli scan <symbol> --graph mermaid` (importer graph). Quote numbers before promising scope.
- **Decision crystallized into a concrete refactor?** Execute through ripast (`--tsconfig .nuxt/tsconfig.json` rewrites auto-imported callers too):

  | Refactor | Command |
  | --- | --- |
  | Rename symbol | `npx -y @ripast/cli rename <from> <to> --tsconfig .nuxt/tsconfig.json --apply` (`--scope <file>` if multi-declared) |
  | Move exported declaration | `npx -y @ripast/cli move <symbol> --from <a> --to <b> --tsconfig .nuxt/tsconfig.json --apply` |
  | Move a file | `npx -y @ripast/cli rename-file <old> <new> --tsconfig .nuxt/tsconfig.json --apply` |
  | Design-token / class migration | `npx -y @ripast/cli css-class-rename --map tokens.json --apply` (seed via `css-class-scan`) |

  All mutating commands default to dry-run; preview, then `--apply`. `--verify` blocks on new type diagnostics — fix them, never `--no-verify`. Edit is only correct for single-file or <5-match changes.
