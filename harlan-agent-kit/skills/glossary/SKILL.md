---
name: glossary
description: Create, enforce, or audit a project's GLOSSARY.md, the canonical vocabulary for product concepts. Use when naming a new feature, writing user-visible strings, renaming a concept, bootstrapping a glossary, or auditing a codebase for vocabulary drift and banned terms. Use before inventing any word for a feature.
user_invocable: true
argument-hint: "[init | audit | add <term>]"
---

# Glossary

`GLOSSARY.md` at the repo root is the canonical name for every product concept. One concept, one word, everywhere: UI strings, public API names, doc headings, route segments, error messages, commit subjects.

## Worktree isolation

An existing worktree alone does not prove another agent is active.

Use `wt` only when another agent is actively modifying the same repository. Otherwise keep the current checkout. Before concurrent edits, run `wt list --format=json`. Reuse the task's worktree with `wt switch <branch>`, or create one with `wt switch --create <branch> --base <base>`. Read its absolute `path` from the JSON, then pass that path as `workdir` to every later command. Never share a mutation worktree between tasks.

## The failure mode this exists to stop

An agent given a concept with no established name invents one, then propagates it. A single feature ends up shipping as **Sprint** in the dashboard, `runBatch()` in the SDK, "campaign" in the docs, and `/jobs` in the URL. Nobody decided that. It accretes one plausible-in-isolation naming choice at a time, and by the time a human notices, the term is in a published API and a customer's bookmarks.

Vocabulary is a product surface. Treat inventing a word with the same caution as adding a public export.

## Rules

1. **Read `GLOSSARY.md` before naming anything user-visible.** If the repo has one, its terms win over anything that reads better in the moment.
2. **Never introduce a synonym for a term that exists.** If the glossary says Sprint, do not write "run", "batch", or "job", not even in a tooltip, a variable name, or a log line.
3. **Never use a term on the ban list.** The ban list carries a replacement; use it.
4. **A concept with no term does not get named silently.** Propose an addition, state the candidate term and the synonyms it displaces, and get confirmation. Inventing quietly is the whole failure mode.
5. **Match the recorded casing exactly.** `Nuxt SEO` and `NuxtSEO` are different brands to a reader.
6. **A term list without a relationship map is half a glossary.** See below. Terms are only ambiguous in relation to each other, so the map is what makes the list decidable.

Rule 4 is the one that matters. Rules 1 to 3 only work on concepts someone already thought about.

## The relationship map is mandatory

A flat list of terms records what each word means on its own. It cannot record what the reader actually needs: **how the terms relate**, and therefore which distinctions are load-bearing and which are drift.

Every `GLOSSARY.md` carries a `## Map` section. Produce it during `init`, refresh it during `audit`, extend it on `add`. Never present a term list as finished without one.

The map answers four questions a list cannot:

1. **Production** — what makes this thing, and what does it make? A term that is produced by another term is not a synonym for it, however similar the words look.
2. **Storage and ownership** — which table, which module or layer. Two terms in two tables owned by two teams are two concepts, whatever the UI calls them.
3. **Cardinality** — 1—1, 1—N, N—N, and whether the constraint is *enforced* (a unique index) or merely conventional. An enforced 1—1 kills entire classes of naming question outright.
4. **Surface crossing** — which customer-facing word each internal term surfaces under. This is where drift lives, and it is invisible in a list because the list has one row per term, not one row per crossing.

**The table is the mandatory part of the map; the diagram is optional.** Filling one `Customer word` cell per row is what exposes a collision, because the column forces you to answer per term and two identical cells are visible at a glance. Draw the diagram on top only when 3 or more terms converge on one word, or a pipeline branches. Field evidence: on a real `init` run the table decided every finding and the diagram decided none.

**Pick the column set from the repo shape.** Only `Term` and `Customer word` are fixed; the middle columns answer "where does it live, who owns it, how does it relate" in whatever terms the codebase actually has. Forcing DB columns onto a library produces a table with 11 of 16 cells empty.

*Application backed by a database:*

```md
| Term | Table | Owner | Cardinality | Customer word |
| --- | --- | --- | --- | --- |
| Finding | `findings` | `pro/audit` | Audit 1—N Finding | "issue" |
| Page Issue | `site_page_issues` | `pro/sites` | Site 1—N, by path | "issue" |
| Ticket | `sprint_tickets` | `pro/sprint` | Sprint 1—N Ticket | "issue" |
```

Mark an enforced constraint as enforced: `Site 1—1 Sprint (uniqueIndex)` ends a whole line of questioning that `Site 1—1 Sprint` leaves open.

*Library, CLI, or SDK:* a term's switching cost is who imports it, not what stores it. Cardinality is usually a type parameter rather than a constraint, so it earns no column.

```md
| Term | Export path | Stability | Consumers | Customer word |
| --- | --- | --- | --- | --- |
| Analyzer | `@gscdump/analysis/registry` | published subpath | CLI, MCP | "tool" |
| Report | `@gscdump/analysis` | published | CLI | "report" |
```

For a published package, **an exported type name is a customer surface, not an internal one.** It is as hard to change as a route.

For any shape, add a second table when published identifiers outnumber concepts: one row per frozen identifier (CLI command and flag, MCP tool name, export subpath, error code, route) mapped to the term it names. In a library that crossing table is where the drift actually lives.

When presenting the map to a human for a naming decision, a rendered diagram can carry the argument: sources on the left, arrows labelled with what actually moves, paths shown splitting and whether they rejoin. Tag each internal box with the customer word it surfaces under. Several differently-shaped boxes carrying an identical tag is the drift argument made visible. Write it as Mermaid per **Map syntax** below.

**Do not draw one by default.** Two `init` runs produced a diagram; in both the table found every collision and the diagram found none, restating what the `Customer word` column already said. Draw one only when a human has to be persuaded of a branching pipeline, and skip it whenever the relationships are type-flow rather than data-flow.

Never ask for an ASCII containment tree. A tree cannot render a node with two parents, and a term with two parents is the normal case, not the exception: one real repo had `Site` owned by both `Team` and `GSC Property`, which made the tree impossible to draw at all.

### Read the decision records before drawing

**A glossary harvested only from schema and UI will misread deliberate decisions as drift.** This is the single most expensive mistake in this skill. Before writing the map, read `docs/adr/`, `docs/decisions/`, or whatever the project's decision log is called, and grep it for each candidate term.

An umbrella word that an accepted ADR chose on purpose is a *ratified* umbrella, not accretion, and proposing to "fix" it wastes the user's time and burns credibility. The evidence trail runs: schema says what is stored, UI says what is shown, **the decision log says which of those was chosen and why**. Only the third distinguishes a deliberate collapse from a silent one.

### Check every ban against the schema

Run this against the bans already in the file, not only the ones you are proposing. An inherited ban list rots as the schema grows, and one real repo banned "reports" and "insights" while both were a live route, a table, and a published MCP tool.

Before a word goes on the ban list, or stays on it, grep for it across every **frozen surface**: stored enum values, column names, status literals, published export paths and subpaths, CLI command and flag names, MCP tool names, error-code literals, route segments, and ADR titles. A word is frozen when changing it breaks someone outside the repo, whether that is a database or an importer. Schema is only the database-shaped half; one library run rejected 10 proposed bans and not one of them was blocked by a stored value. A word the database persists cannot be banned in favour of another term. It is not a synonym; it is a value with behaviour attached, and banning it puts the glossary in conflict with the code rather than with a careless string.

When this fires, the ban list is what is wrong, not the schema. Narrow the ban to prose, or drop it, and record the enum's values with the axis they belong to.

### Watch for the same word on two axes

The subtlest finding a map produces: one word used as a value on two independent classification axes of the same entity, meaning something different on each. A list cannot show this, because the word gets one entry and looks consistent. The map shows it as two boxes with one label.

When it appears, do not rename either axis reflexively. Record both, state the axis each belongs to, and only then ask whether the collision is worth the cost of renaming.

## Format

`GLOSSARY.md` has four sections in this order: Map, Terms, Banned, Open questions.

### Map syntax

`## Map` is the first section, before any term definition. Write it in Mermaid, which GitHub renders natively inside a fenced ```` ```mermaid ```` block in any `.md` file, plus the table from the section above. No image files, no external tooling, still a plain-text diff.

Use `flowchart LR` and stage the pipeline left to right: sources, the detected concept, its consumers, what each is persisted as. Give every internal term a class, and attach the customer word as its own node so a shared word is visibly shared rather than repeated as text.

````md
## Map

```mermaid
flowchart LR
  subgraph sources[Sources]
    A[Audit<br/><small>audits</small>]
    S[Scan<br/><small>lh_scans</small>]
  end

  F[Finding<br/><small>findings · pro/audit</small>]
  P[Page Issue<br/><small>site_page_issues · pro/sites</small>]
  T[Ticket<br/><small>sprint_tickets · pro/sprint</small>]

  A --> F
  S --> F
  F -- ranked --> T
  F -- indexed --> P

  UI(("&quot;issue&quot;<br/>customer word"))
  F -.-> UI
  P -.-> UI
  T -.-> UI

  classDef internal fill:#E7EFF6,stroke:#34648A,color:#16202B;
  classDef customer fill:#F8EEDC,stroke:#9A6714,color:#16202B;
  class A,S,F,P,T internal
  class UI customer
```

Collisions
  "issue"   Finding, Page Issue, Ticket all surface here — three producers, one word
  "problem" a value on both `kind` and `materiality`, different meaning on each
````

Rules for the map:

- **One customer word, one node.** Three dotted arrows converging on a single `"issue"` node is the drift argument. Repeating the word as a label on three boxes hides it.
- **Solid arrows for production, dotted for surface crossing.** They are different relationships and should not read alike.
- **Label the arrow with what moves** (`ranked`, `indexed`, `deduped`), not with a verb like `has`.
- Use `classDef` to separate internal from customer-facing. Two colours is enough; a third for collisions if the diagram earns it.
- Keep node text to the term plus its table and owner. Definitions live in `## Terms`, not in the box.
- Follow the diagram with a plain-text `Collisions` list. Mermaid does not render everywhere, and the collisions are the part that must survive a plain-text read.
- Redraw whenever a term is added or a collision is resolved.
- **`## Map` holds three things and nothing else**: the table, an optional diagram, and the `Collisions` list. No narrative, no rationale, no per-term commentary. Reasoning about a term belongs in `## Terms`; reasoning about an unresolved choice belongs in `## Open questions`. A real run let the Map section grow to 223 lines around a 63-line diagram, which buried the one artefact a reviewer opens the file for. The budget is on **prose, which should be zero**, not on the artefacts: a table needs one row per term and a diagram costs what it costs, so never drop a term or a required diagram to hit a line count.

The worked examples in this skill use a Sprint/Finding/Ticket domain. They are illustrative only. Do not grep the target repo for the example's words; on a real run that produced a wasted sweep returning one hit.

### `## Open questions` format

Mandatory section, and on a real run the most useful one in the file. One entry per decision you could not make. Each carries the evidence, the options with their costs, and no recommendation dressed as a conclusion.

```md
## Open questions

Naming calls this file does not settle. Resolve one, fold the answer in, delete the entry.

1. **Does `indexing status` mean the GSC verdict or our derived state?**
   Both, today: `pages.indexing_status` stores the derived value, and the
   dashboard column of the same name shows the GSC verdict.
   - Rename the derived column, migration, no customer impact.
   - Rename the UI column, no migration, changes a screen customers know.
   - Keep both, record the axis on each, accept that readers must infer.
```

### The rest

```md
# Glossary

Canonical vocabulary for this project. Every user-visible string, public API
name, doc heading, and route segment uses these terms and no synonyms.

## Map

<!-- Mermaid diagram plus the Term/Table/Owner/Cardinality/Customer word table -->

## Terms

### Sprint
**Is:** a scheduled group of crawls run against one site.
**Use for:** the dashboard object, `sprint*` exports, `/sprints` routes, docs headings.
**Never:** run, batch, job, campaign, session, sweep.
**Casing:** `Sprint` in prose and UI, `sprint` in identifiers and URLs.

### Finding
**Is:** a single actionable issue attached to a Sprint.
**Use for:** ...
**Never:** issue, problem, error, violation, alert.
**Casing:** `Finding` in prose and UI, `finding` in identifiers.

## Banned

| Never | Use instead | Why |
| --- | --- | --- |
| audit (noun) | Sprint | Overloaded with the compliance meaning |
| user | customer | "user" means the end visitor of a customer's site |
| powerful, seamless, robust | (cut) | Marketing filler, says nothing |
```

The `Never:` line per term is what makes this enforceable. A term without its displaced synonyms recorded cannot be audited for.

## Workflows

Pick by the argument given, defaulting to `audit` when the user points at a codebase and to `init` when no `GLOSSARY.md` exists.

### `init` — bootstrap from an existing codebase

Do not invent the vocabulary. Recover the one already in use, then pick winners.

**Harvest three surfaces separately, and do the customer one first.** A schema is engineering vocabulary. It is evidence of what the team calls things, not of what the product calls them, and it may have drifted from the business names years ago. Starting from tables produces a tidy glossary that quietly contradicts the UI.

0. **Find the glossary that already exists.** Before harvesting anything, grep the repo for an informal one: a Vocabulary, Terminology, Naming, Say/Don't say, or Copy section in `COPY.md`, `CONTEXT.md`, `STYLE.md`, `CONTRIBUTING.md`, `README.md`, or the docs tree. Projects that care about wording usually wrote one down without calling it `GLOSSARY.md`. Missing this ships a third competing list and is the worst outcome this skill can produce. One real repo had two, in `COPY.md` and `CONTEXT.md`, holding a ratified Say/Not table and 20 protocol terms. Never silently override a wording decision someone already made, and never write a second list beside an existing one without saying which wins.

   **0.5. Decide how you relate to what you found, and record the decision.** Three outcomes, and the skill will not choose for you:
   - **Point to it** — the existing list is complete and better established than anything you would write. Cite it as authoritative, cover only what it omits, and say so in the intro. One real run found a 145-line vocabulary with 25 terms, per-term avoid lines, and dated ambiguity flags; writing a competing list would have been pure harm.
   - **Fold it in** — the existing list is partial or scattered. Move it in verbatim, credit where it came from, and leave a pointer behind in the old file so the two cannot drift.
   - **Supersede it** — the existing list is stale or contradicted by shipped surfaces. Say which entries you are overriding and why, one line each.

   Put the choice in `## Open questions` unless the evidence makes it obvious, because it decides who owns wording from now on.
1. **Customer surface**: UI strings in templates, route and page filenames, headings, marketing and docs copy. Plus everything published, which counts here even with no UI in the repo: **CLI command names, flag names and positional args** (`analyze <tool>` names a concept), **package names and export subpaths** (`@scope/pkg/registry`), **MCP tool names and protocol identifiers**, **stable error-code literals**, and **exported type names**. Watch for a registry id disagreeing with its public path (`id: 'decay'` behind `/tools/content-decay` is two names for one thing). This surface is what a term means to the person paying, and for a library it is nearly the whole repo.
2. **Internal surface**: table names, stored enum values, protocol contracts, layer and module directory names, unexported helpers. **Exported types are not internal** in a published package; file them under the customer surface, since an importer feels a rename exactly like a customer feels a changed route.
3. **Decision surface**: `docs/adr/`, `docs/decisions/`, RFCs, whatever the project's decision log is called. Grep it for every candidate term. Skipping this step is how an agent proposes to "fix" a collapse the team ratified on purpose, which is worse than leaving the drift alone.
4. Cluster synonyms within each surface, then across them. Look for the same concept appearing under 2 or more words, the exact drift being fixed.
5. **Weight by surface, not by frequency.** Note where each variant appears and rank by switching cost: live URL, published protocol or MCP tool name, stored enum value, then UI string, then internal identifier, then prose. Do not spend effort counting occurrences; on a real run the counts decided nothing and location decided everything.
6. **Diff the surfaces and lead with the mismatch.** Where they disagree, that table is the most valuable output of `init`, more than the term list. Expect the internal surface to draw distinctions the UI collapses: three tables surfacing under one customer word is the common shape, and one of those words is usually already in a route. Then check the decision log: a ratified umbrella is recorded, never reopened.
7. Present each cluster with a recommended canonical term and the evidence. **Ask before writing.** Naming is the user's call, not the agent's, and a surface mismatch is a product decision, not a refactor.

   **When you cannot ask** (subagent, non-interactive run, no user present): write the draft anyway and put every decision you would have asked about into `## Open questions`, with its evidence and options. Never silently pick a winner and present the file as settled. Blocking produces nothing; guessing quietly is the failure this whole skill exists to stop.
8. Build the map before writing any definitions: the table always, a Mermaid diagram if it earns one. Filling a `Customer word` cell per row is what exposes a collision; a list will not.
9. Write `GLOSSARY.md` with every rejected variant recorded on the `Never:` line. Where a mismatch is unresolved, record both terms, mark which surface each governs, and put the decision in `## Open questions`. Never resolve it by picking the one that reads better; never ban a word that is still the live customer-facing name for something, and never ban a word the database stores as a value.

### `audit` — find drift

1. Read `GLOSSARY.md`. Build the search set from every `Never:` entry and every Banned row.
2. **Validate the ban list before searching against it.** For each banned word, grep for it as a stored enum value, column name, or status literal. A word the schema persists is not a synonym to be replaced; the ban is the defect. Report those first, as glossary bugs rather than code bugs, because every hit they generate downstream is noise.
3. Search the codebase for each surviving term. Prioritise user-visible surfaces: templates, markdown, route names, public exports, error strings. Internal-only variable names are a lower tier; report separately.
4. **Re-walk the map against reality.** Confirm each term still has the table, owner, and cardinality recorded, and that no new term has appeared in the tree's territory. A map that has silently gone stale makes every other answer in the file untrustworthy. Redraw it as part of the audit output, not as a follow-up.
5. Report as `file:line`, the offending term, and the canonical replacement:

```
User-visible (fix now):
  app/pages/runs.vue:14    "Run history"  -> Sprint history    (route also needs /runs -> /sprints)
  docs/guide/setup.md:31   "campaign"     -> Sprint
  server/api/sprint.ts:88  throw new Error('batch failed')     -> 'Sprint failed'

Internal identifiers (lower tier, ripast can rename):
  lib/queue.ts:12  runBatch()  -> runSprint()

Needs a human read (may be ordinary English):
  README.md:6  "run the CLI"  -- likely fine, not the Sprint noun
```

6. For code identifiers, hand the renames to the `ripast` skill; it is AST-aware and updates import sites. Do not sed a rename across a repo.
7. Prose and template strings need reading in context: a hit can be a legitimate everyday use of the word rather than the product concept ("run the tests" is not the Sprint noun). Never bulk-replace those.

### `add <term>`

Append a term block. Fill the `Never:` line with the synonyms it displaces, including whatever the code currently calls it. A new term with an empty `Never:` line is half-recorded, and audit will not catch drift against it.

Then place the term in the map, and treat that as part of adding it rather than as bookkeeping. Give it a parent, a table, an owner, a cardinality, and its customer-facing word. A term that cannot be placed is the useful failure: either it duplicates something already on the tree, or it belongs to a concept nobody has named yet, and both need resolving before the term is written.

## Scope

Glossary governs **nouns for product concepts**: what a thing is called. It does not govern voice, tone, or sentence style. If the project also has `.claude/context/writing-style.md` from the `site-setup` skill, that owns prose style and this owns terminology. When they disagree on a product noun, the glossary wins.
