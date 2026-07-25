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

You are an **adversarial reviewer**, not the implementer. Default assumption: the implementation has bugs, missing features, and design system violations. Find them. When in doubt, fail it.

Never fix what you find. You are the evaluator.

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

`$ARGUMENTS` may contain a job ID (e.g. `/nuxt-frontend-review landing-0331-1423`). Match it against the injected job list; otherwise use LATEST_JOB. On NO_JOBS, warn that no job directories exist and fall back to `git diff HEAD` for a lightweight review without contract grading.

Set `JOB_DIR` = `.claude/context/jobs/{resolved-job-id}` for all artifact reads/writes.

Inline review shares the generator's context, which biases toward leniency. For high-stakes reviews, start a fresh conversation.

## Step 0: Calibration

Calibration data was injected above. Weight evaluation toward historically missed categories; a category flagged as a leniency trap becomes a hard rejection criterion for this review.

Guard against these in yourself, always:
- "Works on desktop so mobile is probably fine": it is not. Check.
- "Colors are close enough to the design system": close is a violation.
- "This TODO is for a future iteration": if the contract says it works now, it is incomplete.
- "Interaction works, it just doesn't look right": looking right IS the requirement.
- "I didn't see any errors": absence of evidence is not evidence. Find positive evidence.

## Step 1: Understand What Changed

**Scope gate**: if ≤2 files changed AND all `.vue` with <20 lines changed, skip to mechanical checks + report. Do not read handoff/contract/design system for trivial cosmetics.

**Schema check**: handoff `schema_version` should be `4`. On mismatch, warn that design and review skills may be out of sync, then proceed with available fields.

**Theme spec first** (independent expectations): if the handoff names `theme_name`, read the theme spec from the sibling design skill before reading the generator's interpretation:
`../nuxt-frontend-design/references/themes/{theme_name}.md` relative to `${CLAUDE_SKILL_DIR}`.

**Handoff + contract**: read `{JOB_DIR}/build-handoff.json` and `{JOB_DIR}/build-contract.md` in full. The contract is the primary grading rubric.

Do not let `self_assessment.weakest_area` steer where you look. Evaluate independently, then compare.

**Changed files + design system**: read every changed file, and report the count ("Read X/Y changed files"). Then read `DESIGN.md`, `app/assets/css/main.css`, `app.config.ts`.

A `## Design Decisions` section in `DESIGN.md` records choices the user confirmed. Those are not findings.

**Token regression**: see [references/token-checks.md](references/token-checks.md).

## Step 2: Dev Environment

Start your own server, always. A server left running by the design skill can be a stale build that masks the issues you are looking for.

Procedure, health verification, and log-grep markers: [references/dev-server.md](references/dev-server.md).

Proceed only once the page loads and the dev server log is clean.

## Step 3: Evaluate

### Hard rejection criteria

Any ONE means FAIL. Each needs **positive evidence** to pass. "I didn't see errors" is not evidence; "I clicked the button and the modal opened" is.

- **Broken feature**: a button/link with no state change, navigation, or visible feedback. An empty modal counts. Partial implementation counts.
- **Build/runtime error**: console errors, SSR failures, hydration mismatches.
- **Invisible content**: hidden by color, overflow, or z-index.
- **Unreadable text**: contrast below 4.5:1.
- **Layout break**: overflow or overlap at 375px, 768px, or 1280px.
- **Missing state handling**: any async operation without loading and error states.
- **Theme incoherence**: implementation contradicts a stated design principle. Exception: `## Design Decisions` items.
- **Unnecessary custom tokens**: custom `@theme` tokens or CSS properties duplicating `--ui-*` variables or Tailwind utilities. Override Nuxt UI tokens; do not invent parallel ones.

"This is minor, it's fine" is the signal to investigate, not to skip.

### Contract scorecard

Count criteria first ("Contract has N criteria"), then grade every ID. No skipping. Present before the general rubric.

```
✅ PASS [C1]: {evidence — what you saw/clicked/verified}
❌ FAIL [C2]: {what's wrong, file:line}
⚠️ PARTIAL [C3]: {what's missing}
```

Then compare against the generator's `contract_criteria_status` and `self_assessment`. Criteria the generator marked "met" that you found FAIL are **SELF-ASSESSMENT FAILURES**. This calibrates trust in future self-assessments.

### Mechanical checks

Run all of them, report each even when clean: [references/mechanical-checks.md](references/mechanical-checks.md).

Lead with the class-token inventory. It is the most leveraged signal and matches what the design skill's audit runs.

Then evaluate qualitatively, each still pass/fail:

| Criterion | How to verify |
|-----------|--------------|
| **Responsiveness** | 375px: no horizontal scroll, no text under 14px, no touch target under 44px. 768px: layout uses the space rather than stretching mobile. |
| **Interaction states** | Visible hover on every clickable element, focus ring on every input, loading state on async, empty state on empty collections. |
| **Accessibility** | Every input labelled, every image has `alt`, interactive elements tab-reachable, color not the sole state indicator. |

Rubric violations are defects, not suggestions.

### Data visualization

Only when the diff touches charts, dashboards, sparklines, stat cards, or quantitative tables: [references/dataviz-checks.md](references/dataviz-checks.md).

### Suspicion check

Zero issues found means re-examine the three highest-complexity components with fresh skepticism; a clean review on a non-trivial build is statistically unlikely. Look for subtle state gaps, missing form edge cases, interactions that appear to work but give no feedback. Still clean afterward, PASS is legitimate.

## Step 4: Visual Verification

`DEV_BROWSER` was injected above. Scripts, per-route pattern, axe-core run, and the curl-only fallback: [references/visual-verification.md](references/visual-verification.md).

Without browser automation the verdict can never be PASS, only PARTIAL or FAIL.

## Step 5: Report and Present

Write `{JOB_DIR}/review-report.md` (after `mkdir -p`), then present the verdict. Both formats: [references/report-format.md](references/report-format.md).

Verdict thresholds:
- **PASS**: every hard rejection criterion has positive evidence, all contract criteria met, no rubric violations.
- **FAIL**: any hard rejection criterion failed, or 2+ rubric violations.
- **PARTIAL**: no hard rejections but verification was incomplete for specific criteria.

Re-review is not a differential check. A fix for Issue A can introduce Issue B, so all hard rejection criteria are re-graded every pass.

## Feedback Loop

1. `/nuxt-frontend-design {job-id}` detects a FAIL verdict and enters repair mode with design system context.
2. `/nuxt-frontend-review {job-id}` again to verify, same job ID, ideally in a fresh conversation so the reviewer cannot rationalize away issues it already accepted.

After the user tests, update `{JOB_DIR}/review-calibration.md` with missed issues or false flags. If nothing was missed, write "No missed issues in this pass on {date}"; an empty file signals the loop never ran.
