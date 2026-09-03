# Build Workflow: Jobs, Contract, Dev Server, Handoff

Applies to Phase 2 and Phase 3. Phase 1 needs none of it (design system artifacts are shared, not job-scoped).

## Job ID

Every Phase 2 or Phase 3 invocation gets a unique job ID so parallel design jobs don't collide.

```bash
JOB_ID="$(echo "$ARGUMENTS" | tr ' ' '-' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]//g' | cut -c1-20)-$(date +%m%d-%H%M)"
mkdir -p ".claude/context/jobs/$JOB_ID"
```

Produces `landing-page-0331-1423`, `dashboard-0331-1445`. Tell the user immediately: "Job ID: `{JOB_ID}`".

Repair passes reuse the existing job ID rather than generating a new one, when `$ARGUMENTS` names a job directory that exists and PRIOR_REVIEW is FAIL.

Job artifacts live in `.claude/context/jobs/{JOB_ID}/`: `build-contract.md`, `build-progress.md`, `build-handoff.json`. Design system artifacts live at the project root: `DESIGN.md` (human and machine-readable, compatible with the `@google/design.md` linter).

Use `JOB_DIR=.claude/context/jobs/{JOB_ID}` throughout.

## Acceptance Criteria Contract

Emit the contract before writing component code. For multi-page or ambiguous requests, present it and wait for approval; the user often adds criteria or trims scope. For unambiguous single-page requests with explicit requirements, emit it as documentation and proceed.

Write `{JOB_DIR}/build-contract.md` (after `mkdir -p`):

1. **What will be built**: every component, page, and interaction.
2. **Testable behaviors**: stable IDs (C1, C2, …), format `[C1] GIVEN {state}, WHEN {action}, THEN {observable result}`. Each criterion verifiable by a single browser action or grep. Rewrite any criterion needing subjective judgment.

   Minimums per page, scaled down for pages that genuinely lack a category (a static content page has no submit assertions). Never invent filler criteria to hit a count.
   - 5 interaction assertions (clicks, submits, toggles, navigation, hover)
   - 3 state assertions (loading, empty, error as separate items)
   - 2 responsive assertions (specific behavior at 375px and 768px)
   - 1 dark mode assertion
   - 1 accessibility assertion (tab order, aria labels, or screen reader)
   - 1 SSR assertion (HTML contains expected content pre-hydration)
3. **Design expectations**: which theme tokens apply, expected visual weight, layout structure, and the design principle from `DESIGN.md` with how this page expresses it.
4. **Out of scope**.

This file becomes review's grading rubric. Skip it only for single-file cosmetic changes.

## Dev Server Setup

Run once at the start of Phase 2 or Phase 3, before smoke tests or checkpoints. Skip if `$DEV_PID` is already set in this shell.

```bash
# 1. Allocate a free random port (retry up to 3 times)
for i in 1 2 3; do
  DEV_PORT=$(shuf -i 10000-65535 -n 1)
  ss -tln 2>/dev/null | grep -q ":$DEV_PORT " || break
  DEV_PORT=""
done
[ -z "$DEV_PORT" ] && { echo "Could not find free port"; exit 1; }

# 2. Start the matching dev command
DEV_LOG="{JOB_DIR}/dev-server.log"
mkdir -p "$(dirname "$DEV_LOG")"
if [ -d playground ]; then
  ( pnpm dev:prepare && pnpm --filter '*-playground' dev --port $DEV_PORT ) > "$DEV_LOG" 2>&1 &
elif [ -f nuxt.config.ts ] || [ -f vite.config.ts ]; then
  pnpm dev --port $DEV_PORT > "$DEV_LOG" 2>&1 &
fi
DEV_PID=$!
trap "kill $DEV_PID 2>/dev/null" EXIT
echo "Dev server PID=$DEV_PID PORT=$DEV_PORT LOG=$DEV_LOG"

# 3. Wait for ready
timeout 90 bash -c "until curl -sf http://localhost:$DEV_PORT/ > /dev/null 2>&1; do sleep 2; done" \
  || { echo "Dev server failed to start"; tail -100 "$DEV_LOG"; exit 1; }
```

Record `$DEV_PORT` as `dev_port` in the handoff.

After any non-trivial change, scan the log. Target Nuxt/Vite markers rather than plain `error`/`warn` substrings:

```bash
grep -nE '^\s*(\[error\]|\[warn\]|ERROR|WARN|✖|✘|Hydration |Cannot find|Failed to (resolve|compile))' "$DEV_LOG" \
  || echo "dev server log clean"
```

Matches get fixed before the build continues.

## Long Task Protocol

For builds spanning multiple pages or phases:

1. **Checkpoint after each page**: write `{JOB_DIR}/build-progress.md` before starting the next page, using `## {Page Name}` headings (the injected `PAGES_BUILT` counts these). List files created/modified, criteria satisfied by ID, and criteria remaining. Write the checkpoint before opening the next page file.
2. **Route smoke test**: curl the affected route on `$DEV_PORT`, then run the error-scan grep. On failure, read `$DEV_LOG` and fix. Full browser verification belongs to review.
3. **Intermediate review**: after page 1 of a multi-page build, suggest running `/nuxt-frontend-review {JOB_ID}` before page 2. Systemic issues (wrong tokens, broken shared components) are cheaper to catch before they propagate.
4. **Cross-page consistency**: before page N+1, re-read page N's files. Same number of states handled, same interaction detail, same token use? Page N+1 scope feeling smaller than page N is context degradation. Stop and emit the handoff.
5. **Scope gate**: if the cross-page consistency check shows page N+1 thinner than page N, emit the handoff and tell the user: "Start a new conversation and run `/nuxt-frontend-design {next page}` to continue."
6. **No silent scope reduction**: contract criteria you cannot confirm get flagged explicitly in `build-progress.md` and the handoff.

## Handoff

Capture git state and write `{JOB_DIR}/build-handoff.json`. `dev_port` is recorded for debugging only; review starts its own server on a fresh port.

```json
{
  "schema_version": 4,
  "job_id": "{JOB_ID}",
  "created": "<ISO 8601 from `date -u +%Y-%m-%dT%H:%M:%SZ`>",
  "git_hash": "<HEAD from `git rev-parse HEAD`>",
  "dev_port": 47213,
  "pages_changed": ["app/pages/index.vue"],
  "components_created": ["app/components/StatsCard.vue"],
  "routes_to_test": ["/", "/dashboard"],
  "design_system_changes": false,
  "theme_name": "frost",
  "contract_path": "{JOB_DIR}/build-contract.md",
  "contract_criteria_status": { "C1": "met", "C2": "met", "C3": "partial" },
  "self_assessment": {
    "confidence": "medium",
    "weakest_area": "Mobile nav transition feels abrupt",
    "hardest_decision": "Used ghost buttons on sidebar; solid felt too heavy"
  },
  "has_client_animations": true,
  "known_limitations": ["Chart uses placeholder data"],
  "next_steps": ["Add real chart data integration"],
  "dark_mode_relevant": true
}
```

**Self-assessment honesty**: confidence cannot exceed what the weakest area justifies. A `weakest_area` describing a hard rejection criterion (broken feature, missing state, layout break) means confidence is "low".

Then summarize: "Wrote build contract (N criteria), handoff (confidence: X, weakest: Y), and progress tracker to `.claude/context/jobs/{JOB_ID}/`." And point at the review:

```
/nuxt-frontend-review {JOB_ID}
```

Skip review only when all of these hold: single file changed, purely cosmetic (colors, spacing, copy), no new components/routes/interactions, no structural layout change. Even then, verify the dev server runs and curl the affected route.
