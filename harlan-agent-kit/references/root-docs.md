# Root docs

Every repository Harlan owns carries the same root documents and the same docs
lifecycle. This file is the contract. `nuxtseo.com` and `gscdump.com` proved it;
everything here is lifted from what already works there.

## The rule

**Location is status.** A document's folder says where it sits in its lifecycle.
Moving the file is the state change. So the repository root holds identity and
filters only: documents that are true today, carry no status, and never close.

## Root set

Nothing else may sit at the root. A new root Markdown file is an error.

| File | Holds | Who reads it |
| --- | --- | --- |
| `README.md` | what this is, install, first use | humans, npm |
| `AGENTS.md` | the router plus the rules an agent gets wrong | every agent, every turn |
| `GLOSSARY.md` | every product concept, and the `## Scopes` table | agents before naming anything, the `commit-msg` hook |
| `VISION.md` | the product filter: what to reject | agents before non-trivial feature work |
| `DESIGN.md` | the visual filter: how it must look | sites only |
| `COPY.md` | the verbal filter: the canonical strings and the voice that writes them | sites only |
| `CONTRIBUTING.md` | how a human contributes | humans |
| `LICENSE.md`, `SECURITY.md`, `CHANGELOG.md` | the usual | humans, tooling |

`COPY.md` owns the words on screen. `DESIGN.md` owns the pixels and defers voice
to it. `GLOSSARY.md` owns what a concept is called; `COPY.md` owns how a
sentence says it. `VISION.md` owns what may be claimed at all, so positioning
belongs there, not in `COPY.md`. Displaced names: brand guidelines, voice guide,
tone doc, messaging doc, verbal identity.

Retired: `CONTEXT.md`. It did three different jobs across the repositories that
had one. Its router content is now `AGENTS.md`, its vocabulary is `GLOSSARY.md`,
its architecture is `docs/arch/`.

`ARCHITECTURE.md` is reference, so it belongs in `docs/arch/`. A package with no
`docs/` directory may keep it at the root.

Moving a document under `docs/` changes which lint rules reach it.
`eslint-plugin-harlanzw` globs its prose rules at `**/content/**/*.md`,
`**/docs/**/*.md` and `**/README.md`, so root Markdown other than `README.md`
never met them. A file that has sat at the root for a year will fail on em
dashes, adverbs and buzzwords the moment it moves. Fix the prose; it breaks
Harlan's own writing rules either way. Budget for it: skilld.dev's five moved
files produced 58 errors.

`ROADMAP.md` is aggregate status, so it belongs in `docs/work/README.md` where a
repository generates one. Two repositories keep it at the root today; leave
those until their index generator lands.

## Docs lifecycle

| Folder | Stage | Rules |
| --- | --- | --- |
| `docs/ideas/` | pre-decision | sketches and proposals; nothing here is executable work |
| `docs/adr/` | decided | numbered, immutable, amended only by a later ADR; numbers are unique |
| `docs/work/` | open | one brief per initiative, contract below |
| `docs/work/shipped/` | closed | moved here only when `Done means:` is verified end to end |
| `docs/arch/` | reference | present tense, no `Status:` line; status lives in `docs/work/` |
| `docs/postmortems/`, `docs/repros/`, `docs/runbooks/` | reference | same rule: no `Status:` line |

A brief may never exist in `docs/work/` and `docs/work/shipped/` at once.

## Brief contract

A brief is named `EXECUTE-<topic>.md`. The name never changes, so a link to it
survives the whole life of the work.

Every open brief carries, in this order:

1. an H1 title
2. `Status:` on one line, with the date, and the branch, worktree, or pull request if one exists
3. `**Next move:**` starting with one bucket: `Harlan`, `Blocked`, or `Ready`
4. `Done means:` one sentence a reader can check
5. `## Ledger`, a checkbox list of the work
6. `## Log`, dated entries appended as the work moves

Append progress to the `## Log`. Never open a separate progress file.

Example header:

```markdown
# EXECUTE: canonical Metrics on the Analytics band

Status: in progress · 2026-09-04 · branch `feat/snapshot-sources`, PR [#807](https://github.com/harlan-zw/nuxtseo.com/pull/807)

**Next move:** Harlan reviews. The four metrics are on the branch.

Done means: every card derives its window note, sparkline direction and delta valence from one shared spec.

## Ledger

- [x] `METRIC_SPEC` table and types
- [ ] Site-page extras read the spec

## Log

2026-09-04 Cut the two proof cards from this pass.
```

## AGENTS.md is a router

`AGENTS.md` is the only file loaded on every turn. Everything else is read on
demand. So it earns its place by routing, not by explaining.

Target 30 to 80 lines. Longer belongs in a nested `AGENTS.md` next to the code it
governs, or in `docs/arch/`.

It holds:

- one or two sentences on what this repository is
- the rules an agent would otherwise get wrong, and only those
- one line per root document and per `docs/` folder, saying when to read it
- the traps with a non-obvious fix, such as a native rebuild recipe
- the downstream consumers a change here ripples into

It never holds:

- commands. `package.json` is the source of truth and never drifts.
- directory listings or per-file descriptions. They drift within a month.
- generic style rules. ESLint enforces them; prose does not.
- anything already in `~/.claude/CLAUDE.md`, a hook, or a Skill. Name the Skill instead.
- prompt hacks. "Think thoroughly, no exceptions" earns nothing.
- an opener describing what the file is. The agent already knows.

Judge every line by one question: **would an agent get this wrong without it?**

Use [templates/AGENTS.md](../skills/pkg-conform/templates/AGENTS.md) to start one.

## Enforcement

Nothing enforces this contract yet. Read it and apply it by hand.

`AGENTS.md` is already in `eslint-plugin-harlanzw`'s `PROMPT_MARKERS` and
`PROMPT_FILES`, so its 41 existing prompt and deslop rules fire on the file as
soon as a repository stops ignoring it. Those rules catch wording. They do not
check anything below.

Planned, none of them shipped:

| Rule | Will catch |
| --- | --- |
| `prompt-dangling-path` | a backticked repository path that does not exist |
| `prompt-orphan-doc` | a root filter document `AGENTS.md` never links to |
| `docs-root-allowlist` | new Markdown at the repository root |
| `docs-work-brief-contract` | a brief missing a field above |
| `docs-reference-no-status` | a `Status:` line in a reference document |

When a rule ships, drop its row and say here that it is enforced.

ADR number uniqueness stays in a repository script. It compares files, and
ESLint reads one file at a time. `nuxtseo.com` and `gscdump.com` already run one
at `scripts/tools/docs-structure.mjs`.

A repository config that ignores `AGENTS.md` turns off every rule the plugin
already has. Never add that ignore.
