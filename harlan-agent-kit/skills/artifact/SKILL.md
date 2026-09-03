---
name: artifact
description: "Codex only. Publish one self-contained HTML Artifact for a report, plan, dashboard, or tool when no native Artifact tool exists. Use in Codex for long or complex output, or when the user asks for an artifact, page, dashboard, or visual report. Claude Code uses its native Artifact tool instead and never loads this skill."
user_invocable: true
---

# Artifact (Codex)

One HTML file, designed for the reader, published where they can open it.

Claude Code has a native Artifact tool that hosts the page on claude.ai, with its own `artifact-design` skill. If you are Claude Code, stop here and use that tool. This skill gives Codex the same result: the same fragment format, the same page skeleton, the same design rules, a local file instead of a URL.

## When to publish an Artifact

- The answer is long or complex: a report, a plan for others, an audit, a comparison, a decision memo.
- The content is visual or interactive: a chart, a dashboard, a diagram, a tool, a game.
- The user asks for an artifact, a page, a dashboard, or something they can share.

Do not publish for advice the user will act on alone, right now, in the code at hand. A short answer stays in chat. Plain working notes stay in `~/scratch/notes/`.

## Format, identical to a Claude Artifact

Write the page as a fragment, not a document. No `<!doctype>`, `<html>`, `<head>`, or `<body>`. Start the file with `<title>` and `<style>`, then the content. The host wraps it in one skeleton: charset, viewport, `color-scheme: light`, zero body margin, a 14px system font on an off-white ground, `img{max-width:100%}`, and `[hidden]{display:none!important}`. `templates/skeleton.html` is that skeleton.

- Everything ships in the file. Inline CSS and JS. Images as data URIs. Fonts from Google Fonts only, with a real fallback stack.
- External scripts only from `https://cdnjs.cloudflare.com` (preferred), `https://cdn.jsdelivr.net/npm/`, `https://cdn.tailwindcss.com`, or `https://code.jquery.com`. Pin exact versions. Most pages need no library.
- Mermaid renders natively: use `<pre class="mermaid">`. Do not load Mermaid yourself.
- Under 16 MB rendered. No horizontal page scroll: wide tables, code, and diagrams scroll inside their own `overflow-x: auto` container.
- Theme aware. The complete light palette lives on bare `:root` as tokens. Dark redefines only tokens, under `@media (prefers-color-scheme: dark)` guarded as `:root:not([data-theme="light"])`, and again under `:root[data-theme="dark"]`. `body` sets an explicit token background. `templates/page.html` has the pattern.
- `<title>` is a product name: two to four words, specific to the subject, no explainer after a dash or colon. Keep it stable across republishes.

A fragment written this way is byte for byte what Claude's Artifact tool accepts, so a page can move between the two later.

## Process

1. **Read the request.** Utilitarian or editorial? Most pages are utilitarian: polished hierarchy, considered spacing, a proper palette, no hero. Read `references/design.md` before writing. It is the design rubric this skill exists for.
2. **Plan in five lines.** Four to six named hex colors, two type roles with faces, one sentence of layout. Then build from the plan. Diagrams follow `references/diagrams.md`.
3. **Write the fragment** to the scratchpad directory, or `~/scratch/artifacts/src/<slug>.html` when no scratchpad exists.
4. **Look once.** One screenshot of the rendered page, one pass of edits. No test loop around your own file.
5. **Publish.** `scripts/publish.sh <slug> <fragment>` writes `~/scratch/artifacts/<slug>.html` and prints the path. Add `--open` to open it for the user. The same slug overwrites the same path, so the slug is the page's stable identity. Lowercase letters, digits, and hyphens.
6. **Report.** Three lines in chat plus the link or path. The page is the deliverable; chat does not repeat it.

## Publish

The publish script refuses a full document, because a page with its own `<html>` would render differently from a Claude Artifact. Fix the fragment, do not bypass the script.

### Look once

`dev-browser run` takes a script file, not stdin. Write the script to the scratchpad first.

```bash
scripts/publish.sh <slug> <fragment>
cat > "$SCRATCHPAD/look.js" <<'JS'
const page = await browser.getPage("artifact")
await page.goto("file:///home/USER/scratch/artifacts/<slug>.html")
await page.waitForTimeout(1500)
console.log(await saveScreenshot(await page.screenshot({ fullPage: true }), "artifact-<slug>.png"))
await browser.closePage("artifact")
JS
dev-browser --browser artifact-<slug> run "$SCRATCHPAD/look.js"
```

Read the screenshot, fix what it shows, publish again, stop. Close every named page. Never run `dev-browser stop`.

## Gotchas

- **The un-stamped theme is the common case.** Most readers set no theme, so only `prefers-color-scheme` applies. A color defined only inside a `[data-theme]` block never reaches them.
- **A `100vh` hero pushes the page out of the first frame.** Size the opener to what it holds.
- **Nothing parked at `opacity: 0`.** The first still frame is what a thumbnail and a skimming reader get.
- **Not everything is a card.** One radius and one shadow on every block flattens the hierarchy.
- **Avoid the generated look.** Cream ground with serif display and terracotta accent, black with one acid green, purple-to-blue gradient hero, Inter or Space Grotesk by default, emoji section markers, everything centered. The user's own words override this.
- **Sensitive content stays local.** A page imitating a real organization or person, a fabricated record, or content the user called sensitive is built as a file and never given a URL.
