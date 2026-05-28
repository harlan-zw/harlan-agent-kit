---
name: humanize-writing
description: Strip AI tells from prose so it reads as human-written. Use when user says "humanize this", "remove AI tells", "does this sound AI", "make this sound human", "de-slop", "sounds like ChatGPT", or before publishing any prose (blog, release notes, tweet, docs, email).
user_invocable: true
argument-hint: "[text or file path to humanize]"
---

# Humanize Writing

Detect and remove the patterns that make text recognizably AI-written. The premise (from StoryScope, arXiv:2604.03136): AI prose stays detectable even after surface cleanup, because the *structural* choices give it away. Fixing em-dashes and "delve" is necessary but not sufficient.

## How to use

Given text (in `$ARGUMENTS` or a file path), run both passes below, report what you flagged, then rewrite. Don't silently rewrite, show the user *which* tells you found so they learn to avoid them.

## Pass 1: Surface tells (fast, lexical)

These are the well-known signatures. Fix them, but know they are the easy half.

- **Em-dashes and hyphens-as-dashes** -- restructure with commas, semicolons, colons, or separate sentences.
- **"It's not X, it's Y"** contrast pattern -- banned. State Y directly.
- **Overused vocabulary** -- delve, tapestry, testament, realm, navigate, leverage, robust, seamless, crucial, vibrant, ever-evolving, "in today's fast-paced".
- **Hedging filler** -- "it's worth noting", "it's important to", "that said", "moreover", "furthermore" as paragraph openers.
- **False-sincerity openers** -- "honestly", "to be honest", "frankly", "in all honesty", "let's be real". They signal nothing and pad the sentence. Just state the point.
- **Rule-of-three everywhere** -- AI defaults to triples ("fast, reliable, and scalable"). Vary list length; use two or four.
- **Tidy closing summary** -- the "In conclusion" / "Ultimately" wrap-up that restates what was just said.

## Pass 2: Structural tells (the durable ones)

This is what actually separates human from AI prose. Editing these requires real rewrites, not find-and-replace.

- **Over-explains the takeaway.** AI spells out the moral far more than humans do. Cut the sentence that says "the lesson here is...". Trust the reader to infer it from the example.
- **Vague allusions instead of specific references.** Humans name real tools, versions, people, repos, numbers; AI stays generic. Replace "a popular framework" with "Nuxt 4", "studies show" with the actual source, "significantly faster" with the real figure.
- **Writes as though no one is watching.** Humans address the reader directly and break the fourth wall ("you've probably hit this"). AI narrates into the void. Add direct address where natural.
- **Tidy, single-track structure.** AI marches clue to reveal in a straight line with no loose ends. Humans digress, backtrack, leave threads open. Allow an aside or a non-linear jump.
- **Narrow repertoire / over-determination.** AI converges on safe defaults and resolves everything neatly. Let tension stay unresolved; admit what you don't know; allow an opinion that isn't perfectly balanced.

## Adapt to content type

Not every tell applies everywhere. Weight by genre:

- **Tweets / social:** surface tells + specificity + direct address matter most. Skip structural nonlinearity.
- **Release notes / docs:** specificity (real version numbers, PR links) and cutting the over-explained takeaway matter most. Keep structure clear, drop the moralizing.
- **Blog posts / essays:** all of Pass 2 applies. This is where structure shows the most.
- **Email:** direct address and dropping hedging filler matter most.

## Output

1. List the tells you found, grouped by pass, quoting the offending phrase.
2. Provide the rewritten text.
3. If rewriting changed meaning anywhere, flag it explicitly rather than assuming the user's intent.
