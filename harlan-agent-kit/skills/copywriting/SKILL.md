---
name: copywriting
description: "Create or audit COPY.md and write user-visible strings against it. Use before writing marketing copy, UI labels, error messages, empty states, meta tags, or email, and when copy has drifted from the canonical strings."
user_invocable: true
argument-hint: "[init | audit | write <surface>]"
---

# Copywriting

`COPY.md` at the repo root is the canonical source for every user-visible string: the exact
assets nobody may paraphrase, the register each surface writes in, and the language the product
never uses.

## Worktree isolation

Before any edit, follow the [worktree isolation contract](../../references/worktree-isolation.md). It provides the atomic live-agent claim used below.

An existing worktree alone does not prove another agent is active.

`wt` is the only worktree tool. Never run `git worktree add`, and never use a harness worktree option such as `EnterWorktree` or `isolation: "worktree"`. Those write to `.claude/worktrees/`, which is banned. `wt` places every worktree at `<parent>/<repo>.<branch-slug>`.

Keep the primary checkout read only. Before mutation, run `wt list --format=json`. Reuse the task's worktree with `wt switch <branch>`, or create one with `wt switch --create <branch> --base <base>`. Read its absolute `path` from the JSON, then pass that path as `workdir` to every later command. Never share a mutation worktree between tasks.

## The failure mode this exists to stop

An agent asked for a hero headline writes a good one. The next agent, on the next page, writes
a different good one. Neither is wrong in isolation, and the product now describes itself two
ways. Six months later the npm blurb, the meta description, the social card and the landing H1
are four separate pitches, and nobody chose that.

The same drift runs through the small strings. One empty state apologises, the next scolds, a
third is silent. One error names the resource, another says "Something went wrong". The product
reads as though several companies built it, because several agents did.

A string is a product surface. Treat writing a new canonical one with the same caution as adding
a public export.

## Boundaries

Four filters govern what a user sees. Each owns one question, and they are not
interchangeable:

| File | Owns | The question |
| --- | --- | --- |
| `VISION.md` | claims | May we say this at all? |
| `GLOSSARY.md` | nouns | What is this thing called? |
| `COPY.md` | sentences | How does a sentence say it? |
| `DESIGN.md` | pixels | How does it look? |

So a headline that claims something `VISION.md` rejects is a vision problem, not a copy problem.
A label that invents a synonym for a named concept is a glossary problem. `COPY.md` owns what is
left: the exact wording, the register, and the banned language.

When they disagree: `VISION.md` wins over everything, `GLOSSARY.md` wins on a product noun, and
`COPY.md` wins on the sentence around it.

Read the [`glossary` skill](../glossary/SKILL.md) before naming a concept. Read this one before
writing a sentence.

## Rules

1. **Read `COPY.md` before writing anything a user sees.** Its canonical assets win over
   anything that reads better in the moment.
2. **Never paraphrase a canonical asset.** A tagline with one word changed is a second tagline.
   If the string is wrong, change it in `COPY.md` first, then propagate.
3. **Never use banned language.** The ban list carries a reason; the reason is what tells you
   whether a near-miss is also banned.
4. **Write in the register the surface calls for.** A button is not a paragraph, and a hero is
   not a tooltip. `COPY.md`'s register table decides, not the sentence's own momentum.
5. **A new canonical string does not get written silently.** Propose it, say what it displaces,
   and get confirmation. Inventing quietly is the whole failure mode.
6. **State the specific thing.** "12 skills from 3 curators" beats "a growing ecosystem". Every
   claim concrete, every number sourced. This is also the tell that separates human copy from
   generated copy, so it does double duty.
7. **Copy is not decoration.** If a section needs filler to look finished, the layout is wrong.
   Never invent a stat, a testimonial, or a feature to fill space.

Rule 5 is the one that matters. Rules 1 to 3 only work on strings someone already decided.

## The register table is mandatory

A list of banned words records what not to write. It cannot record the thing a writer actually
needs: **what a given surface sounds like**. A hero, a button, a validation error and a receipt
email are four different voices in one product, and they are all correct.

Every `COPY.md` carries a `## Register by context` table. Produce it during `init`, refresh it
during `audit`. Never present a copy file as finished without one.

```md
| Context | Register | Example |
| --- | --- | --- |
| Marketing hero | Editorial, declarative | "Curated agent skills by humans." |
| UI chrome | Short verb phrases | "Browse", "Install" |
| Errors | Direct, names the resource | "Couldn't load curators. Check your connection and try again." |
| Empty states | Acknowledge, explain value, give the action | "No collections yet. Curators bundle their favourite skills into collections." |
```

**The Example column is the mandatory part.** A register named but not shown is unusable: two
writers read "friendly but professional" and produce different sentences. One real example ends
the argument, because a writer can pattern-match against it without interpreting an adjective.

Pull every example from a string that actually ships. An invented example teaches the register
you wish you had.

## Canonical assets earn their place by being reused

A canonical asset is a string that appears in more than one place and must be identical in all
of them: the tagline, the one-sentence description, the category descriptor, the name and its
casing. Record where each one goes, because the whole point is that a writer reaching for a meta
description finds the one that already exists.

```md
| Asset | String | Where it goes |
| --- | --- | --- |
| Tagline | Curated agent skills by humans. | landing H1, social card headline |
| One-sentence description | … | `<meta name="description">`, npm `description`, link previews |
```

**A string used in exactly one place is not a canonical asset.** Recording it adds a maintenance
burden and buys nothing. The test is reuse, not importance.

## Banned language needs a reason, not just a list

Every ban carries why. Without it the list rots, because the next writer cannot tell whether a
word that is *almost* the banned one is also banned, and they will guess generously.

```md
| Never | Use instead | Why |
| --- | --- | --- |
| AI-powered | (name the thing it does) | We serve developers who use agents; we are not an AI product |
| seamless | (say what does not break) | Unfalsifiable, and every competitor claims it |
```

**Check a ban against the frozen surfaces before it goes on the list**, exactly as the `glossary`
skill does for terms: a stored enum value, a route segment, a published export, a CLI flag. A
word the product persists cannot be banned in favour of another word. When that fires, the ban
is the defect, not the code.

**Some bans are Harlan's global writing rules**, and those live in `~/.claude/CLAUDE.md`: no em
dashes, never the "it's not X, it's Y" pattern, Simplified Technical English in error messages
and CLI output. Do not restate them in every repo's `COPY.md`. Record only what is specific to
this product.

## Relationship to humanize-writing

They run in sequence and neither replaces the other.

- **This skill decides what the sentence has to say**: which register, which canonical asset,
  which banned word, which claim `VISION.md` permits.
- **[`humanize-writing`](../humanize-writing/SKILL.md) decides whether it reads as though a
  person wrote it**: the surface tells, then the structural ones.

So: draft against `COPY.md`, then run `humanize-writing` over the draft, then check the result
still matches `COPY.md`. That last check matters, because the humanize pass rewrites structure
and can walk a sentence off its register or paraphrase a canonical asset while improving it.

Never duplicate `humanize-writing`'s tell list into a `COPY.md`. A repo's copy file records what
is true of *this product*; the tells are true of all prose and are maintained in one place.

For a whole collection of articles rather than a string, use
[`content-refresh`](../content-refresh/SKILL.md), which coordinates sources and review.

## Format

`COPY.md` has five sections in this order: Canonical assets, Register by context, Copy
principles, Banned language, Open questions. Read
[templates/COPY.md](templates/COPY.md) before writing or auditing the file.

The front matter states scope and ownership in two lines, so a reader who opens the file
mid-task knows immediately whether their question belongs here.

## Workflows

Pick by the argument given, defaulting to `audit` when the user points at a codebase and to
`init` when no `COPY.md` exists.

### `init` — bootstrap from what already ships

Do not invent the voice. Recover the one already in the product, then pick winners.

0. **Find the copy rules that already exist.** Before harvesting a single string, grep for an
   informal version: a Voice, Tone, Copy, Brand, Messaging, or Writing section in
   `BRAND.md`, `CONTEXT.md`, `STYLE.md`, `DESIGN.md`, `CONTRIBUTING.md`, `README.md`, the docs
   tree, or `.claude/context/`. A project that cares about wording usually wrote one down
   without calling it `COPY.md`. Missing this ships a second competing voice guide, which is the
   worst outcome this skill can produce.

   **0.5. Decide how you relate to what you found, and record the decision.** Same three
   outcomes as the `glossary` skill, and it will not choose for you: **point to it**, **fold it
   in** verbatim with a pointer left behind, or **supersede it**, saying which rules you override
   and why. Put the choice in `## Open questions` unless the evidence makes it obvious.

   **Check what you found against `VISION.md` before folding it in.** A brand or messaging
   document usually carries positioning, and positioning is `VISION.md`'s. Where the two say the
   same thing, `VISION.md` is almost always the more current, because it gets read during feature
   work and a brand file does not. Delete the duplicate rather than moving it, and say so.

1. **Harvest the shipped strings, highest-traffic surface first.** Landing page H1 and subhead,
   meta title and description, the package or registry blurb, social card text, the primary CTA.
   These are the canonical assets whether or not anyone wrote them down.
2. **Harvest the small strings by category**, because the register table needs one real example
   per row: button labels, empty states, error messages, form validation, tooltips, email
   subjects, confirmation and success states.
3. **Diff the assets against each other and lead with the mismatch.** Where the meta description,
   the npm blurb and the hero subhead describe the product differently, that list is the most
   valuable output of `init`, more than the register table. Present each with a recommended
   winner and the evidence.
4. **Read `VISION.md` before proposing any ban.** A claim the product has deliberately decided
   not to make is already recorded there; a ban that contradicts it is the ban that is wrong.
   Check `GLOSSARY.md` too: a word banned here that the glossary names as a product noun is a
   collision between two files, and it needs resolving before either ships.
5. **Ask before writing.** Voice is the user's call, not the agent's, and a mismatch between two
   shipped assets is a product decision, not a copy edit.

   **When you cannot ask** (subagent, non-interactive run, no user present): write the draft
   anyway and put every decision you would have asked about into `## Open questions`, with its
   evidence and options. Never silently pick a winner and present the file as settled.
6. Write `COPY.md` from [templates/COPY.md](templates/COPY.md). Every banned row carries its
   reason. Every register row carries a real example. Every canonical asset carries where it goes.

### `audit` — find drift

1. Read `COPY.md`. Build the search set from every canonical asset and every Banned row.
2. **Validate the ban list before searching against it.** For each banned word, grep for it as a
   stored enum value, a route segment, a published export, or a CLI flag. A word the product
   persists is not a synonym to be replaced; the ban is the defect. Report those first, as copy
   bugs rather than code bugs, because every hit they generate downstream is noise.
3. **Search for near-misses of each canonical asset, not exact matches.** An exact match is
   correct by definition; the drift is the paraphrase. Take the distinctive 3 or 4 words of each
   asset and search for those, then read each hit against the recorded string.
4. Search for each banned word across user-visible surfaces: templates, content markdown, meta
   tags, email templates, error strings, CLI output, validation messages.
5. **Re-walk the register table against reality.** Confirm each row's example still ships. An
   example pointing at a deleted component makes the whole table untrustworthy.
6. Report as `file:line`, the offending string, and the canonical replacement:

```
Canonical asset drift (fix now):
  app/pages/index.vue:12      "Curated agent skills, by humans"  -> Curated agent skills by humans.
  package.json:4              a different one-sentence description  -> the recorded one

Banned language:
  content/pages/vs.md:14      "very fast"        -> state the figure
  layers/marketing/…/hero.vue:9  "AI-powered"    -> name what it does

Register mismatch (needs a human read):
  components/EmptyState.vue:6  "Oops! Nothing here yet :("  -> empty-state register, and no exclamation
```

7. Prose hits need reading in context: a banned word can be a legitimate everyday use rather than
   the claim being banned. Never bulk-replace a copy string with sed.

### `write <surface>`

1. Read `COPY.md` first, then `GLOSSARY.md` for every product noun the string will contain, then
   `VISION.md` if the string makes a claim.
2. Find the register row for the surface. If there is no row, that is the finding: propose one,
   with the string you are about to write as its example.
3. Reach for a canonical asset before writing a new sentence. Most requests for a meta
   description are a request for the one that already exists.
4. Draft, then run [`humanize-writing`](../humanize-writing/SKILL.md) over the draft.
5. Re-check the humanized result against `COPY.md`. The humanize pass improves prose and does not
   know about your canonical assets, so it will sometimes paraphrase one.
6. Show the user the string and the register row you wrote it against. Never publish under
   Harlan's name without approval.

## Bootstrapping COPY.md

`COPY.md` is in the [root docs contract](../../references/root-docs.md) root set for a site. A
site with user-visible strings and no `COPY.md` is a gap, not a style choice. Run `init`.

A library, a CLI, or an internal tool usually needs no `COPY.md`. The test is whether a stranger
reads its strings. A CLI with real output and an `--help` screen does qualify, and its register
table is the more useful half: `GLOSSARY.md` already covers command and flag names.

## Scope

Copywriting governs **sentences a user reads**: the exact wording, the register per surface, and
the banned language. It does not govern what a concept is called, which is
[`glossary`](../glossary/SKILL.md), and it does not govern what may be claimed, which is
`VISION.md`. When a noun and a sentence disagree, the noun wins.
