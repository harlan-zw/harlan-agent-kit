---
name: nuxt-frontend-design
description: "Build or polish Nuxt UI v4+ pages and design systems. Use for landing pages, dashboards, tokens, motion, or generic-looking UX."
user_invocable: true
argument-hint: "[component/page/area]"
model: opus
effort: max
---

# Nuxt Frontend Design

Full lifecycle frontend skill: setup, build, polish. Detects the right phase from project state.

## Worktree isolation

Before any edit, follow the [worktree isolation contract](../../references/worktree-isolation.md). It provides the atomic live-agent claim used below.

An existing worktree alone does not prove another agent is active.

`wt` is the only worktree tool. Never run `git worktree add`, and never use a harness worktree option such as `EnterWorktree` or `isolation: "worktree"`. Those write to `.claude/worktrees/`, which is banned. `wt` places every worktree at `<parent>/<repo>.<branch-slug>`.

Keep the primary checkout read only. Before mutation, run `wt list --format=json`. Reuse the task's worktree with `wt switch <branch>`, or create one with `wt switch --create <branch> --base origin/main`. Read its absolute `path` from the JSON, then pass that path as `workdir` to every later command. Never share a mutation worktree between tasks.

Job artifacts, contract format, dev server, checkpointing, and the handoff schema live in [references/workflow.md](references/workflow.md). Read it before Phase 2 or Phase 3.

## Craft Principles

These justify the specificity in the rest of the skill. Hold them while working; cite them when the user questions a rule.

- **Taste is trained, not innate.** Good defaults come from reverse-engineering interfaces that feel right, not from invention. Before building a pattern, recall the best version of it you have seen and borrow the invariants (timing, origin, easing, rhythm). Generic output is a sign you skipped this step.
- **Unseen details compound.** No single user consciously notices that a popover scales from its trigger, that a tooltip skips its delay on the second hover, or that a button releases faster than it presses. In aggregate these decisions separate "feels designed" from "feels assembled".
- **Beauty is leverage.** When every product works, the one that feels best wins the user. Polish is the only thing still up for grabs once the feature set is commoditised.

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

`$ARGUMENTS` is the text after the invocation, e.g. `/nuxt-frontend-design frost landing page` → "frost landing page". Parse it for both a theme name and an action; that example means ensure the frost theme, then build the landing page.

IS_NUXT=false: this skill needs a Nuxt project (`nuxt.config.ts`). Say so and stop.

| State | Phase |
|---|---|
| HAS_COLORS / HAS_THEME / HAS_GUIDELINES all false | Phase 1 (setup) |
| Mixed (some true, some false) | Phase 1 (repair a corrupted setup) |
| `$ARGUMENTS` names a theme the design system doesn't use | Phase 1 with that theme |
| PRIOR_REVIEW with FAIL verdict | Repair pass (below) |
| `$ARGUMENTS` asks for new pages | Phase 2 (build) |
| `$ARGUMENTS` asks to refine/polish, or existing pages need work | Phase 3 (polish) |
| No arguments, design system exists | Phase 3 (audit existing pages) |

**Repair pass**: read the full `{JOB_DIR}/review-report.md`, not just the verdict line. Fix every [HARD REJECT] and [RUBRIC] item at its referenced file:line, then re-emit the handoff with updated `contract_criteria_status`. Reuse the existing job ID.

Phase 2 depends on a complete design system. If any of the three indicators is missing, run Phase 1 first and tell the user you're doing so.

Phase 1 consumes a lot of context. When Phase 1 completes in the current conversation, prefer emitting the handoff and telling the user: "Design system ready. Start a new conversation and run `/nuxt-frontend-design {page}` to build with fresh context." Continue in the same conversation only if the remaining build is small and context is still clean.

## Content & Asset Rules

Apply across Phase 2 and Phase 3. Review treats violations as hard rejects.

### Every Element Earns Its Place

One thousand no's for every yes. Do not pad designs with placeholder sections, dummy stats, filler copy, or decorative content to fill space. If a section feels empty, solve it with layout, composition, or scale, not invented content.

Ask before adding material. If another section, page, stat block, or copy block would strengthen the design, raise it with the user rather than adding content the contract did not name.

Watch for "data slop": rows of stat counters, icon grids, logo bars, testimonial strips, feature bullets added reflexively rather than because the content demanded them.

### AI Slop Ban List

Hard rejections unless the user explicitly asked for them:

- Aggressive gradient backgrounds (purple/blue hero gradients, full-page meshes)
- Cards with a coloured left-border accent stripe
- Illustrations drawn inline with SVG shapes (use a real asset or a labelled placeholder)
- Emoji in UI copy unless the brand system registers emoji as a token
- Generic stat blocks ("10M+ users, 99.9% uptime, 24/7 support")
- Overused sans stacks: Inter, Roboto, Open Sans, Lato, Montserrat, Arial, any bare `system-ui` / `sans-serif` fallback as the only font
- SaaS-landing cliché serifs (Fraunces, Playfair, DM Serif) used *without commitment*, i.e. paired with a generic sans for body copy as decoration only. A theme that genuinely commits to an editorial, paper-craft, or literary aesthetic (kinetic-paper, flow) is right to use an editorial serif. The ban targets "add a serif heading for personality" tokenism.

### Placeholder Over Fake

A labelled placeholder beats a bad attempt at the real thing.

- Missing hero image: a neutral block reading `600×400 hero image`, not a hand-drawn SVG mountain
- Missing avatars: `https://api.dicebear.com/9.x/initials/svg?seed={name}` or `https://ui-avatars.com/api/?name={name}`
- Missing product screenshots: solid block at the real aspect ratio with a short label
- Missing logos: `https://logo.clearbit.com/{domain}` for real brands, otherwise a labelled box

Never leave broken `<img>` tags or unstyled fallback boxes. Placeholders should look intentional.

Scope: placeholders suit internal tools, dashboards, and prototypes. Landing and marketing pages want real product demos, screenshots, and named logos per [pages/landing.md](references/pages/landing.md) "Show, Don't Tell"; a labelled grey box on a hero kills the sale. Fall back to placeholders only when real assets genuinely don't exist yet.

### Minimum Scales

Surface these in the build contract as testable criteria.

- Body copy ≥ 16px; never below 14px
- Mobile tap targets ≥ 44×44px (buttons, links, icon triggers, form controls)
- Form input height ≥ 40px desktop, ≥ 44px mobile
- Contrast: WCAG AA for all text against its background

---

## Phase 1: Design System Setup

Establish the visual foundation. Needed when no design system exists or a new theme is requested. No job ID: design system artifacts are shared, not job-scoped.

### Design Philosophy

Commit to an aesthetic direction that serves the content before coding. Define one design principle as a tradeoff statement: "We prioritize X over Y" (e.g. "readability over visual impact", "tactile depth over minimalism"). Record it in `DESIGN.md`.

### What to set up

1. **Color palette**: primary, neutral, accent via `app.config.ts`
2. **Typography**: font selection, registration via Nuxt Fonts, `--font-*` in `@theme`
3. **Icon system**: collection matching the aesthetic via `@nuxt/icon`
4. **Semantic overrides**: `--ui-bg`, `--ui-text`, `--ui-radius` for light/dark
5. **Component theming**: global overrides via `app.config.ts` slots/variants
6. **Extended colors**: registering custom theme colors in `nuxt.config.ts`

**Override, don't invent.** Use Nuxt UI's existing tokens (`bg-muted`, `text-default`, `--ui-bg`, `--ui-radius`) and Tailwind's built-in utilities (`shadow-md`, `rounded-xl`). Customize by overriding those in `app.config.ts` and `main.css` rather than creating generic duplicates. Before naming a new token, check whether an existing `--ui-*` variable or Tailwind utility already covers it.

Theme signature tokens are the exception: when a theme's voice depends on an effect Tailwind can't express (`--shadow-brutal`, `--shadow-clay`, `--shadow-paper`, `--shadow-glass`, mesh/glow variables), define it. The ban targets generic duplicates (`--shadow-soft`, `--radius-card`), not theme-specific voice.

### References

- [design-system.md](references/design-system.md): full setup guide (colors, fonts, tokens, component theming)
- [themes/{name}.md](references/themes/): complete theme implementation files

Available themes: frost, clay, blueprint, nebula, zen, neon, teenage-engineering, kinetic-paper, flow, devtool (the live list is injected above).

Read exactly one theme file: `${CLAUDE_SKILL_DIR}/references/themes/{chosen-theme}.md`. Reading several for comparison burns context without improving the choice. With no theme specified, default to `frost` for dark mode projects and `zen` for light mode; ask only when the choice is genuinely ambiguous.

### After Setup: Emit DESIGN.md

Emit `DESIGN.md` at the project root after writing `app.config.ts`, `main.css`, and `nuxt.config.ts`:

1. **Collision guard**: if `DESIGN.md` exists, ask before overwriting. Offer to merge (preserving `## Design Decisions`) or abort.
2. Read the template: [templates/DESIGN.md](templates/DESIGN.md)
3. **YAML front matter**: the chosen theme file already carries a DESIGN.md-compatible YAML block. Copy it, then apply user-specific customisations (brand name, swapped primary hex, additional registered colours, extra component surfaces). Prefer token refs (`{colors.primary}`, `{rounded.md}`) over restating hex/px values.
4. **Prose sections**: fill every section below the front matter from the decisions just made, no placeholders.
5. Write to `DESIGN.md` at the project root.
6. **Verify placeholders removed**: `grep -cE '\{\{|TODO|placeholder' DESIGN.md` returns 0. (Single-brace `{colors.primary}` token refs are legitimate and stay.)
7. **Verify tokens lint**: `npx --yes @google/design.md lint DESIGN.md 2>/dev/null | jq -r '.summary.errors'` returns `0`. If the linter crashes (`raw.match is not a function`) because a component prop holds a float or `rgba()`, quote floats and convert `rgba()` to 8-digit hex. Contrast warnings on button-primary are informational here; if the theme's signature colour intentionally trades 4.5:1 for aesthetic, document it under `## Design Decisions`.

Modifying an existing design system: update `DESIGN.md` in place.

### Setup Recovery

Phase 1 failing mid-setup (build error, malformed config) means fixing the config before anything else. Verify all three indicators pass (`colors:` in app.config.ts, `@theme` in main.css, `DESIGN.md` with no placeholders) before moving to Phase 2. A `DESIGN.md` with unfilled template sections is worse than none.

### Setup Gotchas

- **Font selection**: avoid the top 5 web fonts (Inter, Roboto, Open Sans, Lato, Montserrat) and system-ui. Pick fonts that reinforce the design principle.
- **Button visibility**: primary CTAs need visible backgrounds. Set `colors.primary` plus `button.defaultVariants.variant: 'solid'` in `app.config.ts`. Secondary actions (icon triggers, overflow menus, table row actions) can use `ghost` or `outline`; see [components/feedback.md](references/components/feedback.md).
- **No fake UI**: if it looks interactive, wire it up.

---

## Phase 2: Build Pages

Compose pages and UI patterns with Nuxt UI v4+. Requires a design system.

Run the dev server setup and contract steps in [references/workflow.md](references/workflow.md) before the first smoke test.

**Build recovery**: `build-progress.md` present without `build-handoff.json` means a previous build was interrupted. Read the progress file for which pages completed and which criteria remain, resume from the last incomplete page, and re-run dev server setup since the old process is gone.

### Read the Foundation

If not already in context from Phase 1:

```
DESIGN.md                 -> aesthetic intent, component rules, avoid list, custom utilities
app/assets/css/main.css   -> @theme tokens, --ui-* overrides, custom classes
app.config.ts             -> colors, component theme overrides, defaultVariants
nuxt.config.ts            -> fonts, colorMode, ui.theme.colors
```

Use the project's semantic tokens, fonts, and component overrides. Never hardcode colors, shadows, or radii that bypass the design system. For a design variation, override an existing Nuxt UI token rather than introducing a new one.

### References

Load the reference matching what you're building. Loading several before writing any code costs context without improving the first page; pull the next one when you reach a new component type.

| Building… | Reference |
|-------------|-----------|
| Landing / marketing page | [pages/landing.md](references/pages/landing.md) |
| Dashboard / admin | [pages/dashboard.md](references/pages/dashboard.md) |
| Forms | [components/forms.md](references/components/forms.md) |
| Data tables | [components/tables.md](references/components/tables.md) |
| Navigation | [components/navigation.md](references/components/navigation.md) |
| Feedback / overlays | [components/feedback.md](references/components/feedback.md) |
| Charts, dashboards, sparklines, stat cards | [polish/data-viz.md](references/polish/data-viz.md) |

### When The User Asks For Variations

For 2+ options of the same page or component, vary across concrete dimensions rather than producing near-duplicates. Pick at least three of:

- **Scale**: hero type at 48px vs 96px vs 144px
- **Fill vs outline**: solid surfaces vs bordered/ghost
- **Layout structure**: stacked vs split vs asymmetric grid
- **Visual rhythm**: uniform cards vs feature + supporting mix
- **Type treatment**: display serif vs utility sans, tight vs wide tracking
- **Texture and layering**: flat vs shadowed vs offset/overlapping
- **Density**: airy vs compact

Start the first variation by-the-book, then escalate: each successive variation pushes further on one or two axes. Three variations differing only in accent colour are the same design three times.

Expose variations via route (`/pages/index-a.vue`, `/pages/index-b.vue`) or a `?variant=` query param with `v-if` blocks so the user can A/B them in one tab.

### Build Gotchas

Framework traps that grep won't reveal:

- **v4 component renames**: `ButtonGroup` → `UFieldGroup`, `PageMarquee` → `UMarquee`. Old names silently render nothing.
- **`UPageHero` needs a parent section**: wrap in `UPageSection` or a max-width container.
- **Form validation timing**: `UForm` with Zod validates on blur by default. `validate-on="input"` for inline.
- **`UTable` empty state**: without an explicit `empty` slot, an empty table shows nothing.
- **SSR boundary**: wrap client-only animations in `ClientOnly`, not entire page sections.
- **Component locality**: a new `app/components/Foo.vue` claims app-wide ownership (global auto-import, rename blast radius, collision risk). Default to colocating as `_Foo.vue` next to its page; the `_` prefix opts out of auto-import. Promote to `app/components/` once ≥2 unrelated features consume it. Review hard-rejects single-caller globals.

Review's hard rejection list is the authoritative rubric; see `/nuxt-frontend-review`.

---

## Phase 3: Polish

Refine existing interfaces against the project's own design system, not generic best practices. If `$ARGUMENTS` names an area (typography, motion, color), go straight to that reference.

Read the foundation files from Phase 2 if they aren't in context.

### Audit Foundation Tokens

Missing tokens cause inconsistency downstream. Fix gaps before elevating.

| Token category | Where defined | What to check |
|----------------|---------------|---------------|
| Colors | `app.config.ts` `colors` | `primary` and `neutral` set? Additional theme colors registered? |
| Fonts | `@theme` `--font-*` | At least `--font-sans`? Display/mono if used? |
| Semantic overrides | `:root` / `.dark` `--ui-*` | `--ui-bg`, `--ui-text`, `--ui-border` customized? |
| Component overrides | `app.config.ts` `ui.*` | Key components themed? `defaultVariants` set? |
| Unnecessary tokens | `@theme` | Custom tokens duplicating Tailwind builtins or `--ui-*`? Remove and use the existing token. |

### Observe Before Changing

Polish modifies an existing voice. Read 2-3 key `.vue` files first and state what the interface is currently saying: copy tone, shadow and card treatment, density, hover and focus states, animation style, rhythm between sections. The goal is to match and elevate that vocabulary. Not being able to describe the existing voice in one sentence means you are not ready to polish.

### Audit Consistency

Review's mechanical checks are the authoritative list (hardcoded hex/rgb, `slate-`/`gray-`/`zinc-`/`stone-` outside the configured neutral, `bg-white`/`text-black`, banned font families, custom `@theme` tokens duplicating `--ui-*`). See `harlan-agent-kit:nuxt-frontend-review` → `references/mechanical-checks.md`. Fix hits before handoff; review re-grades the same patterns.

Lead with the class-token inventory, the same command review runs:

```bash
npx -y @ripast/cli css-class-scan --glob 'app/**' --sort count-desc --json
```

Look for:
- **Synonym clusters**: `bg-gray-100` + `bg-slate-100` + `bg-zinc-100` all filling one semantic role (`bg-muted`). Each cluster is a conformity fix.
- **One-off tokens** (count = 1): usually a hand-tuned value that should map to a token.
- **Low-count spellings near a high-count one**: drift from the canonical class.

With an obvious token map, apply it via `ripast css-class-rename --map tokens.json --apply` (dry-run first) rather than hand-editing call sites.

Beyond the mechanical list: inconsistent shadow/radius choices across similar components (pick one per component type in `app.config.ts`), inline `style=`, raw HTML where a Nuxt UI component exists, and anything in `DESIGN.md` the implementation contradicts.

### Audit Confirmation

Present findings before changing anything:

```
**Audit findings:**

Token issues (will fix):
1. Hardcoded `bg-slate-100` in HeroSection.vue:42 → should use `bg-muted`

Aesthetic observations (need your input):
2. Hero text feels small for a landing page → increase size? [intentional / fix]
3. Cards all use identical treatment → add hierarchy? [intentional / fix]
```

- Token and consistency violations are objectively wrong per the design system: present as "will fix".
- Aesthetic judgments (sizing, hierarchy, rhythm, visual weight) need user input. Do not assume they are problems.
- Read `## Design Decisions` in `DESIGN.md` first. Anything already ruled on is settled; present only new observations. If all of them are covered, fix the token issues and move to Elevate.
- Wait for the user to mark each aesthetic item "intentional" or "fix".

After confirmation, update `DESIGN.md`: append new "intentional" choices to `## Design Decisions`, remove entries the user just marked "fix", create the section if absent.

```markdown
## Design Decisions
- Hero uses text-3xl intentionally: minimal aesthetic for utility tool
- Cards use uniform treatment: flat hierarchy is intentional
```

Fix only approved items.

### Elevate

Once foundation and consistency are solid and the audit is confirmed. Read by symptom:

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
| Chart/dashboard noisy, dishonest, or low data-ink | [polish/data-viz.md](references/polish/data-viz.md) |

For "make it better" or "polish everything": start with `interactions.md` + `motion.md` + `color.md` (highest impact), add `spatial.md`, `typography.md`, `responsive.md`, `ux-writing.md` only where the audit found issues, and consult `css-toolkit.md` whenever you are about to invent a token, add a JS scroll observer, or hand-code a popover, since the native CSS equivalent is usually one line.

### Verify the Route Still Loads

With `$DEV_PORT` / `$DEV_LOG` allocated (see workflow reference):

```bash
curl -sf "http://localhost:$DEV_PORT/{route}" > /dev/null && echo OK || echo FAIL
grep -nE '^\s*(\[error\]|\[warn\]|ERROR|WARN|✖|✘|Hydration |Cannot find|Failed to (resolve|compile))' "$DEV_LOG" \
  || echo "dev server log clean"
```

That is the whole self-verification at this stage. Visual and interaction verification is review's job; duplicating it here wastes context.

### Polish Rules

- Keep what already works and is distinctive.
- "Same product, elevated execution", not "this is different".
- Refine rather than replace wholesale.
- Polish what's there; adding features is scope creep.
- Over-polishing kills distinctiveness. Pick 1-2 areas to elevate, leave the rest.

### Polish Gotchas

- **Motion-v SSR hydration**: `ClientOnly` wrapper or `onMounted` for entrance animations
- **OKLCH browser support**: `@supports` fallback for older Safari
- **Font loading flash**: register fonts via Nuxt Fonts, not CSS `@import`
- **Container queries**: need `container-type: inline-size` on the parent
- **Don't refactor while polishing**: polish is visual refinement, not code cleanup

Polish work emits the same handoff as a build; see [references/workflow.md](references/workflow.md).

---

## Reka UI

For components Nuxt UI doesn't cover, or where it is too prescriptive, use [Reka UI](https://reka-ui.com/docs/overview/installation): unstyled, accessible Vue primitives you style with Tailwind.
