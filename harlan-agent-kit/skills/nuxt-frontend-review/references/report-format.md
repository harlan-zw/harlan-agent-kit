# Report and Verdict Formats

## Finding format

```
#### [HARD REJECT] {category}: {description}
- **File**: `{path}:{line}`
- **Evidence**: {what you found}
- **Contract criterion violated**: {ID if applicable}

#### [RUBRIC] {category}: {description}
- **File**: `{path}:{line}`
- **Evidence**: {what you found}
```

## Written report: `{JOB_DIR}/review-report.md`

`mkdir -p {JOB_DIR}` first. The preamble is machine-read by the design skill, so it comes first.

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
{concrete fix commands, or "ready to ship"}

### Decision Log
For each hard rejection criterion and contract criterion: what you checked, what you found, your verdict. Include anything you considered a possible issue then decided was acceptable, with the reasoning. This log drives calibration.
```

## Presented verdict

Verdict as a single word at the top.

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
{finding blocks}

### What I verified
- {server starts and returns 200}
- {screenshot checks}
- {axe accessibility violations: {N}}
- {mobile emulation at 375px: {result}}

### Testing checklist
1. [ ] {specific interaction} — {what should happen}
...

### Areas I'm less confident about
- {anything unverified}

### Next steps
{concrete command based on verdict}
```

**If FAIL or PARTIAL:**
> Run `/nuxt-frontend-design {JOB_ID}` to fix. It detects the FAIL verdict and enters repair mode automatically. Then re-run `/nuxt-frontend-review {JOB_ID}` to verify.

**If PASS:**
> All criteria met. Ready to ship, or run `/nuxt-frontend-design polish` to refine further.

Design-system-level issues get called out separately: "The contrast issues are design system tokens, not page code. Run `/nuxt-frontend-design {JOB_ID}` and it will fix tokens in `main.css`/`app.config.ts` before page code."

## Checklist rules

- Specific: "Click 'Save' with an empty form", not "test the form".
- Every item states the expected result.
- Happy path first, then edge cases.
- Include dark mode if anything visual changed, mobile if layout was touched.
- One item per contract criterion plus the risky edge cases.
- List each affected route URL.
