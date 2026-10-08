---
name: brand-lab
description: "Explore brand directions for a product on one private HTML page: a logo and small UI motifs, three or more variations each, with picks and rationale. Use when the user wants to rethink or strengthen a brand, logo, or brand motif, compare brand variations side by side, or says the branding feels basic."
user_invocable: true
argument-hint: "[product or repository] [reference brands]"
---

# Brand Lab

One private HTML page shows five brand pieces with three or more variations each. Your picks carry a mark. Reply handles like `1A, 3D` make feedback cheap.

This Skill is ideation. Keep every file in the session scratchpad. Edit no repository file.

## 1. Read the product's filters

Read these before you draw:

- `DESIGN.md`: the tokens, the components, and the Avoid list.
- `COPY.md` and `GLOSSARY.md`: every string on the page uses their words.
- `VISION.md`: what the brand may claim.
- The current logo files and the logo component.

If a filter file is missing, read the tokens from the live CSS. Say so in the page header.

## 2. Study the reference brands

Read the `DESIGN.md` and the brand mark code of each brand the user names. Write down why each one works.

Example from the skilld.dev run:

- The gscdump mark is its data record rising. Halftone dither draws it, and the oldest slice takes the accent.
- The Nuxt SEO mark is the Nuxt peak, drawn in `░▒▓█` glyphs.

The lesson: the mark pictures the product. One texture draws it, and every other motif reuses that texture. The accent colour means one specific thing.

If the user names no reference, choose two strong brands from the same category. Name them in the reply.

## 3. Write the thesis

State the texture atom, what the accent means, and the motion that belongs to the texture.

Add a comparison table. Its rows are texture, mark, accent means, and motion. Its columns are each reference, then the product, proposed.

skilld example: the dot is the atom. Stone dots are noise. One rose dot is the Skill you picked.

## 4. Choose five brand pieces

Before drawing logo variants, read the installed `skilld` Skill and load
[kaankiziltug's logo-design Skill](https://skilld.dev/gh/kaankiziltug/logo-design-skill/logo-design):

```bash
skilld run kaankiziltug/logo-design-skill/logo-design --json
```

Check the exit code and `_tag` before reading the returned instructions.
Follow the `skilld` Skill's source checks and supporting-file workflow.
Use `run` for this task; do not install it unless the user asks to keep it.
If loading fails, report the error instead of claiming the Skill was used.

Apply its concept exploration, geometric construction, typography, and optical refinement guidance.
Consider a custom wordmark or ligature alongside standalone marks.
Check each logo in one colour, reversed, and at actual 32 and 16 px sizes.
Keep this lab's product filters, scratchpad scope, and variant contract.

Piece 1 is the logo: the mark, the lockup, and favicon cuts at 32 and 16 px. Pieces 2 to 5 are small UI motifs. Tie each motif to one line of the product's pitch.

skilld example: Mark, Texture (hero, OG image, loading), Run chip (primary action), Heat (trending indicator), Change mark (update status).

## 5. Build the page

In Claude Code, load the `artifact-design` Skill first. Build the page from the product's own tokens.

- **Header:** the current logo tagged "today", a theme toggle, the thesis, and the table.
- **Sections:** one per piece, with a sequence marker such as `01 / 05` and one data line.
- **Cards:** a stage, then an ID such as `1A`, a name, and two or three sentences. The sentences give the concept and one honest trade-off.
- **Picks:** mark your own picks on their cards.
- **Together:** a final section that composes your picks into one realistic product screen.
- **Slots:** end each section's grid with `<!-- slots:N -->`, where N is the piece number.

Draw variants A to C yourself. Label every invented number as example data.

## 6. Fan out extra variants

Read `references/variant-contract.md` and paste its brief into each subagent prompt.

- Give each subagent one distinct direction, so parallel subagents do not collide.
- List every existing variant in the brief, so new ones differ.
- Include the loaded `logo-design` guidance and source revision in logo subagent briefs.
- If the user names a model for a column, launch that column's subagents on that model.

When the snippets exist, run `scripts/splice.ts` as the reference shows. It inserts each snippet and tags its author.

## 7. Verify once, then publish

Read the `browser` Skill. Wrap the page in a document skeleton:

```bash
{ printf '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>'; cat page.html; printf '</body></html>'; } > preview.html
```

Open `preview.html` once with `dev-browser --headless`. Check these:

- a screenshot in the dark theme and in the light theme;
- console errors;
- cards whose content overflows the card.

Publish the page with the Artifact tool. On each update, republish the same file path, so the URL stays the same. If no Artifact tool exists, give the local file path.

## 8. Reply

Give the link, your picks, one line on the thesis, and the next steps.

## Gotchas

- **The viewer sets the theme from outside.** The Artifact viewer sets `data-theme` on `<html>`. A canvas must re-read the colour tokens through a `MutationObserver` on `<html>`. A toggle handler alone drew light theme ink on the dark background.
- **Rare glyphs change width.** Braille and other rare glyphs fall back to system fonts with different widths. Draw dot fields on a canvas. Use text glyphs only where plain text output is the point.
- **Scroll reveals look empty.** A snippet that reveals on scroll shows an empty stage in a full-page screenshot. Require the full design at rest.
- **"Make N variations" is ambiguous.** Read it as N new variants per piece. Keep the originals and add the new variants as new columns.
- **The user is ideating.** Keep everything in the scratchpad and publish privately. If the user picks a direction to ship, that work starts in a new `wt` worktree.
