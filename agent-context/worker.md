# Worker instructions

## Writing style

- No em dashes, no hyphens as dashes. Use commas, semicolons, colons, or new sentences.
- Never use the "it's not X, it's Y" pattern.
- Use Simplified Technical English in docs, error messages, CLI output, validation copy, and runbooks: one idea per sentence, under 20 words, active voice, condition before command.
- Never write checkable status ("not committed", "needs deploy") into prose.
- Exception: blog posts, landing pages, and social copy keep their own voice.

## Vocabulary

- Read `GLOSSARY.md` at repo root before naming product concepts, public APIs, doc headings, or route segments. Never introduce a synonym for a defined term or use a banned term.
- Read `COPY.md` at site root before writing user-visible strings. Never paraphrase canonical assets.
- `GLOSSARY.md` wins on product nouns; `COPY.md` wins on surrounding copy; `VISION.md` wins on claims.

## Tools

- Use `pnpm` (`pnpm exec`, never `npx`).
- For wide cross-file AST refactors, use the `ripast` skill when helpful.
- For Cloudflare projects without `wrangler.*`, prefer `cf` over Wrangler and check `cf --help` instead of guessing.
- Keep scratch output out of tracked files; put one-off scripts in gitignored `scripts/scratchpad/`.

## TypeScript

- Write new code and scripts in TypeScript unless asked otherwise or an existing tool requires another language.
- Prefer functions over classes. No backwards compatibility unless asked. No dynamic imports without a treeshaking reason.

### Design patterns (Effect-inspired, no Effect dependency)

Canonical copy + review rubric: the `ts-design-patterns` skill.

- **Make illegal states unrepresentable.** `_tag` discriminated unions, not optional-field + boolean soup.
- **Errors as values.** Tagged `Ok | Err` for expected domain failures, so signatures show them. Unexpected and infra errors propagate; prefer `.catch()` over try/catch when handling is needed.
- **No silent catches.** `.catch(() => null)` hides failures. Handle (log, surface, fallback with reason) or propagate. Swallow only genuinely ignorable failures, with a comment saying so.
- **Parse, don't validate.** Parse untrusted input once at the boundary into a precise type; trust it inward.
- **Explicit dependencies.** Pass clients, config, clock as args. No hidden singletons, no import-time side effects.
- **Pure core, effectful shell.** Side effects at the edges, decision logic pure data-in/data-out.
- **Design out the bug.** After a production error, find the design that kills the whole category. Prefer a type or structural change; guard at the failure site only when no design change exists.

## Vue

Use latest APIs (reactive prop destructure, array event defines). Prefer VueUse over browser APIs.

## Commits and Workflow

- Commit subjects use Conventional Commits (`type(scope): description`), imperative mood, under 70 characters, no trailing period.
- Ship the smallest change that solves the problem. On production errors, fix the bug category.
- Finish refactors completely (imports updated, dead code removed, checks pass).
- Never deploy to production locally when a production deploy workflow exists.
- Load the installed Skill matching the task and trust its file over memory.
