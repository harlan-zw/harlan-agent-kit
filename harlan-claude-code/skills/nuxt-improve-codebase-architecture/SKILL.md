---
name: nuxt-improve-codebase-architecture
description: Find deepening opportunities in a Nuxt codebase, leaning on Nuxt-native seams (hooks, modules, layers, plugins, composables, server routes, nitro, runtime config). Use when the user wants to improve architecture, find refactoring opportunities, consolidate tightly-coupled modules, or make a Nuxt app/module more testable and AI-navigable.
---

# Improve Nuxt Codebase Architecture

Surface architectural friction in a Nuxt codebase and propose **deepening opportunities** — refactors that turn shallow modules into deep ones, using Nuxt's own extension points as seams. The aim is testability and AI-navigability.

## Glossary

Use these terms exactly in every suggestion. Consistent language is the point — don't drift into "component," "service," "API," or "boundary." Full definitions in [LANGUAGE.md](LANGUAGE.md).

- **Module** — anything with an interface and an implementation (function, class, package, slice, Nuxt module, layer).
- **Interface** — everything a caller must know to use the module: types, invariants, error modes, ordering, config. Not just the type signature.
- **Implementation** — the code inside.
- **Depth** — leverage at the interface: a lot of behaviour behind a small interface. **Deep** = high leverage. **Shallow** = interface nearly as complex as the implementation.
- **Seam** — where an interface lives; a place behaviour can be altered without editing in place. (Use this, not "boundary.")
- **Adapter** — a concrete thing satisfying an interface at a seam.
- **Leverage** — what callers get from depth.
- **Locality** — what maintainers get from depth: change, bugs, knowledge concentrated in one place.

Key principles (see [LANGUAGE.md](LANGUAGE.md) for the full list):

- **Deletion test**: imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
- **The interface is the test surface.**
- **One adapter = hypothetical seam. Two adapters = real seam.**
- **No import-time side effects.** Modules declare and export at the top level; they don't *do* on import. Side effects live inside functions the caller invokes (or inside a Nuxt plugin / nitro plugin / `app:created` hook the framework owns). Critical for `shared/` (imported into both runtime graphs), composables, and server utils — anything imported here at top-level eagerly executes in every consumer.
- **Prefer Nuxt-native seams** over hand-rolled equivalents (custom DI containers, ad-hoc singletons, parallel hook systems).

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

**Always run ripast first.** Every claim about depth, caller counts, locality, or cross-scope leaks must be backed by a ripast invocation; text search misses shadowed identifiers, type-only imports, JSX/Vue template refs, and Nuxt auto-imported callers. If you cannot cite ripast output, drop the claim.

**Point ripast at `.nuxt/tsconfig.json` so it resolves Nuxt auto-imports.** Run `nuxi prepare` first if `.nuxt/` is missing or stale. Without this flag, `scan`/`rename`/`move`/`tree` ignore composables, utils, and components used without explicit imports — caller counts come back artificially low and renames miss call sites:

```
--tsconfig .nuxt/tsconfig.json
```

For `scan` (which doesn't take `--tsconfig`), and for trimming when `tree` is still too noisy, pass `--glob` to scope to Nuxt-relevant code:

```
--glob 'app/**,server/**,composables/**,plugins/**,modules/**,layers/**,shared/**,nuxt.config.ts'
```

Trim per project: drop `app/**` on pre-Nuxt-4 layouts (use `pages/**,components/**`), drop `layers/**` if none, add `packages/**` for monorepos, add a Nuxt module's `src/**`.

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

`unused --exports local` is the most direct deletion-test signal there is: a top-level declaration with no callers either earns a delete or is a confessed shallow seam waiting to be deepened. `--exports exported` filters to public surface; `all` covers both. Cite numbers when presenting ("`scan` returns 2 callers, both in `server/api/` — single-scope, deletion test fails"; "`unused` flagged `useFooBar` with 0 references").

Read the project's domain glossary and any ADRs in the area you're touching first. Then orient on the Nuxt shape of the project:

- Is this a Nuxt **app**, a Nuxt **module**, or a workspace with **layers**?
- Which Nuxt extension points are already in use: `modules/`, `layers/`, `plugins/`, `composables/`, `server/api`, `server/middleware`, `nitro` plugins, `runtimeConfig`, `app:*`/`nitro:*`/`build:*` hooks, `addImports`, `addServerHandler`, `addComponent`, `addPlugin`?
- Where does the project hand-roll its own seam (a singleton, a custom plugin pattern, a global registry) instead of using one Nuxt provides?

Then use the Agent tool with `subagent_type=Explore` to walk the codebase. Don't follow rigid heuristics — explore organically and note where you experience friction:

- Where does understanding one feature require bouncing between a `composables/` file, a `plugins/` file, a `server/api` route, and a piece of `runtimeConfig`? `npx -y @ripast/cli scan <feature-symbol> --graph mermaid` spanning three or more Nuxt scopes = no central seam.
- Where are modules **shallow** — a composable that just wraps a single `useState`, a plugin that only `provide`s one untyped value, a server util that's a one-line passthrough to `$fetch`? Spot via `npx -y @ripast/cli tree --exports exported`.
- Where have pure functions been extracted just for testability, but the real bugs hide in how Nuxt wires them (no **locality** — e.g. plugin order, hook timing, SSR vs client divergence)?
- Where does cross-cutting logic (auth, logging, feature flags, telemetry) leak across `app/`, `server/`, `nitro`, instead of sitting behind one hook or one module?
- Where must a **Nuxt module** or **layer** swallow a cluster of plugins + composables + server handlers and present a small interface (a config object + 2-3 hooks)?
- Which parts of the codebase are untested, or hard to test through their current interface? (Composables that touch `useNuxtApp()` deep inside, server handlers with embedded business logic, etc.)
- Walk the convention files for missing seams: [NITRO-CONVENTIONS.md](NITRO-CONVENTIONS.md) on the server side; [VUE-CONVENTIONS.md](VUE-CONVENTIONS.md) + [NUXT-APP-CONVENTIONS.md](NUXT-APP-CONVENTIONS.md) on the app side. Each section's "Gap" entry is a friction signal — if it's present in the codebase, that's a candidate.
- **Cross-scope leaks.** A `types/`, `utils/`, or `constants/` folder imported from both `server/` and `composables/`/`app/` is a smuggle — move to `shared/` (the one seam Nuxt sanctions for both runtime graphs). Detect with `npx -y @ripast/cli scan <util-name> --graph mermaid`: importer set straddling `server/` and `composables/` is a leak by definition. See [NUXT-SEAMS.md](NUXT-SEAMS.md) `shared/` and `Scope boundaries`.
- **Import-time side effects in `shared/`, composables, or server utils.** Top-level `console.log`, listener registration, singleton construction, env reads, or `$fetch` calls at module scope. These eagerly fire in every consumer (and break SSR, treeshaking, and tests). Move the work behind an exported function or into the right Nuxt/nitro lifecycle hook.

Apply the **deletion test** to anything you suspect is shallow: would deleting it concentrate complexity, or just move it? A "yes, concentrates" is the signal you want.

Lean on [NUXT-SEAMS.md](NUXT-SEAMS.md) when classifying friction — it maps common shallow patterns to the Nuxt-native deep equivalents.

### 2. Present candidates

Present a numbered list of deepening opportunities. For each candidate:

- **Files** — which files/modules are involved (include the Nuxt-flavoured paths: `modules/foo.ts`, `layers/billing/`, `server/api/x.post.ts`, `plugins/auth.client.ts`, `composables/useBar.ts`, `nuxt.config.ts`)
- **Problem** — why the current architecture is causing friction
- **Solution** — plain English description of what would change, named in Nuxt terms (e.g. *"collapse these three plugins and two composables into a single Nuxt module that registers `addImports` for the public composables and an `app:created` hook for the singleton wiring"*)
- **Benefits** — explained in terms of locality and leverage, and also in how tests would improve (e.g. *"the module can be tested with `@nuxt/test-utils` against a fixture; today the plugin's behaviour can only be observed through a full app boot"*)

**Use CONTEXT.md for the domain, [LANGUAGE.md](LANGUAGE.md) for the architecture, [NUXT-SEAMS.md](NUXT-SEAMS.md) for the framework seam, and the relevant convention file + section number when the candidate is a convention gap.** Example phrasings: *"the Order intake module exposed as a Nuxt layer"*, *"establish NITRO-CONVENTIONS.md §1 for the Order create handler"* — not *"the FooBarHandler"*, not *"the Order service"*.

**Reject before listing.** Drop any candidate that fails one of these. Bias hard toward fewer, sharper candidates. Validate every caller-count threshold with `npx -y @ripast/cli scan <symbol> --kind identifier-reference,import-specifier`; no guesswork.

- **Deletion test fails.** If deleting the proposed module just inlines 1-2 lines into each caller, skip. Thresholds: single caller = one adapter, not a seam; a Nuxt layer/module needs ≥3 plugins/composables/handlers + shared config or hooks; a schema/policy/presenter/validator or `useX()` async-resource composable earns its keep at ≥2 callers OR real branching/transform; a pure value/type mapping (no branching, just destructure/rename) needs ≥4 callers.
- **No locality win.** "Now testable in isolation" or "future-proof" without bugs/changes/knowledge concentrating in one place is relocation, not depth. Covers: pure-function extraction with no consolidation, speculative seams ("will need someday"), and defensive re-validation of invariants the caller's zod schema, typed event, or DB column already enforces. Validate at system boundaries; trust internal types.
- **Renames or file reshuffles dressed up as architecture.** "Move these files" or "rename this concept" is a refactor task, not a deepening candidate. Note separately or skip.
- **Smuggles import-time side effects.** If the deepened module runs anything at top level on import (listeners, singletons, env reads, `$fetch`), reshape so the side effect lives inside an exported function or a framework lifecycle hook (Nuxt plugin, nitro plugin, `app:created`).
- **Already conventional.** If the code already matches a NITRO/VUE/NUXT-APP convention, don't re-propose it.
- **Meta-handler with no work.** A `defineApiHandler`-style wrapper (NITRO-CONVENTIONS.md §4) earns its keep only when ≥2 of {validation, auth/policy, presenter, domain-error mapping} fire per call. Trivial routes keep `defineEventHandler`.
- **Render-factory composable.** A `composables/` file that is mostly `h()` calls, column defs, or template output with little reactive state is JSX moved sideways. Acceptable only at ≥4 component callers; otherwise use a slot-scoped template or inline.
- **Bundled-concern composable.** A composable that fuses ≥3 concerns (fetch + cache mutation + optimistic update + rollback + retry) with no override seams traps callers in an implicit contract. Split into a chain or hoist concerns to the caller.
- **Config threaded through ≥3 layers unchanged.** Created at A, passed through B and C untouched, consumed at D = missing seam. Consume at the creation layer or place an adapter at the deepest meaningful seam.
- **Single-reader `runtimeConfig` key.** A `runtimeConfig` entry read in exactly one file is an inline `const` masquerading as config. Confirm with `npx -y @ripast/cli scan <configKey> --kind property,member-access`; one hit = fails. Keep only if genuinely environment-overridable at deploy time.
- **Hides `event` behind a global accessor.** Server-side abstractions must thread `H3Event` through (validators, policies, services, presenters, server utils). Reject anything that reaches for module-level singletons, ambient `useRuntimeConfig()` without `event`, or implicit `getRequestEvent()`. See NITRO-CONVENTIONS.md preamble.
- **Contradicts a current ADR without a load-bearing reason.** See ADR conflicts below.

**Forbidden patterns.** Always flag, never propose. Full lists in NITRO-CONVENTIONS.md §"Forbidden patterns" and NUXT-APP-CONVENTIONS.md §"Forbidden patterns". Headline rule: **never wrap an authenticated route in `defineCachedEventHandler`** — the cache wrapper strips request headers from the inner handler, breaking session/auth on every cached path. Hoist auth to an outer `defineEventHandler` and cache the data fetch via `defineCachedFunction` keyed on the resource.

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
- **Decision crystallized into a concrete refactor?** Execute through ripast, not Edit. Pick the primitive:

  Pass `--tsconfig .nuxt/tsconfig.json` on `rename`, `move`, and `rename-file` so auto-imported callers are rewritten too.

  | Refactor | Command |
  | --- | --- |
  | Rename a symbol across files | `npx -y @ripast/cli rename <from> <to> --tsconfig .nuxt/tsconfig.json --apply` (add `--scope <file>` if multi-declared) |
  | Move an exported declaration | `npx -y @ripast/cli move <symbol> --from <a> --to <b> --tsconfig .nuxt/tsconfig.json --apply` (moving out of `composables/`/`utils/`/`components/` auto-import scope inserts explicit imports in consumers) |
  | Move a file (e.g. `utils/foo.ts` → `shared/foo.ts` to close a cross-scope leak) | `npx -y @ripast/cli rename-file <old> <new> --tsconfig .nuxt/tsconfig.json --apply` (handles `.vue` consumers + Pascal/kebab refs) |
  | Design-token / utility-class migration | `npx -y @ripast/cli css-class-rename --map tokens.json --apply` (seed from `npx -y @ripast/cli css-class-scan`) |

  All mutating commands default to dry-run — preview the diff, then `--apply`. `--verify` (default on for `rename`/`move`) blocks the apply on new type diagnostics; fix them, never `--no-verify` past them. Edit is only correct for single-file or <5-match changes. ripast carries out the move; it does not justify the deepening.
