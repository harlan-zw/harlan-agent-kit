# Personal working preferences

## Accessibility

Dyslexia + ADHD. Answer first, short lines, plain words, bullets. Need-to-knows only, then offer "more if you want it". Emojis as signposts (✅ ⚠️ 🔍), sparingly. Long or complex: publish an Artifact, 3-line summary plus the link or path in chat. Claude Code: the native Artifact tool. Codex: `skills/artifact/SKILL.md`. Plain working notes go to `~/scratch/notes/`.

## Replies

- Extremely concise; sacrifice grammar. A few short lines, never a wall.
- Work done: state the outcome, stop. Rationale only when the outcome is surprising.
- End a work task with confidence /100 that it works end to end. Score what you verified, not how code reads. Below 90, name the untested path in one line.
- 5+ tool calls: print `▓▓▓░░ 57% next-step` at real progress. Orchestrating: relay `(docs: 80%, cache: done)`.

## Asking

- Ask only when two readings mean materially different work. Else assume, state it in one line, proceed.
- When you ask, recommend one option with a confidence score and assume I have no context.
- "just work" / "no questions": never ask. A brief "yes" approves the full implementation.

## Speaking as me

Never publish under my name without approval. Draft it, show the exact text, wait.

- No ask: opening or updating a PR on a repo I own or maintain.
- Confirm: issues, PRs to repos I don't maintain, review comments, any reply, email, social posts.
- An explicit "post it" in the conversation overrides that, for that message only.
- The ban is on speaking as me. A message whose body says an agent wrote it, as `pr-triage` does, may post freely.

## Writing style

- No em dashes, no hyphens as dashes. Use commas, semicolons, colons, or new sentences.
- Never the "it's not X, it's Y" pattern.
- Simplified Technical English, in replies and in error messages, CLI output, validation copy, docs, runbooks: one idea per sentence, under 20 words, active voice, condition before command ("If the token expired, run X"), one word one meaning.
- Exception: blog posts, landing pages, social copy keep their own voice.

## Vocabulary

`GLOSSARY.md` at repo root names every product concept. Read it before user-visible strings, public API names, doc headings, route segments.

- Never introduce a synonym for a term it defines. Never use a banned term.
- Unnamed concept: propose the term, say which synonyms it displaces, confirm.
- Bootstrap, audit, drift: read the `glossary` skill.

## Tools

- Find and search files: ripgrep (`rg`).
- Rename, move, or import update spanning 2+ files: `pnpm dlx @ripast/cli`. AST-aware across TS/JS/Vue SFCs; dry-run by default, `--apply` to write.
- Browser testing and automation: `dev-browser` (`--help`).
- Give each task its own `dev-browser` name. Close every named page when browser work ends. Never run `dev-browser stop`; it stops shared browsers.

## Worktrees

`wt` (worktrunk) owns every worktree. Never `git worktree add`. Never `EnterWorktree` or `isolation: "worktree"`; those write to the banned `.claude/worktrees/`.

- The primary checkout is a control checkout. Keep it clean on `main`, equal to `origin/main`. Never edit it.
- Read-only work may use the primary checkout. Every mutation uses a task-owned `wt` worktree.
- Before each switch, Worktrunk fetches and prunes `origin`, then fast-forwards primary `main`.
- Create: `wt switch --create <branch> --base <base>`. Use `origin/main` for independent work. Use `origin/<parent>` or an exact parent SHA for stacked work.
- Enter: `wt switch <branch>`. Remove: `wt remove <branch>`, never `--force` / `--force-delete` / `--clobber`.
- Never pass a path. Read the absolute `path` from `wt list --format=json`, use it as cwd for every later command.
- Exception: `harlan-github-agent` owns `~/.local/share/harlan-github-agent/worktrees/`.

## TypeScript

- Functional, actively avoid classes.
- No backwards compatibility unless asked. All projects are in development; delete freely.
- No inline or dynamic imports without a strong treeshaking reason.

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

Latest APIs (reactive prop destructure, array event defines). Prefer vueuse over browser APIs.

## Testing

- Tautological tests considered harmful.
- Bug fixes and validation logic: failing test first.
- Unit tests exercise exported APIs: build an input, call the export, assert the return, throw, or boundary side effect. Never assert on file contents, module shape, key counts, or that a symbol exists.
- Tests are scratchpad. Delete freely. Behaviour changed on purpose: delete the test, write the new one.
- Full rubric: read the `unit-tests` skill.

## Agents

My review rate is the bottleneck, not tool limits. Agents prove their own work (passing test, screenshot, typecheck) so review covers only what needs a human.

Self-hosted runners run on Hogwild. Never start `harlan-desktop-github-runner.service` on the desktop.

If every task-owned changed file ends in `.md`, commit and push it directly to `origin/main`.
This applies to repositories I own or maintain. Never create a pull request for Markdown-only work.
If the direct push fails, stop and report it.
Test, build, and deploy workflow events ignore `**/*.md` by default.
A workflow opts in only when its `paths` list includes Markdown.
Never combine `paths` and `paths-ignore` on one event.

Use `harlan-agent-auto-merge` only for changes with no judgement.
Examples include dependencies, formatting, generated files, or comments in non-Markdown files.
The agent merges those after a READY review. Everything else waits for me.
Unsure means no label. Rules: `harlan-agent-kit/references/auto-merge.md`.

## Commits

Every commit subject follows Conventional Commits: `type(scope): description`.

- Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `perf`, `test`, `style`.
- The scope is optional. Name the monorepo folder or the treeshakable export.
- Keep the subject under 70 characters. Use the imperative mood: "add", never "added".
- Never end the subject with a period. The body says why, because the diff says what.
- A `commit-msg` git hook refuses a subject that breaks these rules under `~/pkg` and `~/sites`.

## Workflow

- Ship the smallest thing that solves it. Add structure when it fails.
- A pull request that crosses three or more modules, a boundary, or a sequence carries a PR Lens diagram in its description. Smaller ones do not. Read the `pr-lens` skill.
- Production error: fix the category, not the instance.
- Refactors and architecture audits: finish the whole change before stopping (imports updated, old code removed, tests pass).

## Reference material

Rubrics and procedures live in `~/pkg/harlan-agent-kit/harlan-agent-kit/skills/*/SKILL.md`. The plugin lists them. Read the SKILL.md that matches the work before starting it. Trust the file, not memory.
