---
name: glossary
description: Create, enforce, or audit a project's GLOSSARY.md, the canonical vocabulary for product concepts. Use when naming a new feature, writing user-visible strings, renaming a concept, bootstrapping a glossary, or auditing a codebase for vocabulary drift and banned terms. Use before inventing any word for a feature.
user_invocable: true
argument-hint: "[init | audit | add <term>]"
---

# Glossary

`GLOSSARY.md` at the repo root is the canonical name for every product concept. One concept, one word, everywhere: UI strings, public API names, doc headings, route segments, error messages, commit subjects.

## The failure mode this exists to stop

An agent given a concept with no established name invents one, then propagates it. A single feature ends up shipping as **Sprint** in the dashboard, `runBatch()` in the SDK, "campaign" in the docs, and `/jobs` in the URL. Nobody decided that. It accretes one plausible-in-isolation naming choice at a time, and by the time a human notices, the term is in a published API and a customer's bookmarks.

Vocabulary is a product surface. Treat inventing a word with the same caution as adding a public export.

## Rules

1. **Read `GLOSSARY.md` before naming anything user-visible.** If the repo has one, its terms win over anything that reads better in the moment.
2. **Never introduce a synonym for a term that exists.** If the glossary says Sprint, do not write "run", "batch", or "job", not even in a tooltip, a variable name, or a log line.
3. **Never use a term on the ban list.** The ban list carries a replacement; use it.
4. **A concept with no term does not get named silently.** Propose an addition, state the candidate term and the synonyms it displaces, and get confirmation. Inventing quietly is the whole failure mode.
5. **Match the recorded casing exactly.** `Nuxt SEO` and `NuxtSEO` are different brands to a reader.

Rule 4 is the one that matters. Rules 1 to 3 only work on concepts someone already thought about.

## Format

```md
# Glossary

Canonical vocabulary for this project. Every user-visible string, public API
name, doc heading, and route segment uses these terms and no synonyms.

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

1. Harvest candidate nouns from where users actually meet them: UI strings in `.vue` templates, route/page filenames, exported type and function names, docs headings, CLI command names.
2. Cluster synonyms. Look for the same concept appearing under 2 or more words, the exact drift being fixed.
3. For each cluster, count usage per variant and where each appears. A term already in a published API or a URL has switching cost; weight it heavily.
4. Present each cluster with a recommended canonical term and the evidence. **Ask before writing.** Naming is the user's call, not the agent's.
5. Write `GLOSSARY.md` with every rejected variant recorded on the `Never:` line.

### `audit` — find drift

1. Read `GLOSSARY.md`. Build the search set from every `Never:` entry and every Banned row.
2. Search the codebase for each. Prioritise user-visible surfaces: templates, markdown, route names, public exports, error strings. Internal-only variable names are a lower tier; report separately.
3. Report as `file:line`, the offending term, and the canonical replacement:

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

4. For code identifiers, hand the renames to the `ripast` skill; it is AST-aware and updates import sites. Do not sed a rename across a repo.
5. Prose and template strings need reading in context: a hit can be a legitimate everyday use of the word rather than the product concept ("run the tests" is not the Sprint noun). Never bulk-replace those.

### `add <term>`

Append a term block. Fill the `Never:` line with the synonyms it displaces, including whatever the code currently calls it. A new term with an empty `Never:` line is half-recorded, and audit will not catch drift against it.

## Scope

Glossary governs **nouns for product concepts**: what a thing is called. It does not govern voice, tone, or sentence style. If the project also has `.claude/context/writing-style.md` from the `site-setup` skill, that owns prose style and this owns terminology. When they disagree on a product noun, the glossary wins.
