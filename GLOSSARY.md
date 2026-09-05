# Glossary

Canonical vocabulary for this repository. Every user-visible string, public
identifier, doc heading, and commit scope uses these terms and no synonyms.

**Provenance.** `packages/harlan-github-agent/GLOSSARY.md` already holds a ratified
57-term vocabulary for the GitHub agent service, with a Map, a `Banned` table, and
a table of GitHub terms adopted unchanged. That file stays authoritative for every
service word. This file cites it and does not restate it.

This file covers what the package glossary does not: the **plugin surface**, meaning
Skills, Hooks, References, Agent instructions, the `check` command, and worktrees.
It also carries the `## Scopes` table, because the `commit-msg` git hook reads
`GLOSSARY.md` at the repository root only.

Where the two files disagree about a service word, the package glossary wins.

## Map

| Term | Lives in | Read by | Relationship | Customer word |
| --- | --- | --- | --- | --- |
| Harlan Agent Kit | this repository | Claude Code, Codex, git, `wt` | 1 Plugin, 1 Service | "agent kit" |
| Plugin | `harlan-agent-kit/`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` | Claude Code, Codex | 1 to N Skills, 1 to N Hooks | "plugin" |
| Marketplace | `.claude-plugin/marketplace.json` | Claude Code | 1 Marketplace, 1 Plugin | "marketplace" |
| Skill | `harlan-agent-kit/skills/<name>/SKILL.md` | Claude Code, Codex | 1 to N References, 1 to N templates | "Skill" |
| Reference | `skills/<name>/references/`, `harlan-agent-kit/references/` | one Skill, mid-task | N to 1 Skill, or shared across Skills | "reference" |
| Hook | `harlan-agent-kit/hooks/*.sh` | Claude Code, Codex, per event | N per event, disabled by `.claude/hooks.json` | "hook" |
| Git hook | `agent-context/git-hooks/commit-msg` | git, for every Agent provider | 1 per commit, under `~/pkg` and `~/sites` | "commit hook" |
| Agent instructions | `agent-context/CLAUDE.md`, `AGENTS.md`, `context.md` | Claude Code, Codex, at session start | 1 tracked source, 2 installed copies | "Agent instructions" |
| Check | `bin/check`, `harlan-agent-kit/hooks/check.sh` | `pre-commit-push.sh`, Harlan | 1 per commit or push | "`check`" |
| Worktree | `<parent>/<repo>.<branch-slug>` | `wt`, `scripts/worktree-sweep.sh` | 1 per task-owned branch | "worktree" |
| Commit scope | the `type(scope):` subject prefix | `agent-context/git-hooks/commit-msg` | 1 per commit, retired spellings in `## Scopes` | "scope" |
| Service | `packages/harlan-github-agent`, systemd `harlan-github-agent` | Harlan, GitHub | 1 Dashboard, 1 Control API | "GitHub agent" |
| Dashboard | `packages/harlan-github-agent/dashboard/` | a browser | 1 per Service | "dashboard" |
| Agent, Task, Routine, Review run, Incident, and 52 more | `packages/harlan-github-agent/GLOSSARY.md` | the Service | defined there, not here | see that file |

Collisions

- "hook" names two things. A Hook is a bash file in `harlan-agent-kit/hooks/`, run by
  Claude Code or Codex. A Git hook is `agent-context/git-hooks/commit-msg`, run by git.
  Both are frozen, so both keep the word. Always qualify the git one.
- "context" names three things: the `agent-context/` directory, the `sync:context` and
  `check:context` package scripts, and the Service's Context budget. The concept the
  first two carry is Agent instructions.
- "check" names two things. The Check is `bin/check`, which runs lint, typecheck, and
  tests. A check run is GitHub's, and the package glossary adopts GitHub's word.
- "agent" names four things: the running Agent in the Service, the Harlan Agent Kit
  product name, the `agent-context/` directory, and a retired commit scope.
- "review" names three things: the `adversarial-review` Skill, the Service's Review run,
  and GitHub's own review.
- "service" names two things: the systemd unit `harlan-github-agent`, and the deployment
  scripts `scripts/service.sh` and `scripts/hogwild-service.sh`. See Open question 2.

## Terms

Service terms are defined in `packages/harlan-github-agent/GLOSSARY.md`. The terms
below cover the plugin surface only.

### Harlan Agent Kit
**Is:** this repository, holding one Plugin and one Service.
**Use for:** the AI disclosure line in every pull request body, README prose, the
`harlan-agent-kit` package and plugin name.
**Never:** harlan-claude-code, the kit, toolkit, agent toolkit, plugin pack.
**Casing:** `Harlan Agent Kit` in prose, `harlan-agent-kit` in identifiers.

### Plugin
**Is:** the installable directory `harlan-agent-kit/`, holding every Skill and Hook.
**Use for:** `/plugin install`, `plugin.json`, `.codex-plugin/plugin.json`, README prose.
**Never:** extension, package, bundle, add-on, integration.
**Casing:** `Plugin` in prose, `plugin` in identifiers and paths.

### Skill
**Is:** one `SKILL.md` under `harlan-agent-kit/skills/`, plus its References and templates.
**Use for:** the README Skill table, every skill directory name, prose about invoking one.
**Never:** command, slash command, playbook, recipe, prompt, workflow, agent.
**Casing:** `Skill` in prose, kebab-case in directory names, `SKILL.md` for the file.
**Note:** a Skill's canonical name is its directory name. That name is frozen, because
Claude Code and Codex both load Skills by directory.

### Reference
**Is:** a Markdown file a Skill reads mid-task, holding a procedure or a rubric.
**Use for:** `skills/<name>/references/`, and `harlan-agent-kit/references/` when two or
more Skills share it.
**Never:** doc, guide, appendix, addendum, sub-skill.
**Casing:** `Reference` in prose, `references/` as the directory.

### Hook
**Is:** one bash file in `harlan-agent-kit/hooks/`, run by Claude Code or Codex on an event.
**Use for:** `SessionStart`, `PreToolUse`, and `PostToolUse` entries, the README Hooks table,
the `disabled` list in `.claude/hooks.json`.
**Never:** guard, gate, trigger, middleware, plugin hook, listener.
**Casing:** `Hook` in prose, the file name in configuration.
**Note:** a Hook's disable key is its file name without `.sh`. That key is frozen.

### Git hook
**Is:** `agent-context/git-hooks/commit-msg`, installed globally by `pnpm sync:context`.
**Use for:** commit subject rules, the `## Scopes` check, prose about git refusing a commit.
**Never:** pre-commit, commit hook alone, husky hook, lint-staged.
**Casing:** `Git hook` in prose, `commit-msg` for the file.
**Note:** it runs for every Agent provider, because the Service workers never load a Plugin.

### Agent instructions
**Is:** the tracked instructions in `agent-context/`, installed to `~/.claude/CLAUDE.md`
and `~/.codex/AGENTS.md`.
**Use for:** `pnpm sync:context`, `pnpm check:context`, `scripts/sync-agent-context.sh`,
and prose about what every agent reads at session start.
**Never:** agent context, global config, system prompt, memory, preferences file.
**Casing:** `Agent instructions` in prose, `agent-context/` for the frozen directory,
`context` in the frozen `sync:context` and `check:context` script names.

### Check
**Is:** `bin/check`, which runs lint, typecheck, and tests in parallel.
**Use for:** the command name, the `pre-commit-push.sh` gate, prose about what must pass
before a commit or a push.
**Never:** CI, validation, verify, gate, preflight, quality check.
**Casing:** `check` as the command, `Check` in prose.
**Note:** GitHub's check run keeps its own word. See the package glossary.

### Worktree
**Is:** one `wt` owned checkout at `<parent>/<repo>.<branch-slug>`.
**Use for:** `references/worktree-isolation.md`, the `worktrees:*` package scripts,
the `sweep-worktrees` CLI subcommand, `wt-only.sh`.
**Never:** worktrunk, workspace, branch checkout, sandbox, clone.
**Casing:** `Worktree` in prose, `worktree` in identifiers and paths.
**Note:** Worktrunk is the tool that owns worktrees. It is not the concept.

### Commit scope
**Is:** the optional `(scope)` in a Conventional Commit subject.
**Use for:** every commit subject, and the `## Scopes` table below.
**Never:** area, component, tag, prefix, namespace.
**Casing:** lowercase, kebab-case, matching a directory name where one exists.
**Note:** `## Scopes` lists retired spellings only. A scope absent from it is allowed.

## Banned

Every candidate below was checked against the sqlite schema in
`packages/harlan-github-agent/src/store.ts`, the exported type names in `src/types.ts`,
the Skill directory names, the Hook file names, and the CLI subcommands.

| Never | Use instead | Why |
| --- | --- | --- |
| harlan-claude-code | Harlan Agent Kit | The Plugin runs on Codex too, and the directory is gone |
| slash command, playbook, recipe, prompt | Skill | One concept, and Claude Code and Codex both load Skills |
| agent context (as a prose noun) | Agent instructions | `agent-context/` is a frozen path, not the reader's word |
| worktrunk (as the concept) | Worktree | Worktrunk is the tool; the artefact is a Worktree |
| guard, gate, middleware, listener | Hook | The Plugin has one word for a file that runs on an event |
| CI, preflight, validation | Check | `check` is the command; CI is what GitHub runs |
| the kit, toolkit, plugin pack | Harlan Agent Kit | One product name, matching the AI disclosure line |

**Bans rejected by the frozen-surface check** (do not add these):

| Rejected ban | Blocked by |
| --- | --- |
| ~~agent~~ | `agent-context/`, `Agent` in the package glossary, and nine `agent-*.ts` modules |
| ~~context~~ | The `sync:context` and `check:context` package scripts |
| ~~service~~ | `scripts/service.sh`, six `service:*` package scripts, and the systemd unit |
| ~~task~~ | The `tasks` table and the `tasks` CLI subcommand |
| ~~review~~ | The `adversarial-review` Skill and the `review_runs` table |
| ~~plugin~~ | `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` |
| ~~hook~~ | `harlan-agent-kit/hooks/` and `agent-context/git-hooks/` |
| ~~dashboard~~ | `packages/harlan-github-agent/dashboard/` and its `DESIGN.md` |

## Scopes

Retired commit scopes only. A scope absent from this table is allowed, so this is a
denylist and never an allowlist. The `commit-msg` git hook reads these rows and names
the replacement when it refuses a commit.

| Never | Use instead | Why |
| --- | --- | --- |
| `agent` | `github-agent` | Every frozen surface spells it `github-agent`; frequency favours `agent` and loses |
| `conform` | `pkg-conform` | The Skill directory is `pkg-conform` |
| `nuxt-frontend` | `nuxt-frontend-design` | Ambiguous, because `nuxt-frontend-review` is a separate Skill |
| `pre-commit` | `hooks` | The file is `hooks/pre-commit-push.sh`, and git owns `pre-commit` |
| `webfetch` | `hooks` | It named one hook file, not the layer |
| `worktrunk` | `worktrees` | Worktrunk is the tool; the concept is worktrees |

Scopes that look like drift and are not: `dashboard` names
`packages/harlan-github-agent/dashboard/`, a real directory with its own design system.
`hooks`, `skills`, `pr`, and `glossary` each name a directory too. All of them stay.

## Open questions

Naming calls this file does not settle. Resolve one, fold the answer in, delete the entry.

1. **Is `plugin` a Hook scope or a manifest scope?**
   Both `plugin` commits changed Hooks. `bf942d24` touched only `hooks/pr-skill-only.sh`.
   But `plugin` also names three frozen files: `.claude-plugin/plugin.json`,
   `.codex-plugin/plugin.json`, and `.claude-plugin/marketplace.json`.
   - Retire `plugin` to `hooks`. Leaves manifest-only changes with no scope of their own.
   - Keep `plugin` for manifest and marketplace changes only. Relies on the author judging it.
   - Keep both and accept that a change touching a Hook and a manifest can use either.

2. **Does `service` name the deployment scripts or the Service itself?**
   Both `service` commits touched only `scripts/service.sh` and `scripts/hogwild-service.sh`.
   Those scripts sit at the repository root, not in the package. Six `service:*` package
   scripts and `test:service` name them. The Service source is `github-agent`.
   - Keep `service` for the deployment scripts. Two adjacent scopes for one product.
   - Retire `service` to `github-agent`. One word for the whole thing, and the root
     scripts lose their name.
   - Rename the scripts and the scope to `deploy`. Breaks six package script names.

3. **Do bare `review` and `triage` need retiring, and to what?**
   `fix(review)` spanned the `adversarial-review` Skill, the `pr` Skill, and the Service
   source. `fix(triage)` changed the Service. `fix(issue-triage)` changed the Skill.
   Three Skill directories carry the words: `adversarial-review`, `issue-triage`, `pr-triage`.
   The git hook supports one replacement per row, and neither word has one.
   - Retire both to `github-agent`, since both offending commits changed the Service.
     Wrong for a future commit that changes only a Skill.
   - Leave both allowed and rely on the author picking the Skill directory name.
   - Split the hook to support a row with no replacement, refusing the scope and
     naming the candidates.

4. **The glossary Skill's own example contradicts row 1 of `## Scopes`.**
   `harlan-agent-kit/skills/glossary/SKILL.md` shows `| github-agent | agent | One service,
   one word |`, and `scripts/commit-msg-hook.test.sh` uses the same pair as a fixture.
   This table retires the reverse. A reader who copies the example gets the wrong winner.
   - Flip the Skill example and the test fixture to match this table.
   - Change the example to an invented pair, so no reader mistakes it for a decision.
   - Leave it, and accept that the example reads as guidance.

5. **Does `PR` in prose stay banned?**
   `packages/harlan-github-agent/GLOSSARY.md` bans "PR in prose" in favour of "pull request".
   `README.md` writes "PR" eight times, including a Skill table row and a feature bullet.
   README voice is landing-page copy, which Harlan's writing rules exempt from
   Simplified Technical English.
   - Narrow the ban to the Service, its dashboard, and its output. README keeps "PR".
   - Apply the ban repository-wide and rewrite the README rows.
   - Record README as a deliberate surface crossing, listed here.
