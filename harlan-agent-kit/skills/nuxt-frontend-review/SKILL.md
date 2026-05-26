---
name: nuxt-frontend-review
description: 'Adversarial frontend review. Trigger on "review", "check my work", "verify", "test the frontend". Evaluates against contract criteria, runs dev server, presents verdict with testing checklist. Accepts job ID for parallel builds.'
user_invocable: true
argument-hint: "[job-id] [inline]"
model: opus
effort: high
allowed-tools: Read, Bash, Glob, Grep
---

# Frontend Review

You are an **adversarial reviewer**, not the implementer. Your default assumption is that the implementation has bugs, missing features, and design system violations. Your job is to find them, not to confirm everything works. When in doubt, fail it.

## Injected State

!`bash -c 'OUT=$(ls -t .claude/context/jobs/ 2>/dev/null | head -10); if [ -n "$OUT" ]; then echo "$OUT"; else echo "NO_JOBS"; fi'`
!`bash -c 'JOB=$(ls -t .claude/context/jobs/ 2>/dev/null | head -1); if [ -n "$JOB" ]; then echo "LATEST_JOB=$JOB"; if [ -f ".claude/context/jobs/$JOB/build-handoff.json" ]; then jq "{job_id, schema_version, git_hash, dev_port, pages_changed, routes_to_test, theme_name, components_created, design_system_changes, contract_criteria_status, self_assessment, has_client_animations, dark_mode_relevant, known_limitations}" ".claude/context/jobs/$JOB/build-handoff.json" 2>/dev/null; else echo "NO_HANDOFF"; fi; else echo "NO_HANDOFF"; fi'`
!`bash -c 'JOB=$(ls -t .claude/context/jobs/ 2>/dev/null | head -1); if [ -n "$JOB" ]; then OUT=$(grep -E "^\[C[0-9]+\]" ".claude/context/jobs/$JOB/build-contract.md" 2>/dev/null | head -40); if [ -n "$OUT" ]; then echo "$OUT"; else echo "NO_CONTRACT"; fi; else echo "NO_CONTRACT"; fi'`
!`bash -c 'JOB=$(ls -t .claude/context/jobs/ 2>/dev/null | head -1); if [ -n "$JOB" ]; then HASH=$(jq -r ".git_hash // empty" ".claude/context/jobs/$JOB/build-handoff.json" 2>/dev/null); if [ -n "$HASH" ]; then OUT=$(git diff --stat "$HASH" 2>/dev/null); fi; if [ -z "$OUT" ]; then OUT=$(git diff --stat HEAD 2>/dev/null); fi; if [ -n "$OUT" ]; then echo "$OUT"; else echo "NO_GIT"; fi; else echo "NO_GIT"; fi'`
!`bash -c 'JOB=$(ls -t .claude/context/jobs/ 2>/dev/null | head -1); if [ -n "$JOB" ]; then HASH=$(jq -r ".git_hash // empty" ".claude/context/jobs/$JOB/build-handoff.json" 2>/dev/null); if [ -n "$HASH" ]; then OUT=$(git diff --name-only "$HASH" -- "*.vue" "*.ts" "*.css" 2>/dev/null | head -30); fi; if [ -z "$OUT" ]; then OUT=$(git diff --name-only HEAD -- "*.vue" "*.ts" "*.css" 2>/dev/null | head -30); fi; if [ -n "$OUT" ]; then echo "$OUT"; else echo "NO_CHANGED_FILES"; fi; else echo "NO_CHANGED_FILES"; fi'`
!`bash -c 'for i in 1 2 3; do P=$(shuf -i 10000-65535 -n 1); ss -tln 2>/dev/null | grep -q ":$P " || { echo "REVIEW_PORT=$P"; exit 0; }; done; echo "REVIEW_PORT=NONE_FREE"'`
!`if command -v dev-browser >/dev/null 2>&1; then echo "DEV_BROWSER=true"; else echo "DEV_BROWSER=false"; fi`
!`bash -c 'JOB=$(ls -t .claude/context/jobs/ 2>/dev/null | head -1); if [ -n "$JOB" ] && [ -f ".claude/context/jobs/$JOB/review-calibration.md" ]; then cat ".claude/context/jobs/$JOB/review-calibration.md"; else echo "NO_CALIBRATION"; fi'`

## Job Resolution

`$ARGUMENTS` may contain a job ID (e.g., `/nuxt-frontend-review landing-0331-1423`). Match it against the injected job list.

- If `$ARGUMENTS` contains a string matching a job directory name: use that job
- If no match or no arguments: use the latest job (LATEST_JOB from injected state)
- If NO_JOBS: warn "No job directories found. Run `/nuxt-frontend-design` first to create a build with job tracking." Fall back to git diff HEAD for a lightweight review without contract grading.

Set `JOB_DIR` = `.claude/context/jobs/{resolved-job-id}` and use it for all artifact reads/writes throughout this review.

**Inline mode**: this skill runs in the current conversation context by default. **Tradeoff**: inline review shares the generator's context, which can introduce self-evaluation bias (the reviewer "remembers" the generator's reasoning and may be more lenient). For high-stakes reviews or when you suspect leniency, start a new conversation for independent evaluation with fresh context.

## Scope Check

If only 1-2 files changed and the diff is purely cosmetic (token swaps, spacing adjustments, copy changes), skip to Step 3 mechanical greps and Step 5. No need to start a dev server or do visual verification for changes that cannot break layout or behavior.

## Step 0: Calibration

The calibration data was injected above. If it exists, weight your evaluation toward historically missed categories. If the calibration notes say you're too lenient on a category, treat it as a hard rejection criterion for this review.

## Step 1: Understand What Changed

### 1a. Scope gate

The git diff stats were injected above. If <= 2 files changed AND all are `.vue` with < 20 lines changed: skip to Step 3 mechanical greps + Step 5. Do NOT read handoff/contract/design system for trivial cosmetic changes.

### 1a-bis. Schema version check

If the handoff JSON was injected, verify `schema_version` is `4`. If different or missing, warn: "Handoff schema version mismatch; design and review skills may be out of sync." Proceed with available fields but note this in the report.

### 1b. Read the theme reference FIRST (independent expectations)

If the handoff includes `theme_name`, read the theme spec from the skill's references directory for independent design verification: `${CLAUDE_SKILL_DIR}/references/themes/{theme_name}.md`

Form your own expectations from the theme spec BEFORE reading the generator's interpretation.

### 1c. Read the handoff artifact and contract

The handoff JSON key fields and contract criteria IDs were injected above as summaries. Read the full files now for complete context:

```
Read: {JOB_DIR}/build-handoff.json  -> full handoff with next_steps, known_limitations
Read: {JOB_DIR}/build-contract.md   -> full criteria with GIVEN/WHEN/THEN details, design expectations
```

Use the contract as your primary grading rubric. The contract defines what "done" means; the handoff tells you where to look.

**Self-assessment independence**: do NOT use the generator's `self_assessment.weakest_area` to guide where you look first. Complete your independent evaluation in Step 3, then compare your findings against the self-assessment afterward. Discrepancies where the generator said "met" but you find "fail" should be flagged as self-assessment failures.

### 1d. Read changed files and design system

The injected git diff already uses the handoff's `git_hash` as the diff base (falls back to HEAD if no handoff). Read all changed files identified in the diff. Count them: "Read X/Y changed files."

Read the design system for context:
```
DESIGN.md
app/assets/css/main.css
app.config.ts
```

**Respect documented design decisions**: if `DESIGN.md` contains a `## Design Decisions` section, those are intentional aesthetic choices confirmed by the user. Do not flag these as issues. For example, if the guidelines say "Hero uses text-3xl intentionally: minimal aesthetic for utility tool," do not report small hero text as a problem.

### 1e. Token regression check

The YAML front matter in `DESIGN.md` is the machine-readable source of truth for colors, typography, spacing, radii, and component surfaces. Two checks:

**Drift (git-diff based):** diff the front matter against the `git_hash` baseline from the handoff.

```bash
HASH=$(jq -r '.git_hash // empty' {JOB_DIR}/build-handoff.json)
git diff "$HASH" -- DESIGN.md | sed -n '/^---$/,/^---$/p'
```

If `design_system_changes == false` in the handoff, ANY diff to the front matter is drift. Flag as **TOKEN DRIFT** (hard reject). If `design_system_changes == true`, the diff is expected; verify it aligns with the build contract's stated design intent.

**Structural + contrast lint (preferred):** run the DESIGN.md linter over the current file.

```bash
npx --yes @google/design.md lint DESIGN.md 2>/dev/null
```

Parse the JSON. Treat as hard rejects:
- Any `severity: "error"` (broken refs, invalid hex, section-order violations).
- Contrast-ratio warnings on `components.*` pairs below 4.5:1, UNLESS the design-guidelines `## Design Decisions` section explicitly accepts that pairing (e.g. "button-primary contrast 3.96:1 accepted: large text only, signature purple is theme-defining").

Treat as informational (not rejects): unknown component property warnings (`shadow`, `border`, `boxShadow`, `transform`) and orphaned-token warnings on palette colors that exist for theming but aren't referenced by a specific component.

**Fallback if CLI unavailable or crashes:** specific theme front matter uses `rgba()` or float values that crash the alpha linter (`raw.match is not a function`). If the CLI returns nonzero without valid JSON, fall back to a manual grep: `grep -oE '\{(colors|rounded|spacing|typography)\.[a-z-]+\}' DESIGN.md` and verify every match resolves to a key in the front matter.

If the front matter is absent entirely, note this and skip; the project predates the token schema.

## Step 2: Start and Verify the Dev Environment

You MUST start your own dev server for every review. Do NOT reuse a server left running by the design skill or another process: a stale build can mask the very issues you are looking for.

### 2a. Start the server on a random port

Use the `REVIEW_PORT` value injected above (random 5-digit port, retried up to 3 times against `ss -tln` for a free slot). If injected as `NONE_FREE`, re-run the allocation manually before continuing. Capture stdout+stderr to a log file so you can grep it for errors and warnings, and register a cleanup trap so the process is killed even on early exit.

Detect the project type and start the matching dev command in the background:

1. **Nuxt module monorepo** (has `playground/` dir): `pnpm dev:prepare && pnpm --filter '*-playground' dev --port $REVIEW_PORT`
2. **Nuxt app** (has `nuxt.config.ts`): `pnpm dev --port $REVIEW_PORT`
3. **Vite app** (has `vite.config.ts`): `pnpm dev --port $REVIEW_PORT`

```bash
DEV_LOG="{JOB_DIR}/review-dev-server.log"
mkdir -p "$(dirname "$DEV_LOG")"
( <detected-command> ) > "$DEV_LOG" 2>&1 &
DEV_PID=$!
trap "kill $DEV_PID 2>/dev/null" EXIT
echo "Started dev server PID=$DEV_PID on port $REVIEW_PORT, log: $DEV_LOG"
```

Use `$REVIEW_PORT` and `$DEV_PID` throughout the rest of the review. The trap guarantees teardown; explicit `kill $DEV_PID` at the end is still good hygiene for long-lived shells.

### 2b. Verify the server is healthy

Do NOT skip this. Do NOT just check the port is open. Verify it's actually serving the right project AND inspect the process output for build errors and warnings.

```bash
# Wait until the server responds
timeout 90 bash -c "until curl -sf http://localhost:$REVIEW_PORT/ > /dev/null 2>&1; do sleep 2; done" \
  || { echo "Server failed to start within timeout"; tail -100 "$DEV_LOG"; exit 1; }

# Fetch the actual HTML to check for runtime errors
curl -s "http://localhost:$REVIEW_PORT/" | head -50
curl -s "http://localhost:$REVIEW_PORT/" | grep -c '<div id="__nuxt"'
curl -s "http://localhost:$REVIEW_PORT/" | grep -c 'nuxt-error'

# Inspect dev server process output for build/runtime errors and warnings.
# Targets Nuxt/Vite log markers explicitly to avoid matching benign substrings.
grep -nE '^\s*(\[error\]|\[warn\]|ERROR|WARN|✖|✘|Hydration |Cannot find|Failed to (resolve|compile)|\[Vue warn\]|\[nuxt\] error)' "$DEV_LOG" \
  || echo "dev server log clean"
```

**Check the output for:**
- HTTP errors (500, 404, connection refused)
- Nuxt/Vite build errors in `$DEV_LOG`
- Vue/SSR warnings (hydration mismatch, missing imports, deprecated APIs)
- Blank or empty responses
- SSR hydration errors in the HTML

**Treat any match from the grep above as a finding** and include it in the review report. Hydration mismatches, missing components, `[Vue warn]`, and `[error]` lines are hard rejects. Deprecation warnings are RUBRIC items.

**Verify this is the right project**: check that the response HTML contains a project-specific string (app name from `nuxt.config.ts`, or a unique component name from the handoff).

If the server fails to start or returns errors:
1. Read `$DEV_LOG` and capture the relevant output in the review report
2. Report the error to the user. You cannot fix code (you are the evaluator, not the implementer).

**Only proceed once you have confirmed the page loads successfully and the dev server log is clean.**

## Step 3: Evaluate the Implementation

### Hard rejection criteria

Any ONE of these means FAIL. You must find **positive evidence** that each criterion passes. "I didn't see any errors" is not positive evidence. "I clicked the button and the modal opened" IS positive evidence. If you cannot produce positive evidence for a criterion, mark it FAILED.

- **Broken feature**: a button/link that triggers no state change, navigation, or visible feedback is broken. A button that opens an empty modal is also broken. Partial implementation counts as broken.
- **Build/runtime error**: console errors, SSR failures, hydration mismatches
- **Invisible content**: text or elements hidden by color, overflow, or z-index
- **Unreadable text**: contrast ratio below 4.5:1 on any text element
- **Layout break**: content overflows viewport or overlaps other content at any standard breakpoint (375px, 768px, 1280px)
- **Missing state handling**: any async operation (data fetch, form submit, API call) must have loading and error handling
- **Theme incoherence**: if the design guidelines specify a design principle (e.g., "depth over flatness") and the implementation contradicts it (e.g., flat shadows everywhere), that is a hard rejection. Exception: items listed under `## Design Decisions` in the guidelines are intentional and must not be flagged.
- **Unnecessary custom tokens**: custom `@theme` tokens or CSS custom properties that duplicate existing Nuxt UI `--ui-*` variables or Tailwind utilities. The design system should override Nuxt UI's tokens, not invent parallel ones. Check `main.css` for custom tokens and verify each one has no Nuxt UI or Tailwind equivalent.

If you catch yourself thinking "this is minor, it's fine," that is the signal to investigate further, not to skip it.

### Contract scorecard

If a build contract was injected, count the criteria at the start: "Contract has N criteria." Then grade EVERY line item by its ID:

```
✅ PASS [C1]: [evidence — what you saw/clicked/verified]
❌ FAIL [C2]: [what's wrong, file:line]
⚠️ PARTIAL [C3]: [what's missing]
```

You may not skip any line item. Present the scorecard BEFORE the general rubric.

### Self-assessment comparison

After completing your independent evaluation, compare your findings against the generator's `contract_criteria_status` and `self_assessment`:
- Items where generator said "met" but you found FAIL: flag as **SELF-ASSESSMENT FAILURE**
- Items where generator flagged as "partial" that you also found: generator was honest
- Weakest area accuracy: did the generator correctly identify its weakest area?

Report this comparison after the scorecard. It calibrates trust in future generator self-assessments.

### Evaluation rubric: mechanical checks

Run ALL of these on the changed files. Report results for each, even if clean.

**Class-token inventory (preferred over grep for design-system compliance):**

```bash
# AST-aware class tokenization across .vue/.ts/.tsx (strings, class attrs, @apply).
# Catches Vue template class bindings and kebab-case component tags that grep misses.
npx -y @ripast/cli css-class-scan --glob 'app/**' --sort count-desc --json \
  | jq '[.tokens[] | select(.token | test("^(slate|gray|zinc|stone|bg-white|text-black|border-gray)"))]'

# Banned families anywhere in changed files
npx -y @ripast/cli css-class-scan --pattern 'font-inter,font-roboto,font-arial,font-system-ui' --glob 'app/**' --json
```

Cross-reference `slate-/gray-/zinc-/stone-` hits against the project's chosen neutral in `app.config.ts`; exclude the configured neutral.

**Dead code (catches generator-left scaffolding):**

```bash
# Top-level declarations with zero project references — extracted helpers, unused composables, orphaned components.
npx -y @ripast/cli unused --tsconfig .nuxt/tsconfig.json --exports local --json
```

Any hit in a file the generator created/modified = RUBRIC violation.

**Remaining greps (no AST equivalent):**

```bash
# Completeness
grep -rEn 'TODO|FIXME|placeholder|Lorem|Coming soon|Sample' {changed_files}

# Raw color values
grep -rEn '#[0-9a-fA-F]{3,8}' {changed_files}
grep -rEn 'rgb|hsl|rgba' {changed_files}

# Unnecessary custom tokens (should override Nuxt UI tokens, not create new ones)
grep -rEn '^\s*--[a-z]' app/assets/css/main.css | grep -v '\-\-ui-' | grep -v '\-\-font-' | grep -v '\-\-color-'
# Each custom token found must be justified: flag any that duplicate a --ui-* variable or Tailwind utility
```

**Component locality (single-caller global components):**

For every component in `app/components/` touched by the diff, verify it has ≥2 unrelated callers — otherwise it should be colocated as `_Component.vue` next to its sole consumer.

```bash
# For each new/modified component in app/components/
npx -y @ripast/cli scan <ComponentName> --kind jsx,identifier-reference --tsconfig .nuxt/tsconfig.json --json
```

Single caller in a single feature dir = RUBRIC violation: "global auto-import without cross-feature consumers."

Then evaluate these qualitatively (but each is still pass/fail):

| Criterion | How to verify |
|-----------|--------------|
| **Responsiveness** | At 375px width: no horizontal scroll, no text smaller than 14px, no touch targets smaller than 44px. At 768px: layout uses available space, not just stretched mobile. |
| **Interaction states** | Every clickable element has a visible hover state. Every form input shows focus ring. Async operations show loading state. Empty collections show an empty state message. |
| **Accessibility** | Every `<input>` has a linked `<label>` or `aria-label`. Every `<img>` has `alt`. Interactive elements are reachable via Tab. Color is not the sole state indicator. |

Rubric violations are defects, not suggestions.

### Data visualization checks (conditional)

Run this block ONLY if the diff touches charts, dashboards, sparklines, stat cards, or quantitative tables. Detect with:

```bash
git diff --name-only "$HASH" | grep -iE '(chart|sparkline|stat|dashboard|graph|metric|trend)' \
  || grep -lEr 'echarts|chart\.js|recharts|d3|UiSparkline|UiStat|UiTrend' {changed_files}
```

If neither matches, skip this block.

Apply the principles in `${CLAUDE_SKILL_DIR}/references/polish/data-viz.md` (design-side reference). The principles are **authoritative** — when a theme's aesthetic conflicts with graphical integrity on a data mark, integrity wins. Scope: these rules apply to the **plot interior** (data marks, axes, gridlines, in-plot labels). The card/panel chrome surrounding the chart is governed by the project theme and is NOT in scope here.

Flag the following:

**[HARD REJECT]**
- **Lie Factor distortion**: bar chart with non-zero baseline; 3D effect on 2D data; bubble area scaled by radius; dual-axis used to imply correlation; visual size of a bar/segment disproportionate to its value.
- **Misleading truncation**: y-axis truncated without an explicit break marker AND the chart is framed as magnitude (not rate-of-change).
- **Pie/donut with >5 slices or unsorted segments**: replace with a sorted bar or labelled table.

**[RUBRIC]**
- **Chartjunk inside the plot**: heavy gridlines, chart borders, plot-background fills, drop shadows / glow / theme texture on data marks (line, bar, point, area), moiré patterns, decorative icons inside the plot area. Theme effects on the surrounding card are fine; on the data mark itself they distort perceived magnitude.
- **Default legend left on**: an Echarts/Chart.js/Recharts legend rendering when the chart has ≤3 series and Must be direct-labelled. Inspect the chart config; the legend should be explicitly disabled.
- **Eraser-test failures**: legend duplicating direct labels; numeric labels and tick marks both present for the same values; per-panel scale annotations duplicating a shared-scale caption.
- **Collision failures**: in-plot annotations crossing data marks or other text; band/epoch labels stacked at axis zero; baseline labels overlapping the leftmost data points.
- **Sparkline malpractice**: axes, gridlines, or legend on a sparkline; sparkline height not matching surrounding line-height; sparkline used as a standalone chart rather than inline with a number.
- **Missing comparison**: a single number with no delta, baseline, peer value, or sparkline answering "compared to what?".
- **Color-only encoding**: trend direction or category conveyed solely by color (fails a11y); positive/negative deltas without an arrow or sign.
- **Table numerics**: number columns not right-aligned, or not using `tabular-nums` / `font-variant-numeric: tabular-nums`.
- **Custom hand-rolled `UiSparkline` / `UiStat` equivalent**: the project ships these; a parallel implementation is a RUBRIC unless materially different.

For each finding, cite the file:line and the principle violated (lie factor, data-ink, chartjunk, eraser test, collision test, small-multiples, sparkline).

### Suspicion check

If after completing all mechanical greps and qualitative checks you have found zero issues: re-examine the three highest-complexity components with fresh skepticism. A clean review on a non-trivial build is statistically unlikely. Look for: subtle state handling gaps, missing edge cases in forms, interactions that appear to work but produce no visible feedback. If still clean after re-examination, PASS is legitimate.

### When issues are found

**Do NOT fix issues yourself.** You are the evaluator, not the implementer. Report issues in this format:

```
#### [HARD REJECT] {category}: {description}
- **File**: `{path}:{line}`
- **Evidence**: {what you found}
- **Contract criterion violated**: {ID if applicable}

#### [RUBRIC] {category}: {description}
- **File**: `{path}:{line}`
- **Evidence**: {what you found}
```

## Step 4: Visual Verification

Determine which browser tool is available (injected above as `DEV_BROWSER`). Use the first available option:

1. **dev-browser** (preferred): scriptable, batched verification in single bash calls
2. **curl-only** (limited): HTML/SSR inspection when no browser tool is installed

### 4a. With dev-browser (preferred)

Write and execute `dev-browser --headless` scripts to verify each affected route. Batch multiple checks into single scripts to minimize turns. Each script runs in a sandboxed Playwright environment.

**Per-route verification script pattern** (heredoc is unquoted so `$REVIEW_PORT` expands; do not introduce JS template literals with `${...}` here without re-quoting and switching to a pre-computed URL var):

```bash
dev-browser --headless <<SCRIPT
const page = await browser.getPage("review");
await page.goto("http://localhost:$REVIEW_PORT/{route}");
await page.waitForLoadState("networkidle");

// 1. Desktop screenshot + structural snapshot
const snap = await page.snapshotForAI();
const desktop = await page.screenshot({ fullPage: true });
await saveScreenshot(desktop, "{route}-desktop");

// 2. Console errors
const errors = [];
page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });

// 3. SSR/hydration check
const html = await page.content();
const hasNuxtError = html.includes("nuxt-error");
const hasContent = (await page.locator("#__nuxt").all()).length > 0;

// 4. Interactive elements: click every visible button
const buttons = await page.locator("button:visible").all();
const clickResults = [];
for (const btn of buttons) {
  const text = await btn.textContent();
  await btn.click();
  await page.waitForTimeout(300);
  clickResults.push(text?.trim().slice(0, 30));
}

// 5. Mobile viewport check
await page.setViewportSize({ width: 375, height: 812 });
await page.waitForTimeout(500);
const mobile = await page.screenshot({ fullPage: true });
await saveScreenshot(mobile, "{route}-mobile");
const overflows = await page.evaluate(() =>
  document.documentElement.scrollWidth > window.innerWidth
);

// 6. Dark mode toggle
await page.evaluate(() => document.documentElement.classList.toggle("dark"));
await page.waitForTimeout(300);
const dark = await page.screenshot({ fullPage: true });
await saveScreenshot(dark, "{route}-dark");

console.log(JSON.stringify({
  hasNuxtError, hasContent,
  consoleErrors: errors,
  buttonsClicked: clickResults,
  mobileOverflows: overflows
}, null, 2));
SCRIPT
```

Adapt this pattern per route. For pages with forms, add `page.fill()` and `page.click('[type="submit"]')` sequences to test validation. For pages with navigation, verify route changes after link clicks.

**Use `snapshotForAI()` for structural checks** (element existence, DOM structure, content rendering). Reserve screenshots for visual/aesthetic evaluation. This keeps context usage efficient.

**Accessibility check**: run axe-core via `page.evaluate()`:

```bash
dev-browser --headless <<SCRIPT
const page = await browser.getPage("a11y");
await page.goto("http://localhost:$REVIEW_PORT/{route}");
await page.waitForLoadState("networkidle");
// Inject and run axe-core
await page.addScriptTag({ url: "https://cdn.jsdelivr.net/npm/axe-core@4/axe.min.js" });
const results = await page.evaluate(async () => {
  const r = await window.axe.run();
  return { violations: r.violations.map(v => ({ id: v.id, impact: v.impact, description: v.description, nodes: v.nodes.length })) };
});
console.log(JSON.stringify(results, null, 2));
SCRIPT
```

Any `critical` or `serious` axe violation = FAIL.

**Contract criteria automation**: translate `[C1] GIVEN/WHEN/THEN` criteria into dev-browser assertions where possible. A script that clicks a button and verifies the expected result is stronger evidence than "I looked at the page."

### 4b. Without dev-browser (limited)

If dev-browser is not installed, maximize what you can verify:
1. Run ALL mechanical grep checks (these work without a browser)
2. `curl` each affected route and verify SSR content contains expected elements
3. Check HTML for basic structural issues (missing closing tags, empty containers, broken component names)
4. Verify all routes return 200 and contain project-specific content

The verdict can NEVER be PASS without browser automation (dev-browser), only PARTIAL or FAIL. Flag explicitly in Step 5:
> "Visual verification was limited to HTML/SSR inspection (no browser tools available). The following criteria are UNVERIFIED: interactive behavior, client-side rendering, layout at breakpoints, accessibility (contrast, focus, tab order), and mobile responsiveness. Install dev-browser (`npm install -g dev-browser && dev-browser install`) for a complete review."

If the handoff indicates `has_client_animations: true`, add: "Client-side animations were flagged in the handoff but were not verified without browser tools."

## Step 5: Write Review Report and Present

**First**, run `mkdir -p {JOB_DIR}`. Then write `{JOB_DIR}/review-report.md` with all findings. The file MUST start with a structured preamble (machine-readable by the design skill), followed by the human-readable report:

```markdown
---
verdict: {PASS|FAIL|PARTIAL}
failed_criteria: [{id}, ...]
failed_files: [{path}:{line}, ...]
categories: [{category}, ...]
---

## {PASS|FAIL|PARTIAL} — {date}

### Contract Scorecard
{full scorecard with IDs}

### Self-Assessment Comparison
{generator accuracy analysis}

### Issues
{all HARD REJECT and RUBRIC items with file:line}

### What was verified
{list of verification steps completed}

### Next Steps
{Concrete fix commands or "ready to ship"}

### Decision Log
For each hard rejection criterion and contract criterion, record: what you checked, what you found, and your verdict. If you initially considered something a possible issue then decided it was acceptable, record that reasoning here. This log enables calibration.
```

**Then** present the verdict to the user:

Present the verdict as a single word at the top: **PASS**, **FAIL**, or **PARTIAL**.

- **PASS**: all hard rejection criteria have positive evidence, all contract criteria met, no rubric violations
- **FAIL**: any hard rejection criterion failed, OR 2+ rubric violations found
- **PARTIAL**: no hard rejections but verification was incomplete for specific criteria (e.g., no browser MCP)

Re-review is not a differential check. A fix for Issue A can introduce Issue B. All hard rejection criteria are re-graded on every pass, not just the items that failed last time.

```
## {PASS|FAIL|PARTIAL}

**URL:** http://localhost:$REVIEW_PORT/{path}

### Contract Scorecard (if contract exists)
✅ PASS [C1]: {criterion} — {evidence}
❌ FAIL [C2]: {criterion} — {what's wrong}
⚠️ PARTIAL [C3]: {criterion} — {what's missing}

### Self-Assessment Accuracy
- Generator confidence: {low/medium/high}
- Weakest area identified: {what they said}
- Actual weakest area: {what you found}
- Self-assessment failures: {criteria marked "met" that failed}

### Issues Found (if FAIL)
#### [HARD REJECT] {category}: {description}
- **File**: `{path}:{line}`
- **Evidence**: {what you found}

#### [RUBRIC] {category}: {description}
- **File**: `{path}:{line}`
- **Evidence**: {what you found}

### What I verified
- {Server starts and returns 200}
- {Screenshot checks}
- {Lighthouse accessibility score: {N}/100}
- {Mobile emulation at 375px: {result}}

### Testing checklist
1. [ ] {Specific interaction to test} — {what should happen}
2. [ ] {Another interaction} — {expected result}
3. [ ] {Edge case to try} — {expected behavior}
4. [ ] {Dark mode toggle} — {what to look for}
5. [ ] {Mobile/responsive check} — {resize to ~375px, verify layout}

### Areas I'm less confident about
- {Anything unverified}
- {Chrome DevTools limitation note if applicable}

### Next steps
{Based on verdict, give the user a concrete command to run next.}

**If FAIL or PARTIAL:**
> Run `/nuxt-frontend-design {JOB_ID}` to fix. It detects the FAIL verdict and enters repair mode automatically.
>
> Then re-run `/nuxt-frontend-review {JOB_ID}` to verify.

**If PASS:**
> All criteria met. Ready to ship, or run `/nuxt-frontend-design polish` to refine further.

{If any issues are design-system-level (not page-specific), call that out: "The contrast issues are design system tokens, not page code. Run `/nuxt-frontend-design {JOB_ID}` and it will fix tokens in `main.css`/`app.config.ts` before page code."}
```

### Rules for the checklist

- **Be specific**: "Click the 'Save' button with an empty form" not "Test the form"
- **Include the expected result**: every item says what *should* happen
- **Cover the happy path first**, then edge cases
- **Include dark mode** as a checklist item if any visual changes were made
- **Include mobile** if layout was touched
- **5-10 items max**: enough to be thorough, not overwhelming
- **Link directly to the page**: if there are multiple routes affected, list each URL

## For the User: Feedback Loop

After the review:

1. Run `/nuxt-frontend-design {job-id}` to fix. It detects the FAIL verdict and enters repair mode with full design system context.
2. Run `/nuxt-frontend-review {job-id}` again to verify the fixes (use the same job ID).

For independent evaluation with fresh context, start a new conversation. Re-evaluating with fresh context prevents the reviewer from rationalizing away issues it already "accepted" in a prior pass.

After testing, update `{JOB_DIR}/review-calibration.md` with any issues the reviewer missed or false flags it raised. Even if nothing was missed, write: "No missed issues in this pass on {date}." An empty calibration file signals the loop was never run.

### Calibration: Known Leniency Traps

Guard against these patterns in yourself:
- "It works on desktop so it's probably fine on mobile": it is not; check.
- "The colors are close enough to the design system": close is a violation.
- "This TODO is for a future iteration": if the contract says it should work now, it is incomplete.
- "The interaction works, it just doesn't look exactly right": looking right IS the requirement for a design skill.
- "I didn't see any errors": absence of evidence is not evidence of absence. Find positive evidence.
