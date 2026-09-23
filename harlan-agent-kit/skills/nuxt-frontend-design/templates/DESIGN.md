---
name: {{PROJECT_NAME}}
description: {{one-line description of the visual identity}}
colors:
  primary: "{{#HEX}}"
  neutral: "{{#HEX}}"
  {{accent-name}}: "{{#HEX}}"
typography:
  display:
    fontFamily: {{Font Name}}
    fontSize: {{3rem}}
    fontWeight: {{600}}
    lineHeight: {{1.1}}
  body:
    fontFamily: {{Font Name}}
    fontSize: 1rem
    lineHeight: 1.5
  mono:
    fontFamily: {{Font Name}}
    fontSize: 0.875rem
rounded:
  sm: {{4px}}
  md: {{8px}}
  lg: {{16px}}
spacing:
  sm: 8px
  md: 16px
  lg: 24px
  xl: 48px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{{#HEX}}"
    rounded: "{rounded.md}"
    padding: 12px
  button-primary-hover:
    backgroundColor: "{{#HEX}}"
  card-default:
    backgroundColor: "{{#HEX}}"
    rounded: "{rounded.lg}"
    padding: 24px
---

# Design — {{PROJECT_NAME}}

> Rules that can reject a PR. No catalog, no dates. Cap: 300 lines, 40 per section. History: `docs/design-decisions.md`.
> Front matter holds the tokens for the `@google/design.md` linter. Token refs use `{path.to.token}`.

## Load map

- When you work in {{layer or path}}, also read {{its nested AGENTS.md or topic file}}. {{Delete this section while no topic file exists.}}

## Aesthetic Direction

- **Theme**: {{THEME_NAME}} {{CUSTOMIZATION_NOTES}}
- **Mode**: {{dark-only | light-only | both}}
- **Vibe**: {{2-3 word mood description, e.g. "clinical glass dashboard", "warm editorial craft"}}
- **Influences**: {{design references that shaped decisions — products, sites, or libraries whose invariants we borrow}}
- **Design principle**: {{one-line tradeoff statement, e.g. "We prioritise readability over visual impact" or "We prioritise tactile depth over minimalism". This is the tiebreaker when two valid options exist.}}
- **Personality of motion**: {{how animations should feel — e.g. "crisp and utilitarian: 150-200ms, ease-out" or "slightly slow and elegant: 250-400ms, ease, matches Sonner"}}. Cohesion matters: motion should fit the vibe of the rest of the product.

## Color Decisions

| Role | Value | Why |
|------|-------|-----|
| Primary | {{color}} | {{reason — e.g. "cyan for contrast on dark glass"}} |
| Neutral | {{color}} | {{reason — e.g. "slate — cool to match frost aesthetic"}} |
| Accent | {{color}} | {{reason — e.g. "amber — warm counterpoint for CTAs"}} |
| Extended | {{any registered theme colors}} | {{reason}} |

- **Neutral tinting**: {{e.g. "all grays tinted toward brand hue (chroma 0.01) for subconscious cohesion" | "using Nuxt UI's built-in stone neutrals which are already warm-tinted"}}
- **60-30-10 split**: {{e.g. "60% stone neutrals, 30% text/borders, 10% amber accent on CTAs only"}}

### Contrast & Accessibility

- **Body text contrast**: {{e.g. "7:1+ against bg-default — exceeds AA"}}
- **Dark mode adjustments**: {{e.g. "accents desaturated 10%, body weight reduced to 350, no pure black backgrounds"}}
- **Known risks**: {{e.g. "muted text on colored backgrounds — verify 4.5:1 minimum" | "none identified"}}

## Typography

| Role | Font | Why |
|------|------|-----|
| Body (`--font-sans`) | {{font}} | {{reason}} |
| Display (`--font-display`) | {{font or "not used"}} | {{reason}} |
| Mono (`--font-mono`) | {{font or "default"}} | {{reason}} |

- **Type system**: {{fixed rem scale | fluid clamp() — e.g. "fixed rem — this is a dashboard/app UI, not marketing"}}
- **OpenType features**: {{e.g. "tabular-nums on all data tables, small-caps on status labels" | "none needed"}}

## Icons

- **Collection**: {{e.g. lucide, heroicons, phosphor}}
- **Why**: {{e.g. "thin 2px strokes match restrained aesthetic"}}
- **Color rule**: {{e.g. "monochrome only — color reserved for semantic states (success/error/warning)"}}

## Component Rules

`craft-rules.md` in this skill's `references/` owns the rules that hold on every Nuxt UI site:
colour budget, hierarchy, async state, motion, navigation, contrast, CSS gotchas, dates. Read it
before list, table, dashboard, async state, or custom CSS work. This file binds those rules to the
project's components; it never restates them.

> Behavioral constraints that tokens alone don't communicate. Component *surfaces* (bg, text, radius, padding) live in the YAML front matter under `components:`. This section holds the "always/never" judgment rules.

- {{e.g. "Buttons: always solid variant, never ghost — ghost disappears on dark glass"}}
- {{e.g. "Cards: glass effect with backdrop-blur-xl, never hard borders"}}
- {{e.g. "Radius: rounded-2xl globally, rounded-full only for avatars"}}
- {{e.g. "Inputs: bottom-border only, no box styling"}}
- {{e.g. "Focus rings: 2px primary-500 with 2px offset on all interactive elements"}}
- {{e.g. "Error messages: below field, 3-part structure (what/why/fix), never blame user"}}

## Spatial & Motion

- **Spacing system**: {{e.g. "4pt base grid: 4, 8, 12, 16, 24, 32, 48, 64px"}}
- **Spacing philosophy**: {{e.g. "generous ma spacing — sections separated by py-24 md:py-32"}}
- **Transition speed**: {{e.g. "300-600ms with ease-zen — contemplative, not snappy"}}
- **Animation style**: {{e.g. "fade up + scale from 0.95, stagger 100ms between siblings, cap at 500ms total"}}
- **Reduced motion**: {{e.g. "crossfade fallback for all spatial animations, functional animations preserved"}}

## Responsive Strategy

- **Approach**: {{e.g. "mobile-first, 3 breakpoints (sm/md/lg)" | "desktop-only dashboard"}}
- **Input method**: {{e.g. "pointer:coarse enlarges touch targets to 48px, hover effects only with hover:hover"}}
- **Navigation adaptation**: {{e.g. "hamburger → horizontal → full sidebar" | "always sidebar with collapse"}}

## Voice & Tone

`COPY.md` owns every user-facing string: the canonical assets, the register per surface, and the
banned language. Read it before writing a label, heading, empty state or error.

{{If this project has no COPY.md, delete the line above and tell the user. The copywriting
skill's init workflow owns bootstrap: say so and offer it rather than running it here. Do not
start a second voice guide, because two of them is the failure that file exists to prevent.}}

## Avoid

> Things that break the aesthetic. Check this list before adding new patterns.

- {{e.g. "Gradients on text — except the frost signature gradient"}}
- {{e.g. "Drop shadows on dark surfaces — use inner glow or border opacity instead"}}
- {{e.g. "Any warm background colors — breaks the cold frost atmosphere"}}
- {{e.g. "Rounded corners below xl — too subtle for glass panels"}}
- {{e.g. "Colorful icons — monochrome only, color reserved for semantic states"}}
- {{e.g. "Pure black (#000) or pure gray — all neutrals tinted toward brand"}}
- {{e.g. "Bounce/elastic easing — use exponential ease-out or springs"}}
- {{e.g. "Nesting cards inside cards — use spacing and dividers for inner hierarchy"}}

## Custom Utilities

Utility rules only. The list lives in `main.css`.

- {{e.g. "Every panel surface uses `.glass`. Never rebuild it inline."}}
