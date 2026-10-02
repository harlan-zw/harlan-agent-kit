# Personal working preferences

## Accessibility

Dyslexia + ADHD. Answer first, short lines, plain words, bullets. Need-to-knows only, then offer "more if you want it". Emojis as signposts (✅ ⚠️ 🔍), sparingly. Long or complex: write a Markdown file in `~/notes/` with a Mermaid diagram. Give a 3-line summary and a browser link: `https://notes.localhost/notes/<filename-without-md>`. Keep temporary evidence and downloads in `~/scratch/`. Place report images beside the note and use relative links. The local viewer refreshes automatically.

## Replies

- Extremely concise; sacrifice grammar. A few short lines, never a wall.
- Work done: state the outcome, stop. Rationale only when the outcome is surprising.
- End a work task with confidence /100 that it works end to end. Score what you verified, not how code reads. Below 90, name the untested path in one line.
- If you propose multiple next steps, rank them in a table: Next step | Impact /100 | Effort S/M/L | Confidence /100 | Why.
- Impact measures the concrete benefit for this task. Effort includes implementation, verification, and rollout: S means one focused change, M means several related changes, L means broad or uncertain work.
- Prefer high impact and low effort. Respect dependencies and required work. Give each score evidence or name the uncertainty. Recommend the first step. Ranking does not authorize extra work.
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

## Email and Chrome identities

- Before email work, read the `email-usage` Skill. Before browser work, read the `browser` Skill.
- Use `harlan@harlanzw.com` for personal work, `clients@harlanzw.com` for clients, and `agent@harlanzw.com` for explicit agent identity.
- Default signed-in browser work to Agent. Use Clients for client work. Explicit user choices take precedence.
- If a site requires `harlan@harlanzw.com`, use Harlan's existing main profile.
- Identity selection needs no extra approval for an authorized task. Honor Chrome's main-profile connection approval.
- Desktop Chrome profiles: Harlan = `Default`, Clients = `Profile 2`, Agent = `Profile 4`.
- Discover profiles on each host. Verify the target site's signed-in identity before private reads or changes.
- For Clients and Agent, use their dedicated automation launchers and `harlan-browser connect <identity> <task-name>`.
- For existing Harlan Chrome, use built-in remote debugging and `dev-browser --connect`. Do not add flags to its standard directory.
- A named `dev-browser` session does not select a Chrome profile. Never substitute another identity's session.
- For ordinary shared Chrome, select an existing tab in the intended profile. Verify the target site's signed-in email.
- Reconnect after Chrome restarts. Never kill shared Chrome or stop the shared browser daemon to repair attachment.
- Himalaya: pass `-a harlanzw`, `-a clients`, or `-a hotmail` explicitly. Discover other accounts with `account list`.
- `harlanzw` and `clients` share the existing Zoho mailbox. Scan it once when checking all mail.
- Use `himalaya message read --preview` to avoid marking mail as read.
- Agent mail access is read only by default. Draft exact messages in chat or private scratch files.
- Never send, forward, schedule, save drafts, move, delete, or flag mail without explicit authorization for that action.
- If a read-only Hook blocks an authorized action, report it. Never bypass the Hook through another tool.
- Never print full mail configs or credentials. Keep `harlanzw.com` receiving through Zoho unless migration is requested.

## Writing style

- No em dashes, no hyphens as dashes. Use commas, semicolons, colons, or new sentences.
- Never the "it's not X, it's Y" pattern.
- Simplified Technical English, in replies and in error messages, CLI output, validation copy, docs, runbooks: one idea per sentence, under 20 words, active voice, condition before command ("If the token expired, run X"), one word one meaning.
- Never write a checkable status into prose. "NOT committed", "migration NOT applied", "needs deploy", "not published": query git, CI, or production instead. Prose status rots silently and is read as true months later.
- Exception: blog posts, landing pages, social copy keep their own voice.

## Vocabulary

`GLOSSARY.md` at repo root names every product concept. Read it before user-visible strings, public API names, doc headings, route segments.

- Never introduce a synonym for a term it defines. Never use a banned term.
- Unnamed concept: propose the term, say which synonyms it displaces, confirm.
- Bootstrap, audit, drift: read the `glossary` skill.

`COPY.md` at the root of a site owns every user-visible string: the canonical assets, the register per surface, and the banned language. Read it before writing one.

- Never paraphrase a canonical asset. Change it there first, then propagate.
- Bootstrap, audit, or write a string against it: read the `copywriting` skill.
- `GLOSSARY.md` wins on a product noun; `COPY.md` wins on the sentence around it; `VISION.md` wins on whether the claim may be made at all.

## Tools

- For public GitHub reads, use `agent-gh`. It uses `harlan-agent-beep` and a separate API quota.
- GitHub Agent workers route `gh` reads through the same CLI automatically.
- The token file is `~/.config/harlan-agent-kit/github-public-token`. Keep it owner-only with mode `600`.
- Use a fine-grained token with Public repositories access and no account permissions.
- If that token fails, stop. Never switch to Harlan's credentials to finish a public read.
- The public CLI refuses writes and raw GraphQL. Use `pr view`, `issue view`, or `search` for GraphQL reads.
- Authorized controller writes and private access keep their existing GitHub credentials.

- Find and search files: ripgrep (`rg`).
- Rename, move, or import update spanning 2+ files: `pnpm dlx @ripast/cli`. AST-aware across TS/JS/Vue SFCs; dry-run by default, `--apply` to write.
- Browser testing and automation: `dev-browser` (`--help`). Always pass `--headless` for unattended tests, even with `$DISPLAY`.
- Launch dedicated Agent and Clients Chrome headless with `harlan-browser open <identity>`. Visible work requires an explicit user request.
- `--headless` does not hide attached Chrome. Use `harlan-browser connect` to enforce headless connections. Never bring tabs to the foreground.
- Wait for CI with `gh run watch <run-id>` or `gh pr checks <number> --watch`. Never poll with `sleep`; the shell tool times out first.
- Give each task its own `dev-browser` name. Close every named page when browser work ends. Never run `dev-browser stop`; it stops shared browsers.
- Scratch output stays out of the repository. Screenshots, one-off reports, and exploratory notes go to the session scratchpad. A one-off script goes in a gitignored `scripts/scratchpad/`; only durable, referenced tooling lives in `scripts/` proper.
- Run a repository binary with `pnpm exec`, never `npx`. npm's npx does not read pnpm's layout as a local install, falls back to a cached copy in `~/.npm/_npx`, and fails with resolution errors that read as a broken tree. If `pnpm exec <bin>` works where `npx <bin>` fails, purge the matching `~/.npm/_npx` entry.

## Cloudflare CLI: cf, v20260928

`cf` is the current Cloudflare CLI. It covers the whole Cloudflare platform. Prefer it over Wrangler.

- Create a project with `cf init`. Develop with `cf dev`. Deploy with `cf deploy`.
- Manage account resources with `cf <product> …`, for example `cf d1 list`.
- Use Wrangler only if the project already has `wrangler.jsonc`, `wrangler.json`, or `wrangler.toml`, or if I ask for it. Keep Wrangler there until I ask to migrate; then use `cf migrate`.
- `cf` commands differ from Wrangler commands. Check `cf --help` or `cf cli search <task>`; never guess.
- If a `cf` command fails in a project without Wrangler, do not fall back to Wrangler (`pnpm dlx wrangler` included). Offer to report the failure first.

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

- Always use TypeScript for new code, including scripts, automation, data processing, and one-off scratch tools.
- Never fall back to Python or JavaScript for convenience. Run TypeScript with the repository runtime or Node type stripping.
- Use another language only when I request it or an existing tool requires it.
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

Self-hosted runners run on Hogwild (`hogwild-github-runner.service`) and on the desktop (`harlan-desktop-github-runner.service`).

Every change opens a pull request. A Markdown-only change is no exception.
Never push to `origin/main` directly.
Test, build, and deploy workflow events ignore `**/*.md` by default.
A workflow opts in only when its `paths` list includes Markdown.
Never combine `paths` and `paths-ignore` on one event.

Use `harlan-agent-auto-merge` only for changes with no judgement.
Examples include dependencies, formatting, generated files, comments in non-Markdown files, and Markdown that nothing executes, such as a README, docs, or a blog post.
Never label Markdown an agent reads as instructions: Skills, `agent-context/`, `CLAUDE.md`, `AGENTS.md`, `GLOSSARY.md`, or `.github` templates.
The agent merges labelled changes after a READY review. Everything else waits for me.
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
- Where a repository has a production deploy workflow, that workflow is the only path to production. Build-time configuration comes from Actions secrets, so a local build can bake the wrong identity into a valid artifact. Use the CLI for inspection and rollback, never for the deploy.
- Refactors and architecture audits: finish the whole change before stopping (imports updated, old code removed, tests pass).

## Reference material

Rubrics and procedures live in `~/pkg/harlan-agent-kit/harlan-agent-kit/skills/*/SKILL.md`. The plugin lists them. Read the SKILL.md that matches the work before starting it. Trust the file, not memory.
