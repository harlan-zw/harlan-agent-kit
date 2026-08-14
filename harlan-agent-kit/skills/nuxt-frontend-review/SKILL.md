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

## Worktree isolation

An existing worktree alone does not prove another agent is active.

`wt` is the only worktree tool. Never run `git worktree add`, and never use a harness worktree option such as `EnterWorktree` or `isolation: "worktree"`. Those write to `.claude/worktrees/`, which is banned. `wt` places every worktree at `<parent>/<repo>.<branch-slug>`.

Resolve the builder checkout before reading job state. Build candidate roots from the current checkout and every absolute `path` returned by `wt list --format=json`. Never create a worktree solely for review.

## Job Resolution

`$ARGUMENTS` may contain a job ID or absolute builder path, for example `/nuxt-frontend-review landing-0331-1423`. Match an exact job ID across candidate roots or use the named absolute path.

If an exact ID exists in more than one root, or the builder root remains ambiguous, stop and request its absolute path. Never guess which diff to review.

Without an ID or path, prefer the newest job in the current checkout. If the current checkout has no job, use another root only when exactly one candidate root contains jobs. If more than one other root contains jobs, require an exact job ID or absolute builder path.

Set `REVIEW_ROOT` to the selected absolute checkout path. Set `JOB_DIR` to the absolute `{REVIEW_ROOT}/.claude/context/jobs/{resolved-job-id}` path. Pass `REVIEW_ROOT` as `workdir` to every repository command and use `JOB_DIR` for every artifact read or write.

After resolving these paths, discover state at runtime. Read the handoff, contract, changed-file diff, and calibration from `JOB_DIR`. Allocate `REVIEW_PORT` against active listeners. Detect `DEV_BROWSER` from `REVIEW_ROOT`. If no job exists in any candidate root, warn and use `git diff HEAD` from the current checkout for a lightweight review without contract grading.

Inline review shares the generator's context, which biases toward leniency. For high-stakes reviews, start a fresh conversation.

## Step 0: Calibration

Weight evaluation toward historically missed categories from `JOB_DIR/review-calibration.md`; a category flagged as a leniency trap becomes a hard rejection criterion for this review.

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

Use the runtime `DEV_BROWSER` result. Scripts, per-route pattern, axe-core run, and the curl-only fallback: [references/visual-verification.md](references/visual-verification.md).

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
