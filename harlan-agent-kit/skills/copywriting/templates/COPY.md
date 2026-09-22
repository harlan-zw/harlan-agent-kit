---
scope: <every user-facing string: marketing pages, meta tags, registry blurbs, docs, UI copy, emails, social cards>
owns: the words. DESIGN.md owns the visual system and defers voice to this file; VISION.md owns what may be claimed at all; GLOSSARY.md owns what a concept is called
---

# Copy

<One or two sentences: this is the canonical source for the product's verbal identity. Pages,
meta tags and package blurbs pull from here; when a canonical string changes, change it here
first, then propagate. A string that contradicts this file is a bug.>

## Canonical assets

These exact strings. Do not paraphrase them per page.

<Only strings used in more than one place. A one-off headline is not a canonical asset.>

| Asset | String | Where it goes |
| --- | --- | --- |
| Name | `<name>`, `<casing rule>`. Never `<the wrong casings, listed>`. | everywhere |
| Tagline | <the H1 string> | landing H1, social card headline |
| Category descriptor | <what it is, where the tagline has no context> | meta titles, registry listings, directory entries |
| One-sentence description | <one sentence> | `<meta name="description">`, package `description`, link previews |

## Register by context

<One row per surface that has its own voice. The Example column is mandatory and must quote a
string that actually ships.>

| Context | Register | Example |
| --- | --- | --- |
| Marketing hero | <two or three words> | <a real shipped string> |
| UI chrome, buttons and labels | <two or three words> | <a real shipped string> |
| Descriptions, cards and meta | <two or three words> | <a real shipped string> |
| Errors | <two or three words> | <a real shipped string> |
| Empty states | <two or three words> | <a real shipped string> |
| Data labels | <two or three words> | <a real shipped string> |

## Copy principles

<Three to six. Each one has to be able to reject a sentence someone would otherwise write. A
principle that rejects nothing is wallpaper; cut it.>

1. **<Principle>.** <What it rejects, with an example of the rejected form.>

## Banned language

<Every row carries its reason. Without one the next writer cannot tell whether a near-miss is
also banned. Do not restate the global rules from ~/.claude/CLAUDE.md: no em dashes, never the
"it's not X, it's Y" pattern, Simplified Technical English. Record only what is specific to this
product.>

| Never | Use instead | Why |
| --- | --- | --- |
| <word or phrase> | <the replacement, or "name the specific thing"> | <the reason, in one clause> |

<Check every ban against the frozen surfaces first: a stored enum value, a route segment, a
published export, a CLI flag. A word the product persists cannot be banned in favour of another
word, and the ban is the defect when that happens.>

## Open questions

Wording calls this file does not settle. Add one here, resolve it, fold the answer into the
section above, then delete it from this list.

None open.
