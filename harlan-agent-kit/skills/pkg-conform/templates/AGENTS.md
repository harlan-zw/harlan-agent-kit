# <name>

<One or two sentences: what this is, and the one structural fact that shapes
every change. Example: "Nuxt module. No build step: runtime templates plus a
build-time resolver.">

## Read first

<One line per document. Delete a row the repository does not have.>

- [`GLOSSARY.md`](GLOSSARY.md) — every product concept. Read before any user-visible string, public API name, doc heading, or route segment.
- [`VISION.md`](VISION.md) — the product filter. Read before non-trivial feature work; it exists to reject ideas.
- [`DESIGN.md`](DESIGN.md) — the visual filter. Read before UI work.
- `docs/arch/` — how the code is shaped. Present tense, no status.
- `docs/work/` — open briefs. One per initiative. `ls docs/work/` shows everything unfinished.
- `docs/adr/` — decisions, numbered and immutable.
- `docs/ideas/` — pre-decision sketches. Nothing here is executable work.

## Rules

<Only the rules an agent would get wrong without them. Delete this section if
there are none. Do not restate ~/.claude/CLAUDE.md, a hook, or a Skill.>

## Traps

<Failures with a non-obvious fix, each with the exact command. Delete if none.

Example:
- **better-sqlite3 ABI mismatch** in vitest: run `prebuild-install --target=$(node -v | tr -d v)` inside `node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3`, in the same shell that runs vitest. Never `node-gyp rebuild`.>

## Consumers

<Repositories a change here ripples into, and what to check before shipping.
Delete if none.>
