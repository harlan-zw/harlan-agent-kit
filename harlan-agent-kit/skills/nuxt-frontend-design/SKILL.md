---
name: nuxt-frontend-design
description: 'Build frontend with Nuxt UI v4+. Trigger on "build page", "landing page", "dashboard", "setup design tokens", "polish", "refine", "add motion", "fix UX", "looks generic". Full lifecycle: design system setup, page building, polish.'
user_invocable: true
argument-hint: "[component/page/area]"
model: opus
effort: max
---

# Nuxt Frontend Design

Full lifecycle frontend skill: setup, build, polish. Detects the right phase automatically.

## Craft Principles

These justify the pedantry in the rest of the skill. Hold them while working; cite them when the user questions a rule.

- **Taste is trained, not innate.** Good defaults come from reverse-engineering interfaces that feel right, not from invention. Before building a pattern, recall the best version of it you have seen and borrow the invariants (timing, origin, easing, rhythm). Generic output is a sign you skipped this step.
- **Unseen details compound.** No single user consciously notices that a popover scales from its trigger, that a tooltip skips its delay on the second hover, or that a button releases faster than it presses. In aggregate these decisions are the difference between "feels designed" and "feels assembled". Most of this skill's rules exist for this reason.
- **Beauty is leverage.** In a world where every product works, the one that feels best wins the user. Polish is not decoration — it is the only thing still up for grabs when the feature set is commoditised.

## Project State

!`if [ -f nuxt.config.ts ]; then echo "IS_NUXT=true"; else echo "IS_NUXT=false"; fi`
!`bash -c 'F=""; if [ -f app.config.ts ]; then F="app.config.ts"; fi; if [ -f app/app.config.ts ]; then F="app/app.config.ts"; fi; if [ -n "$F" ] && grep -q "colors:" "$F" 2>/dev/null; then echo "HAS_COLORS=true"; else echo "HAS_COLORS=false"; fi'`
!`bash -c 'for f in app/assets/css/main.css app/css/main.css app/css/global.css app/assets/css/global.css; do if [ -f "$f" ] && grep -q "@theme" "$f" 2>/dev/null; then echo "HAS_THEME=true"; exit 0; fi; done; echo "HAS_THEME=false"'`
!`if [ -f DESIGN.md ]; then echo "HAS_GUIDELINES=true"; else echo "HAS_GUIDELINES=false"; fi`
!`bash -c 'OUT=$(ls -t .claude/context/jobs/ 2>/dev/null | head -10); if [ -n "$OUT" ]; then echo "$OUT"; else echo "NO_JOBS"; fi'`
!`bash -c 'JOB=$(ls -t .claude/context/jobs/ 2>/dev/null | head -1); if [ -n "$JOB" ]; then echo "LATEST_JOB=$JOB"; if [ -f ".claude/context/jobs/$JOB/build-handoff.json" ]; then echo "PRIOR_BUILD=true"; jq -r "\"PRIOR_BUILD_DATE=\" + (.created // \"unknown\")" ".claude/context/jobs/$JOB/build-handoff.json" 2>/dev/null; else echo "PRIOR_BUILD=false"; fi; else echo "PRIOR_BUILD=false"; fi'`
!`bash -c 'JOB=$(ls -t .claude/context/jobs/ 2>/dev/null | head -1); if [ -n "$JOB" ] && [ -f ".claude/context/jobs/$JOB/review-report.md" ]; then echo "PRIOR_REVIEW=true"; grep -m1 "^verdict:" ".claude/context/jobs/$JOB/review-report.md" 2>/dev/null; else echo "PRIOR_REVIEW=false"; fi'`
!`bash -c 'JOB=$(ls -t .claude/context/jobs/ 2>/dev/null | head -1); if [ -n "$JOB" ] && [ -f ".claude/context/jobs/$JOB/build-progress.md" ]; then printf "PAGES_BUILT="; grep -c "^## " ".claude/context/jobs/$JOB/build-progress.md" 2>/dev/null; else echo "PAGES_BUILT=0"; fi'`
!`if command -v dev-browser >/dev/null 2>&1; then echo "DEV_BROWSER=true"; else echo "DEV_BROWSER=false"; fi`
!`bash -c 'OUT=$(find app/pages -name "*.vue" 2>/dev/null | head -10); if [ -n "$OUT" ]; then echo "$OUT"; else echo "NO_PAGES"; fi'`
!`bash -c 'OUT=$(ls "${CLAUDE_SKILL_DIR}/references/themes/" 2>/dev/null | sed "s/.md$//"); if [ -n "$OUT" ]; then echo "$OUT"; else echo "NO_THEMES"; fi'`
!`bash -c 'F=""; if [ -f app.config.ts ]; then F="app.config.ts"; fi; if [ -f app/app.config.ts ]; then F="app/app.config.ts"; fi; if [ -n "$F" ] && grep -q "colors:" "$F" 2>/dev/null; then N=$(grep -E "neutral:" "$F" 2>/dev/null | head -1 | sed "s/.*neutral:[[:space:]]*['"'"'\"]//" | sed "s/['"'"'\"].*//" ); if [ -n "$N" ]; then echo "$N"; else echo "NO_NEUTRAL"; fi; else echo "NO_NEUTRAL"; fi'`

## Phase Detection

`$ARGUMENTS` = the text the user provided after the skill invocation, e.g. `/nuxt-frontend-design frost landing page` → `$ARGUMENTS` = "frost landing page"

**Guard**: If IS_NUXT=false, tell the user this skill requires a Nuxt project (`nuxt.config.ts`) and stop.

Using the injected project state above, determine the phase. Parse `$ARGUMENTS` for BOTH a theme name AND an action (build/polish/page name). A single invocation like `/nuxt-frontend-design frost landing page` means: ensure frost theme (Phase 1 if needed), then build landing page (Phase 2).

```
Check: HAS_COLORS=true AND HAS_THEME=true AND HAS_GUIDELINES=true? -> if all false or mixed: Phase 1 (Setup)
  Mixed state (one true, others false) means CORRUPTED setup -> Phase 1 (repair)
Check: $ARGUMENTS names a specific theme AND design system is incomplete or uses a different theme?
  -> Phase 1 with that theme. If design system already uses that theme, skip to next check.
Check: PRIOR_REVIEW=true with FAIL verdict?
  -> Read the FULL `{JOB_DIR}/review-report.md` (not just the verdict line). For each [HARD REJECT] and [RUBRIC] item, fix the issue at the referenced file:line. After fixing all items, re-emit the handoff with updated contract_criteria_status.
Check: $ARGUMENTS asks to build new pages?                         -> Phase 2 (Build)
Check: $ARGUMENTS asks to refine/polish?                           -> Phase 3 (Polish)
Check: existing pages need improvement?                            -> Phase 3 (Polish)
Default (no arguments, design system exists):                      -> Phase 3 (audit existing pages)
```

**Hard prerequisite:** Phase 2 requires a complete design system (all three: HAS_COLORS, HAS_THEME, HAS_GUIDELINES). If any is missing, run Phase 1 first. Tell the user: "Design system incomplete. Setting it up first."

**Cross-phase rule:** If Phase 1 was completed in THIS conversation, do not proceed to Phase 2 in the same conversation. Emit the handoff and tell the user: "Design system ready. Start a new conversation and run `/nuxt-frontend-design {page}` to build with fresh context."

## Job ID

Every Phase 2 or Phase 3 invocation gets a unique job ID. This namespaces all build artifacts so parallel design jobs don't collide.

**Generate the job ID:**
```bash
JOB_ID="$(echo "$ARGUMENTS" | tr ' ' '-' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]//g' | cut -c1-20)-$(date +%m%d-%H%M)"
mkdir -p ".claude/context/jobs/$JOB_ID"
```

This produces IDs like `landing-page-0331-1423` or `dashboard-0331-1445`. Tell the user the job ID immediately: "Job ID: `{JOB_ID}`"

**Repair pass**: if PRIOR_REVIEW has a FAIL verdict and `$ARGUMENTS` contains a job ID matching an existing job directory, reuse that job ID instead of generating a new one. Read the review report from that job's directory.

**Phase 1 only**: no job ID needed (design system artifacts are shared, not job-scoped).

All job-specific artifacts go to `.claude/context/jobs/{JOB_ID}/`:
- `build-contract.md`
- `build-progress.md`
- `build-handoff.json`

Design system artifacts live at the project root:
- `DESIGN.md` (human + machine-readable source of truth; compatible with `@google/design.md` linter)

Use `JOB_DIR=.claude/context/jobs/{JOB_ID}` throughout.

---

## Pre-Implementation: Define Acceptance Criteria

Before writing any code in Phase 2 or Phase 3, your FIRST response must be the contract. Do not open any `.vue` files or write any component code until the user approves.

Run `mkdir -p {JOB_DIR}` then emit to `{JOB_DIR}/build-contract.md`:

1. **What will be built**: list every component, page, and interaction
2. **Testable behaviors**: assign each criterion a stable ID (C1, C2, ...). Use this format:
   `[C1] GIVEN [state/context], WHEN [user action], THEN [observable result]`
   Each criterion must be verifiable by a single browser action or grep. Rewrite any criterion that requires subjective judgment.
   Minimums per page:
   - 5 interaction assertions (clicks, submits, toggles, navigation, hover states)
   - 3 state assertions (loading, empty, error as separate items)
   - 2 responsive assertions (specific behavior at 375px AND 768px)
   - 1 dark mode assertion
   - 1 accessibility assertion (tab order, aria labels, or screen reader)
   - 1 SSR assertion (HTML contains expected content before hydration)
3. **Design expectations**: which theme tokens apply, expected visual weight, layout structure. Include the design principle from the guidelines and note how the page should express it.
4. **Out of scope**: what this does NOT include

**Show the contract to the user and get approval before building.** The user may add criteria, adjust scope, or flag missing requirements. For unambiguous requests (single page, explicit requirements), emit the contract as documentation but proceed immediately.

This file becomes the review skill's grading rubric. Skip this step only for single-file cosmetic changes.

---

## Content & Asset Rules

Apply across Phase 2 and Phase 3. Review skill treats violations as hard rejects.

### Every Element Earns Its Place

One thousand no's for every yes. Do not pad designs with placeholder sections, dummy stats, filler copy, or decorative content to fill space. If a section feels empty, solve it with layout, composition, or scale, not invented content.

**Ask before adding material.** If you think another section, page, stat block, or copy block would strengthen the design, ask the user first. Do not unilaterally add content the contract did not name.

Watch specifically for "data slop": rows of stat counters, icon grids, logo bars, testimonial strips, feature bullets added reflexively rather than because the content demanded it.

### AI Slop Ban List

Hard rejections unless the user explicitly asked for them:

- Aggressive gradient backgrounds (purple/blue hero gradients, full-page meshes)
- Cards with a coloured left-border accent stripe
- Illustrations drawn inline with SVG shapes (use a real asset or a labelled placeholder)
- Emoji in UI copy unless the brand system registers emoji as a token
- Generic stat blocks ("10M+ users, 99.9% uptime, 24/7 support")
- Overused sans stacks: Inter, Roboto, Open Sans, Lato, Montserrat, Arial, any bare `system-ui` / `sans-serif` fallback as the only font
- SaaS-landing cliché serifs (Fraunces, Playfair, DM Serif) used *without commitment* — i.e. paired with a generic sans for body copy as decoration only. If the theme genuinely commits to an editorial / paper-craft / literary aesthetic (e.g. kinetic-paper, flow), an editorial serif is correct. The ban targets "add a serif heading for personality" tokenism, not earnest type systems.

### Placeholder Over Fake

A labelled placeholder always beats a bad attempt at the real thing.

- Missing hero image: a neutral block with `600×400 hero image` text, not a hand-drawn SVG mountain
- Missing avatars: `https://api.dicebear.com/9.x/initials/svg?seed={name}` or `https://ui-avatars.com/api/?name={name}`
- Missing product screenshots: solid block sized to the real aspect ratio with a short label
- Missing logos: `https://logo.clearbit.com/{domain}` when the brand is real, otherwise a labelled box

Never leave broken `<img>` tags or unstyled fallback boxes. Placeholders must look intentional.

**Scope**: placeholders are for internal tools, dashboards, and prototypes. Landing/marketing pages should prefer real product demos, screenshots, and named logos per [pages/landing.md](references/pages/landing.md) "Show, Don't Tell" — a labelled grey box on a hero kills the sale. Fall back to placeholders only when real assets genuinely don't exist yet.

### Minimum Scales

Surface these in the build contract as testable criteria.

- Body copy ≥ 16px; never below 14px
- Mobile tap targets ≥ 44×44px (buttons, links, icon triggers, form controls)
- Form input height ≥ 40px on desktop, ≥ 44px on mobile
- Contrast: WCAG AA for all text against its background

---

## Phase 1: Design System Setup

Establish the visual foundation. Only needed when no design system exists or a new theme is requested.

### Design Philosophy

Commit to a specific aesthetic direction that serves the content before coding. During Phase 1, define a single design principle as a tradeoff statement: "We prioritize X over Y" (e.g., "We prioritize readability over visual impact" or "We prioritize tactile depth over minimalism"). Record this in the design guidelines.

### What to set up

1. **Color palette**: primary, neutral, accent via `app.config.ts`
2. **Typography**: font selection, registration via Nuxt Fonts, `--font-*` in `@theme`
3. **Icon system**: icon collection matching the aesthetic via `@nuxt/icon`
4. **Semantic overrides**: `--ui-bg`, `--ui-text`, `--ui-radius`, etc. for light/dark
5. **Component theming**: global overrides via `app.config.ts` slots/variants
6. **Extended colors**: registering custom theme colors in `nuxt.config.ts`

**Principle: Override, Don't Invent.** Always use Nuxt UI's existing design tokens (`bg-muted`, `text-default`, `--ui-bg`, `--ui-radius`, etc.) and Tailwind's built-in utilities (`shadow-md`, `rounded-xl`). Customize by **overriding** these tokens in `app.config.ts` and `main.css`, not by creating generic duplicates. If you find yourself naming a new token, first check whether an existing `--ui-*` variable or Tailwind utility already serves that purpose.

**Theme signature tokens are the exception**: when a theme's voice depends on a distinctive effect Tailwind can't express (e.g. `--shadow-brutal`, `--shadow-clay`, `--shadow-paper`, `--shadow-glass`, mesh/glow variables), define it. The ban targets *generic* duplicates (`--shadow-soft`, `--radius-card`), not theme-specific voice.

### References

- [design-system.md](references/design-system.md): Full setup guide (colors, fonts, tokens, component theming)
- [themes/{name}.md](references/themes/): Complete theme implementation files

Available themes: frost, clay, blueprint, nebula, zen, neon, teenage-engineering, kinetic-paper, flow, devtool. See `references/themes/` for the full list (injected above).

### Theme Selection

Read EXACTLY ONE theme file: `${CLAUDE_SKILL_DIR}/references/themes/{chosen-theme}.md`. Never read multiple theme files for comparison. If the user didn't specify a theme, default to `frost` for dark mode projects, `zen` for light mode. Only ask if the choice is genuinely ambiguous.

### After Setup: Emit DESIGN.md

**Always** emit `DESIGN.md` at the project root after writing `app.config.ts`, `main.css`, and `nuxt.config.ts`:

1. **Collision guard**: if `DESIGN.md` already exists at root, ask the user before overwriting. Offer to merge (preserve existing `## Design Decisions` section) or abort.
2. Read the template: [templates/DESIGN.md](templates/DESIGN.md)
3. **YAML front matter**: the chosen theme file already has a DESIGN.md-compatible YAML block at the top. Copy that block as the starting point, then apply any user-specific customisations (brand name, swapped primary hex, additional registered colours, extra component surfaces). Prefer token refs (`{colors.primary}`, `{rounded.md}`) over restating hex/px values so the file has one source of truth.
4. **Prose sections**: fill every section below the front matter based on the decisions you just made, **no placeholders**.
5. Write to `DESIGN.md` at the project root.
6. **Verify placeholders removed**: `grep -cE '\{\{|TODO|placeholder' DESIGN.md` must return 0. (Matches `{{...}}` placeholders only; single-brace `{colors.primary}` token refs are legitimate and must remain.)
7. **Verify tokens lint**: `npx --yes @google/design.md lint DESIGN.md 2>/dev/null | jq -r '.summary.errors'` should return `0`. If the linter crashes (`raw.match is not a function`) because a component prop holds a float or `rgba()`, quote floats and convert `rgba()` to 8-digit hex in component properties. Contrast warnings on button-primary are informational at this stage; if the theme's signature colour intentionally trades 4.5:1 for aesthetic, document the exception under `## Design Decisions`.

If modifying an existing design system, **update** `DESIGN.md` in place.

### Setup Recovery

If Phase 1 fails mid-setup (build error, malformed config):
1. Do NOT continue to Phase 2
2. Read the error output and fix the config issue
3. Verify all three indicators pass: `colors:` in app.config.ts, `@theme` in main.css, `DESIGN.md` exists with no placeholders
4. Never emit a `DESIGN.md` with unfilled template sections

### Setup Gotchas

- **Font selection**: avoid the top 5 most common web fonts (Inter, Roboto, Open Sans, Lato, Montserrat) and system-ui. Choose fonts that reinforce the design principle.
- **Button visibility**: Primary CTAs MUST have visible backgrounds. Set `colors.primary` + `button.defaultVariants.variant: 'solid'` in `app.config.ts`. Secondary actions (icon triggers, overflow menus, table row actions) can use `ghost` or `outline` — see [components/feedback.md](references/components/feedback.md) for patterns.
- **No fake UI**: If it looks interactive, wire it up. Prefer realistic placeholder content (avatar services like ui-avatars.com) over empty or broken images.

---

## Dev Server Setup (Phase 2 & Phase 3)

Run this **once** at the start of Phase 2 or Phase 3, before any smoke tests, polish verification, or Long Task Protocol checkpoints. Skip if `$DEV_PID` is already set in the current shell session.

Allocate a random 5-digit port (with retry on collision), start the dev server in the background, log to a file, and register a cleanup trap so the process is killed even on early exit.

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

Use `$DEV_PORT` and `$DEV_LOG` throughout. Record `$DEV_PORT` as `dev_port` in the handoff.

**Error/warning scan** — after any non-trivial change, scan `$DEV_LOG` for build/runtime issues. Target Nuxt/Vite log markers (avoid grepping plain `error`/`warn` substrings to reduce false positives):

```bash
grep -nE '^\s*(\[error\]|\[warn\]|ERROR|WARN|✖|✘|Hydration |Cannot find|Failed to (resolve|compile))' "$DEV_LOG" \
  || echo "dev server log clean"
```

If anything matches, fix the underlying issue before continuing the build.

---

## Phase 2: Build Pages

Compose pages and UI patterns with Nuxt UI v4+ components. **Requires a design system** (run Phase 1 first if none exists).

Run **Dev Server Setup** above before the first smoke test.

### Artifact Cleanup

Stale artifact cleanup is no longer needed. Each job gets its own directory under `.claude/context/jobs/{JOB_ID}/`, so previous jobs' artifacts cannot collide.

### Build Recovery

If `{JOB_DIR}/build-progress.md` exists but `{JOB_DIR}/build-handoff.json` does not, a previous build was interrupted. Read `build-progress.md` to determine which pages completed and which contract criteria remain. Resume from the last incomplete page rather than starting over. **Re-run Dev Server Setup** since the previous server process is gone.

### Read the Foundation

Read these files if not already in context from Phase 1:

```
DESIGN.md                             -> aesthetic intent, component rules, avoid list, custom utilities
app/assets/css/main.css               -> @theme tokens, --ui-* overrides, custom classes
app.config.ts                         -> colors, component theme overrides, defaultVariants
nuxt.config.ts                        -> fonts, colorMode, ui.theme.colors
```

Use the project's semantic tokens, fonts, and component overrides. Never hardcode colors, shadows, or radii that bypass the design system. When you need a design variation, override an existing Nuxt UI token rather than introducing a new custom token.

### References

Load ONLY the reference matching what you're building. Do not load more than one reference file before writing code. Load additional references only after the first page is written and you need a new component type.

| Building... | Reference |
|-------------|-----------|
| Landing / marketing page | [pages/landing.md](references/pages/landing.md) |
| Dashboard / admin | [pages/dashboard.md](references/pages/dashboard.md) |
| Forms | [components/forms.md](references/components/forms.md) |
| Data tables | [components/tables.md](references/components/tables.md) |
| Navigation | [components/navigation.md](references/components/navigation.md) |
| Feedback / overlays | [components/feedback.md](references/components/feedback.md) |
| Stat cards, sparklines, empty states, typed toasts | [library.md](references/library.md) |

**Before building stat cards, sparklines, or empty states from scratch**, check [references/library.md](references/library.md) — it ships copy-paste primitives (`UiStat`, `UiStats`, `UiSparkline`, `UiTrend`, `UiNoData`, `UiSkeleton`, `useAppToast`) already sanitized for drop-in use in any Nuxt UI v4 project.

### When The User Asks For Variations

If the contract asks for 2+ options of the same page/component, vary across concrete dimensions rather than producing near-duplicates. Pick at least three of:

- **Scale**: hero type at 48px vs 96px vs 144px
- **Fill vs outline**: solid surfaces vs bordered/ghost treatments
- **Layout structure**: stacked vs split vs asymmetric grid
- **Visual rhythm**: uniform cards vs feature + supporting mix
- **Type treatment**: display serif vs utility sans, tight vs wide tracking
- **Texture and layering**: flat vs shadowed vs offset/overlapping
- **Density**: airy (large padding, few elements per row) vs compact

Start the first variation by-the-book (matches existing patterns), then escalate: each successive variation should push further on one or two axes. Do not ship three variations that only differ in accent colour — that is the same design three times.

Expose variation via route (`/pages/index-a.vue`, `/pages/index-b.vue`) or a `?variant=` query param with `v-if` blocks, so the user can A/B them in one tab.

### Build Gotchas

Framework-specific traps that won't be obvious from grep:

- **v4 component renames**: `ButtonGroup` -> `UFieldGroup`, `PageMarquee` -> `UMarquee`. Old names silently render nothing.
- **`UPageHero` needs a parent section**: wrap in `UPageSection` or a max-width container.
- **Form validation timing**: `UForm` with Zod validates on blur by default. Set `validate-on="input"` for inline.
- **`UTable` empty state**: without an explicit `empty` slot, an empty table shows nothing.
- **SSR boundary**: wrap client-only animations in `ClientOnly`, not entire page sections.
- **Component locality, promote on evidence**: a new `app/components/Foo.vue` is a claim of app-wide ownership (global auto-import, rename blast radius, naming-collision risk). Default to colocating as `_Foo.vue` next to the page that uses it; the `_` prefix opts out of auto-import. Promote to `app/components/` only when ≥2 unrelated features consume it. Review hard-rejects single-caller globals.

Review's hard rejection list (missing error states, invisible content, dark mode breaks, hardcoded colors, layout breaks) is the authoritative rubric; see `/nuxt-frontend-review`. The Content & Asset Rules section above covers filler/AI slop/placeholders/minimum scales.

---

## Phase 3: Polish

Refine existing interfaces. Audit against the project's own design system, not generic best practices.

If `$ARGUMENTS` names a specific area (typography, motion, color, etc.), skip to that area's reference.

### Read the Foundation

Read the foundation files listed in Phase 2's "Read the Foundation" section (if not already in context from Phase 1).

### Audit Foundation Tokens

Check that the design system is complete. Missing tokens cause inconsistency downstream.

| Token category | Where defined | What to check |
|----------------|---------------|---------------|
| Colors | `app.config.ts` `colors` | `primary` and `neutral` set? Additional theme colors registered? |
| Fonts | `@theme` `--font-*` | At least `--font-sans` defined? Display/mono if used? |
| Semantic overrides | `:root` / `.dark` `--ui-*` | `--ui-bg`, `--ui-text`, `--ui-border` customized? |
| Component overrides | `app.config.ts` `ui.*` | Key components themed? `defaultVariants` set? |
| Unnecessary tokens | `@theme` | Custom tokens that duplicate Tailwind builtins or Nuxt UI `--ui-*` variables? Remove them and use the existing token instead. New tokens should only exist when no Nuxt UI or Tailwind equivalent covers the concept. |

**If tokens are missing**: fix them first.

### Observe Before Changing

Polish modifies an existing voice. Before touching anything, read 2-3 key `.vue` files and note out loud what the current interface is saying: copy tone, shadow/card treatment, density, hover and focus states, animation style, rhythm between sections. The goal is to match and elevate that vocabulary, not replace it. If you cannot describe the existing voice in one sentence, you are not ready to polish.

### Audit Consistency

Scan `.vue` files for violations using review's mechanical checks as the authoritative list (hardcoded hex/rgb, `slate-`/`gray-`/`zinc-`/`stone-` except the configured neutral, `bg-white`/`text-black`, banned font families, custom `@theme` tokens that duplicate `--ui-*`). See `harlan-agent-kit:nuxt-frontend-review` Step 3 "Evaluation rubric: mechanical checks". Any violation found here must be fixed before handoff — review will re-grade the same patterns and reject on hits.

**Lead with the class-token inventory** — it's the most leveraged audit signal and the same command review runs:

```bash
npx -y @ripast/cli css-class-scan --glob 'app/**' --sort count-desc --json
```

Read the output and look for:
- **Synonym clusters** — `bg-gray-100` + `bg-slate-100` + `bg-zinc-100` all collapsing to a single semantic role (`bg-muted`). Each cluster is a conformity fix.
- **One-off tokens** (count = 1) — usually a hand-tuned value that should map to a design token.
- **Low-count token spellings near a high-count one** — drift from the canonical class.

When a token map is obvious, apply it with `ripast css-class-rename --map tokens.json --apply` (dry-run first) rather than hand-editing each call site.

Beyond the mechanical list, also watch for: inconsistent shadow/radius choices across similar components (pick one per component type via `app.config.ts`), inline `style=` attributes, raw HTML where a Nuxt UI component exists, and any rule documented in `DESIGN.md` the implementation contradicts.

### Audit Confirmation

After completing the token and consistency audits, present findings to the user before making any changes. Format as a numbered list with categories:

```
**Audit findings:**

Token issues (will fix):
1. Hardcoded `bg-slate-100` in HeroSection.vue:42 → should use `bg-muted`
2. ...

Aesthetic observations (need your input):
3. Hero text feels small for a landing page → increase size? [intentional / fix]
4. Cards all use identical treatment → add hierarchy? [intentional / fix]
5. ...
```

**Rules:**
- **Token/consistency violations** (hardcoded colors, wrong fonts, broken dark mode): present as "will fix" since these are objectively wrong per the design system
- **Aesthetic judgments** (sizing, hierarchy, rhythm, visual weight): present as observations requiring user input. Never assume these are problems.
- **Already decided**: before presenting, read `## Design Decisions` in `DESIGN.md`. Any observation already covered by an existing decision is settled. Do not re-ask. Only present NEW aesthetic observations the user hasn't ruled on yet. If all aesthetic observations are already covered, skip straight to fixing token issues and then Elevate.
- Wait for user response before proceeding. The user will mark each aesthetic item as "intentional" or "fix".

**After confirmation**, update `DESIGN.md`:
1. Add new "intentional" choices to `## Design Decisions` (append, don't duplicate existing entries)
2. Remove any stale entries in `## Design Decisions` that the user just marked as "fix" (they've changed their mind)
3. If no `## Design Decisions` section exists yet, create it

Example:

```markdown
## Design Decisions
- Hero uses text-3xl intentionally: minimal aesthetic for utility tool
- Cards use uniform treatment: flat hierarchy is intentional
```

Only fix items the user approved. Skip everything marked "intentional".

### Elevate

Only after foundation and consistency are solid AND audit confirmation is complete. Read references based on symptoms:

| Symptom | Reference |
|---------|-----------|
| Feels flat/static | [polish/interactions.md](references/polish/interactions.md) |
| No entrance animations | [polish/motion.md](references/polish/motion.md) |
| Typography feels generic | [polish/typography.md](references/polish/typography.md) |
| Layout cramped or boring | [polish/spatial.md](references/polish/spatial.md) |
| Colors dull or inconsistent | [polish/color.md](references/polish/color.md) |
| Not responsive enough | [polish/responsive.md](references/polish/responsive.md) |
| Copy unclear or generic | [polish/ux-writing.md](references/polish/ux-writing.md) |
| Reaching for JS/custom tokens for native CSS work | [polish/css-toolkit.md](references/polish/css-toolkit.md) |

When asked to "make it better" or "polish everything":
1. Read `interactions.md` + `motion.md` + `color.md` (highest impact areas)
2. Only read `spatial.md`, `typography.md`, `responsive.md`, `ux-writing.md` if the initial audit reveals issues in those areas
3. Consult `css-toolkit.md` whenever you find yourself about to invent a new token, add a JS scroll observer, or hand-code a popover — the native CSS equivalent is usually one line

### Verify the Route Still Loads

Ensure **Dev Server Setup** has run (allocates `$DEV_PORT` / `$DEV_LOG`). Then:

```bash
curl -sf "http://localhost:$DEV_PORT/{route}" > /dev/null && echo OK || echo FAIL
grep -nE '^\s*(\[error\]|\[warn\]|ERROR|WARN|✖|✘|Hydration |Cannot find|Failed to (resolve|compile))' "$DEV_LOG" \
  || echo "dev server log clean"
```

That is all the self-verification needed at this stage. Full visual + interaction verification is the review skill's job — don't duplicate it here. When handing off, tell the user to run `/nuxt-frontend-review {JOB_ID}`.

### Polish Rules

- **Keep what works**: don't change what's already distinctive
- **"Same product, elevated execution"**: not "This is different"
- **No wholesale replacement** when refinement would work
- **No scope creep**: polish what's there, don't add features
- **Over-polishing kills distinctiveness**: pick 1-2 areas to elevate, leave the rest

### Polish Gotchas

- **Motion-v SSR hydration**: use `ClientOnly` wrapper or `onMounted` for entrance animations
- **OKLCH browser support**: provide fallback via `@supports` for older Safari
- **Font loading flash**: register fonts via Nuxt Fonts, not CSS `@import`
- **Container queries**: need `container-type: inline-size` on the parent
- **Don't refactor while polishing**: polish is visual refinement, not code cleanup

### After Polish: Emit Handoff

After completing Phase 3 changes, follow the same "After Implementation: Emit Handoff" steps below. The review step applies to polish work too, not just new page builds. Skip only for trivially verifiable changes (single file, purely cosmetic token swaps with no new components, routes, or interactions).

---

## Reka UI

For components not covered by Nuxt UI, or where Nuxt UI is too prescriptive, use [Reka UI](https://reka-ui.com/docs/overview/installation): unstyled, accessible Vue primitives you can style with Tailwind.

## Long Task Protocol

For builds spanning multiple pages or phases:

1. **Checkpoint after each page**: write `{JOB_DIR}/build-progress.md` BEFORE starting the next page. Use `## {Page Name}` as the heading for each entry (this format is counted by the injected `PAGES_BUILT`). List files created/modified, contract criteria satisfied (by ID), and criteria remaining. You cannot open a new page file until this is written.
2. **Route smoke test**: after writing the checkpoint, curl the affected route to confirm no build break. Use the `$DEV_PORT` allocated by **Dev Server Setup** (run that first if not already). `curl -sf "http://localhost:$DEV_PORT/{route}" > /dev/null && echo OK || echo FAIL`. Then run the error-scan grep against `$DEV_LOG`. If FAIL, read `$DEV_LOG` and fix before proceeding. Full browser verification belongs to review; don't attempt qualitative self-assessment.
3. **Intermediate review**: after the first page in a multi-page build, suggest: "Page 1 complete. For best results, run `/nuxt-frontend-review {JOB_ID}` now before continuing to page 2." This catches systemic issues (wrong tokens, broken shared components) before they propagate.
4. **Cross-page consistency check**: before starting page N+1, re-read the files from page N. Confirm: same number of states handled, same level of interaction detail, same use of design tokens. If page N+1 scope feels smaller than page N, that is context degradation. Stop and emit the handoff.
5. **Scope gate**: the injected `PAGES_BUILT` count is your source of truth.
   - If PAGES_BUILT >= 2 and next page is complex (forms, tables, multi-step flows): STOP. Emit handoff.
   - If PAGES_BUILT >= 3: STOP unconditionally. Emit handoff.
   - Tell the user: "Start a new conversation and run `/nuxt-frontend-design {next page}` to continue."
6. **No silent scope reduction**: if you cannot confirm every contract criterion is met, flag incomplete items explicitly in `{JOB_DIR}/build-progress.md` and the handoff artifact.

## After Implementation: Emit Handoff

Before finishing, capture the current git state and write `{JOB_DIR}/build-handoff.json`. **`dev_port`**: record the random 5-digit port (`$DEV_PORT`) you allocated for this job. The review skill ignores it and starts its own server on a fresh random port; it is recorded only for debugging.

```json
{
  "schema_version": 4,
  "job_id": "{JOB_ID}",
  "created": "<ISO 8601 date from `date -u +%Y-%m-%dT%H:%M:%SZ`>",
  "git_hash": "<current HEAD hash from `git rev-parse HEAD`>",
  "dev_port": 47213,
  "pages_changed": ["app/pages/index.vue"],
  "components_created": ["app/components/StatsCard.vue"],
  "routes_to_test": ["/", "/dashboard"],
  "design_system_changes": false,
  "theme_name": "frost",
  "contract_path": "{JOB_DIR}/build-contract.md",
  "contract_criteria_status": {
    "C1": "met",
    "C2": "met",
    "C3": "partial"
  },
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

**Self-assessment honesty rule**: do not rate confidence higher than your weakest area justifies. If `weakest_area` describes something that would be a hard rejection criterion (broken feature, missing state, layout break), confidence must be "low".

After emitting the handoff, summarize what was written: "Wrote build contract (N criteria), handoff (confidence: X, weakest: Y), and progress tracker to `.claude/context/jobs/{JOB_ID}/`."

Then tell the user to run the review with the job ID:

```
/nuxt-frontend-review {JOB_ID}
```

**Skip the review for trivially verifiable changes** where ALL of these are true: single file changed, purely cosmetic (colors, spacing, copy), no new components/routes/interactions, no structural layout changes. For skipped reviews, still verify the dev server runs and curl the affected route.
