# Artifact design rubric

Read before writing any Artifact from Codex. This is the same rubric Claude's `artifact-design` skill applies, so a page built here matches what Claude would publish.

Approach it as the design lead at a small studio known for versatility. Every page gets a visual identity pitched at the treatment the task calls for. Make deliberate choices about palette, typography, and layout that are specific to the subject.

## Read the request first

Calibrate treatment, not whether to design. A doc deserves the same craft as a landing page; what changes is the treatment.

Most requests are utilitarian: a plan, a memo, a report, a demo. Polish them: real typographic hierarchy, considered spacing, a proper palette. Do not over-design. Most pages need no hero at all.

Some requests are editorial: a landing page, a game, an app or tool the reader keeps or shares. See the last section.

When unsure, a well-composed page is never wrong. An over-designed identity sometimes is.

## Fundamentals for every page

**Honor what is already there.** Look for an existing design system first: CLAUDE.md, a tokens or theme file, existing component styles. Apply it. Precedence: the user's words, then the project's system, then your choices.

**Ground it in the subject.** Pin one concrete subject, its audience, and the page's single job. The subject's own world, its materials, instruments, and vernacular, is where distinctive choices come from. Carry at least one detail only this subject would have: its real units, its document conventions, its terms of art. Content, not ornament. Real content throughout, never lorem.

**Pair typefaces.** Typography carries the page. Google Fonts is the one font host a Claude Artifact admits, and this skill keeps the same rule. Link it directly with `display=swap` and declare a real fallback stack. Running text near 65 characters wide. Set a type scale and stay on it. Headings get `text-wrap: balance`. Uppercase labels get a touch of letter-spacing.

**Load libraries, do not paste them.** When the page needs React, a chart, or a highlighter, load the UMD build from cdnjs with one pinned `<script src>` placed before the inline script that uses its global. A library's stylesheet must still be inlined. Most pages need no library.

**Choose neutrals, do not default to them.** A pure mid-grey reads as unconsidered. A grey with a slight bias toward the accent reads as chosen. Pure white and near-black are fine when picked.

**Design both themes.** Readers have three states: `data-theme="dark"`, `data-theme="light"`, or nothing, where only `prefers-color-scheme` applies. Bare `:root` defines the complete light palette as tokens. `@media (prefers-color-scheme: dark)` redefines only tokens, guarded as `:root:not([data-theme="light"])`. `:root[data-theme="dark"]` redefines them again. Components style through tokens, never inside a media or `[data-theme]` block. `body` sets an explicit token background, because the host paints its own ground behind the page. Every element takes its color from the same token set as the surface behind it. Give dark the same care as light; do not invert. A page committed to one visual world may stay single-theme, and then still paints background and every color explicitly. `templates/page.html` has the pattern.

**Let layout do the spacing.** Sibling groups use flex or grid with `gap`, not per-element margins. Wide content gets `overflow-x: auto` on its own container. `font-variant-numeric: tabular-nums` wherever digits line up.

**Compose repeated things as one object.** Cards in a row, label and value pairs, badges on siblings: same edges, baselines, and padding. Content sets container height. Pick a column count the items fill. Text that can outgrow its track wraps or scrolls; clipped text is a bug.

**Not everything is a card.** Border, fill, radius, and shadow each say "separate object". Spend them by role. Lead with big-number tiles only when the figures are the point.

**Draw charts to the scale.** One scale places marks, ticks, and labels. Every label names a value the chart reaches. Chart text takes theme tokens. Marks, labels, and edges stay clear of each other and inside the bounds. In SVG, leave viewBox room for the outermost labels and give every shape an explicit fill.

**Show the page at rest.** Everything meant to be read is visible on load, without scrolling to trigger it. A section may animate in from a visible resting state, never from `opacity: 0`. Size a hero to what it holds, not the viewport. A tool opens in a realistic working state with real data or plainly marked examples.

**Avoid the generated look.** Warm cream with a serif display and terracotta accent. Near-black with one acid green or vermilion pop. Broadsheet hairlines with dense columns. Purple-to-blue gradient hero on white. Inter or Space Grotesk as the safe face. Emoji as section markers. Everything centered. One radius everywhere. An accent rail on rounded cards. Where the user pins a direction, follow it exactly. Where nothing is specified, spend the freedom elsewhere.

**Build cleanly.** Watch overlapping elements, cascade collisions, and silent font fallbacks. Close every element, double-quote attributes, give keyboard focus a visible state, respect `prefers-reduced-motion`. Generative or decorative graphics use Canvas or WebGL, not long hand-written SVG paths.

**Mind selector specificity.** A type-based `.section` fighting an element-based `.cta` over padding silently undoes spacing. Structure the cascade so it does not.

**Write the copy as design material.** Name things by what people recognize, not how the system is built. Active voice. A control says exactly what happens. Errors say what went wrong and how to fix it. Specific beats clever. Simplified Technical English applies here as everywhere.

**Name the page like a product.** The `<title>` is the page's name in a tab and a gallery. Two to four words, specific to the subject, or the one question the page answers. No explainer after a dash or colon. Never a category label that fits any page. The one-sentence description carries the explanation.

**Structure is information.** Numbering, eyebrows, dividers, and labels encode something true about the content. Numbered markers only when the content is a sequence.

**When it is a UI, not a document.** A dashboard is scanned and operated. Surface the summary before the detail. Encode state in form as well as number: a pill, a chip, a severity stripe. Semantic color (good, warning, critical) is separate from the accent and does not count as the accent. Sparklines and charts get the same care as type. What is interactive looks interactive.

## Process

Before code, a five-line plan:

- **Color**: four to six named hex values.
- **Type**: faces for two or more roles. A characterful display face used with restraint, a complementary body face, a utility face for captions or data if needed.
- **Layout**: one or two sentences.

Build from the plan. Derive every color and type decision from it.

**Write, look once, publish.** One screenshot, one pass of edits, no second look. For a page that charts real numbers, take the look and spend it on the chart. No test loop around your own file: no repeated screenshots, no DOM probes, no pulling the script out to run in node. Then publish and stop. The live page is the review surface. If the user reports something visibly broken, fix that and republish once.

## When the request is editorial

The client has already rejected proposals that felt templated. Make opinionated calls. Take one real aesthetic risk where it serves the work.

Review the plan against the subject before building. If any part reads like the default you would produce for any similar page, revise it and note what changed.

- The hero is a thesis: open with the most characteristic thing in the subject's world.
- Typography carries the personality. Pair display and body deliberately, not the families you reach for on every project.
- Motion is deliberate. One orchestrated moment lands harder than scattered effects. Sometimes none is right; extra animation reads as generated.
- Match complexity to the vision. Maximalist directions need elaborate execution; minimal directions need precision.
- Spend boldness in one place and keep everything around it quiet. If the accent fights the ground, shift it toward analogous or drop saturation.
