# Variant contract

Each subagent writes one variant snippet. The splice script inserts it into the page.
Several snippets share one page, so each rule below stops one snippet from breaking another.

## Page requirements

The page defines these classes for every card: `card`, `stage`, `body`, `vh`, `vid`, and `by`.
Each section's grid ends with `<!-- slots:N -->`, where N is the piece number.

## Subagent brief

Paste this brief into each subagent prompt. Fill every bracketed field.

```text
You draw one brand variant for [product]. Read [page path] first.
It holds the tokens, the card structure, and every existing variant.

Variant ID: [ID]. Piece: [piece name]. Your direction: [one assigned direction].
Your variant must differ from these existing variants:
- [ID] [name]: [one line concept]

Write exactly one file: [scratchpad]/variant-[ID].html. Edit no other file.

The file holds three parts, in this order:
1. An optional <style> block. Start every selector with .v[id]- in lower case, for example .v1d-dot.
   Start every keyframes name with v[id]-. Use only the page's colour tokens, such as var(--ink).
2. One <article class="card" id="v[id]"> with this structure:
   <div class="stage">your design</div>
   <div class="body">
     <div class="vh"><span class="vid">[ID]</span><h3>[name]</h3></div>
     <p>Two or three sentences: the concept, then one honest trade-off.</p>
   </div>
3. An optional <script> that holds one IIFE. Find your article by its id. Touch nothing outside it.

Rules:
- Never use these page data attributes: [list them]. The page script fills those elements.
- Show the full design at rest. Motion may start from a complete first frame. Never reveal on scroll.
- Make the design work at a card width of 250px, in the light theme and in the dark theme.
- If you draw on a canvas, re-read the colour tokens when <html> data-theme changes. Use a MutationObserver.
- Draw dot fields on a canvas. Never draw them with braille or other rare glyphs.
- Label every invented number as example data.
- Respect prefers-reduced-motion.

Reply with the file path and one line on the concept.
```

## Why each rule exists

- **Prefixed selectors and keyframes.** One unprefixed `.stage` rule restyles every card on the page.
- **Page data attributes.** The page script queries them at load and draws over the snippet.
- **Full design at rest.** A full-page screenshot does not scroll, so a reveal leaves the stage empty.
- **250px.** A four-column grid narrows each card to about 250px.
- **Theme observer.** The Artifact viewer sets `data-theme` from outside the page, so a toggle handler alone misses it.

## Splice

Run the script from the folder that holds the page and the snippets:

```bash
node --experimental-strip-types "${CLAUDE_SKILL_DIR}/scripts/splice.ts" page.html . --by 1D=Fable
```

If `CLAUDE_SKILL_DIR` is unset, resolve `scripts/splice.ts` relative to this Skill's `SKILL.md`.

- The script inserts each `variant-<piece><letter>.html` before `<!-- slots:<piece> -->`, in letter order.
- It wraps each snippet in `<!-- variant:ID -->` markers. A rerun replaces the wrapped copy in place.
- It tags each card with its author. The default author is `subagent`. Pass `--by ID=name` for each other author.
- It prints a warning for each contract break it finds: a missing article, a missing heading, or an unprefixed name.
- If a slot is missing, it exits with status 1 and names the slot.
