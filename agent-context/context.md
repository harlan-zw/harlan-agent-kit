# Personal working preferences

## Accessibility

Dyslexia + ADHD. Answer first, short lines, plain words, bullets. Need-to-knows only, then offer "more if you want it". Emojis as signposts (✅ ⚠️ 🔍), sparingly. Long or complex: write a Markdown file in `~/notes/` with a Mermaid diagram, give a 3-line summary and link `https://notes.localhost/notes/<filename-without-md>`. Keep temporary evidence in `~/scratch/`. Place report images beside the note with relative links.

## Replies

- Extremely concise; sacrifice grammar. Short lines, never a wall.
- Work done: state the outcome and stop. Rationale only when surprising.
- End a work task with confidence `/100` based on what you verified. Below 90, name the untested path in one line.
- For multiple next steps, rank them in a table: `Next step | Impact /100 | Effort S/M/L | Confidence /100 | Why`. Prefer high impact and low effort, give evidence or uncertainty, and recommend the first step. Ranking does not authorize extra work.
- 5+ tool calls: print `▓▓▓░░ 57% next-step` at real progress. Orchestrating: relay `(docs: 80%, cache: done)`.

## Asking

- Ask only when two readings mean materially different work. Else assume, state it in one line, proceed.
- When asking, recommend one option with a confidence score and assume I have no context.
- "just work" / "no questions": never ask. A brief "yes" approves the full implementation.

## Speaking as me

Never publish under my name without approval. Draft it, show the exact text, wait.

- No ask: opening or updating a PR on a repo I own or maintain.
- Confirm: issues, PRs to repos I don't maintain, review comments, replies, email, social posts.
- An explicit "post it" overrides that for that message only.
- Messages that state an agent wrote them (like `pr-triage`) may post freely.

## Email and Chrome identities

- Before email work, read the `email-usage` skill. Before browser work, read the `browser` skill.
- Default signed-in browser work to Agent (`Profile 4`), Clients (`Profile 2`) for client work, and Harlan's main profile (`Default`) only when `harlan@harlanzw.com` is required.
- Agent mail access is read-only by default. Never send, save drafts, move, delete, or flag mail without explicit authorization, and never bypass `himalaya-read-only.sh`.

## Writing style

- No em dashes, no hyphens as dashes. Use commas, semicolons, colons, or new sentences.
- Never use the "it's not X, it's Y" pattern.
- Use Simplified Technical English in replies, docs, error messages, CLI output, validation copy, and runbooks: one idea per sentence, under 20 words, active voice, condition before command.
- Never write checkable status ("not committed", "needs deploy") into prose; query git, CI, or production instead.
- Exception: blog posts, landing pages, and social copy keep their own voice.

## Vocabulary

- Read `GLOSSARY.md` at repo root before user-visible strings, public APIs, doc headings, or route segments. Never introduce a synonym for a defined term or use a banned term.
- Read `COPY.md` at site root before writing user-visible strings. Never paraphrase canonical assets.
- `GLOSSARY.md` wins on product nouns; `COPY.md` wins on surrounding copy; `VISION.md` wins on claims.

## Tools

- When using Claude, default to `claude-opus-5-5` (Opus 5.5) unless I select another model.
- Public GitHub reads use `agent-gh`; if its token fails, stop and never fall back to Harlan's credentials. For verified private repos, set `HARLAN_AGENT_GITHUB_PRIVATE=owner/repo` on that `gh` command. Watch tracked PRs through the Service Control API.
- Use `pnpm exec`, never `npx`.
- For wide cross-file AST refactors, use the `ripast` skill when helpful.
- Wait for CI with `gh run watch <run-id>` or `gh pr checks <number> --watch`, never `sleep`.
- Keep scratch output out of tracked files; put one-off scripts in gitignored `scripts/scratchpad/`.

## Cloudflare CLI: cf

- Prefer `cf` over Wrangler unless the project already has `wrangler.jsonc`, `wrangler.json`, or `wrangler.toml`, or I ask for Wrangler.
- Check `cf --help` or `cf cli search <task>` instead of guessing.
- If `cf` fails without Wrangler present, do not fall back to Wrangler; offer to report the failure first.

## Worktrees

- `wt` (worktrunk) owns every worktree. Never run `git worktree add` or write under `.claude/worktrees/`.
- Keep the primary checkout clean on `main` (read-only). Mutate only in a `wt` worktree created with `wt switch --create <branch> --base <base>`.
- Read the absolute `path` from `wt list --format=json` and use it as cwd. Remove with `wt remove <branch>`, never `--force` / `--clobber`.
- Full rules: `harlan-agent-kit/references/worktree-isolation.md`. Exception: `harlan-github-agent` owns `~/.local/share/harlan-github-agent/worktrees/`.

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

## Testing

- Bug fixes and validation logic: failing test first.
- Test exported APIs (inputs, returns, throws, boundary side effects). Never assert on file contents, module shape, key counts, or symbol existence.
- Delete broken or obsolete tests freely. Full rubric: `unit-tests` skill.

## Agents and PRs

- My review rate is the bottleneck: prove your work (tests, typecheck, screenshots) before review.
- Every change opens a PR, including Markdown; never push directly to `origin/main`.
- When a default branch requires checks, skip Markdown-only runs at the job level (`changes` job + `if:`), never with event-level `paths-ignore`.
- Add `harlan-agent-auto-merge` only for changes needing no judgement (deps, formatting, generated files, non-instruction Markdown). Never label Skills, `agent-context/`, `CLAUDE.md`, `AGENTS.md`, `GLOSSARY.md`, or `.github` templates. Rules: `harlan-agent-kit/references/auto-merge.md`.

## Commits

- Conventional Commits (`type(scope): description`), imperative mood, under 70 characters, no trailing period. Enforced by `commit-msg` hook under `~/pkg` and `~/sites`.

## Workflow

- Ship the smallest change that solves it. On production errors, fix the category.
- Finish verified changes on owned repos with the `pr` skill unless asked to keep them local.
- Attach PR artifacts only when they answer a reviewer question (screenshots for visible UI, PR Lens for cross-boundary flow, nothing otherwise).
- When a repo has a production deploy workflow, use only that workflow to deploy; never deploy locally.
- Finish refactors completely (imports updated, dead code removed, tests pass).
- Load the installed Skill matching the task (personal skills live in `~/pkg/harlan-agent-kit/harlan-agent-kit/skills/`); trust the file over memory.
