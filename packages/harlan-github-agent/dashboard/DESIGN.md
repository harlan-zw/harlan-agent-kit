---
name: Harlan GitHub Agent
description: Quiet Scandinavian control board. Paper neutrals, hairline structure, one ink primary, colour only for state.
colors:
  primary: "#1F1E1B"
  neutral: "#78746D"
  success: "#1A7F37"
  warning: "#9A6700"
  error: "#CF222E"
typography:
  display:
    fontFamily: Mona Sans
    fontSize: 1.125rem
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: Mona Sans
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.5
  mono:
    fontFamily: JetBrains Mono
    fontSize: 0.875rem
rounded:
  sm: 4px
  md: 6px
  lg: 8px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
motion:
  easeOut: "cubic-bezier(0.2, 0, 0, 1)"
  durationQuick: 120ms
  durationDefault: 160ms
  durationOverlay: 200ms
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#FFFFFF"
    rounded: "{rounded.md}"
    padding: 6px 12px
  button-primary-hover:
    backgroundColor: "#3A3833"
  card-default:
    backgroundColor: "#FFFFFF"
    borderColor: "#E6E3DD"
    rounded: "{rounded.md}"
    padding: 12px
  column-surface:
    backgroundColor: "#F4F2EE"
    rounded: "{rounded.lg}"
    padding: 8px
  badge-ready:
    textColor: "{colors.success}"
    borderColor: "{colors.success}"
    rounded: "{rounded.sm}"
    padding: 2px 6px
  badge-pending:
    textColor: "{colors.warning}"
    borderColor: "{colors.warning}"
    rounded: "{rounded.sm}"
    padding: 2px 6px
  badge-blocked:
    textColor: "{colors.error}"
    borderColor: "{colors.error}"
    rounded: "{rounded.sm}"
    padding: 2px 6px
---

# Design: Harlan GitHub Agent dashboard

Single source of truth for the dashboard in `packages/harlan-github-agent/dashboard`. Tokens live in `app/assets/css/main.css` and `app/app.config.ts`. The `/kit` route renders every token and primitive live; it is a dev page and the service never serves it. This file holds the rules code cannot enforce. A section earns its place only if it can reject a change.

Vocabulary is `../GLOSSARY.md`. GitHub's word wins where GitHub has one.

## Aesthetic Direction

- **Theme**: Scandinavian minimal. Paper neutrals, hairline borders, generous margins, no ornament.
- **Mode**: Light first, dark with full token parity.
- **Vibe**: Quiet, exact, calm.
- **Influences**: GitHub Primer (list rows, outlined labels, counter pills, semantic state colours, Mona Sans), Trello (one board, fixed columns, cards you open), Linear (density without noise), Scandinavian print (margin, restraint, one weight of ink).
- **Design principle**: We prioritise the exception over the inventory. The screen shows what changed or what needs a decision; everything else waits one click away.
- **Personality of motion**: Nearly none. 120ms to 160ms ease-out on colour and opacity. Overlays slide 200ms. The live dot is the only looping animation.

## What This Dashboard Is For

Harlan keeps it open on a second screen while agents work his repositories. It answers four questions in order. The layout is that order made visible.

1. Does anything need me?
2. What is running right now?
3. What is coming?
4. What already happened?

Repository health, provider limits, Routines, and host metrics are reference material. They live behind one control and surface on the board only when they block work or fail.

## Screens

| Route | Answers | Shape |
| --- | --- | --- |
| `/` Board | Questions 1 to 3, and the last eight of 4 | Four fixed columns: **Needs you**, **Up next** (with a **Waiting** group), **Running**, **Done** |
| `/history` | What happened, on what evidence | GitHub style list rows. Evidence opens in a slideover |
| `/watching` | What is being polled | Repository table, open items, Dismissed group |
| `/stats` | What the work produced over a range | Two small charts and one table. No score, no money |
| `/flow` | How work moves through the service | Static explainer. Reached from the overflow menu, never a tab |
| `/kit` | The design system, rendered | Dev only |

### Chrome

One header, one row, 48px, on every page.

- Left: wordmark, then tabs `Board`, `History`, `Watching`, `Stats`.
- Right: **System** chip, Agent selection button, Pause or Resume, overflow menu.
- The System chip reads `n/3` agents with a state dot. Grey is normal. Amber means work cannot start (Paused, Manual, writes off, Reserve reached, capacity unavailable, restart requested) and the chip names the reason. Red means an unresolved Incident and the chip carries the count. Red outranks amber. Before the first snapshot the chip shows a grey placeholder and no reason. Clicking it opens the System slideover.
- The overflow menu holds `Selection mode`, `Restart after current work`, `Notifications`, `Theme`, `How it works`.
- No status bar. No footer. Per-role model configuration lives inside the Agent selection menu.

### System slideover

The System pane is a slideover, not a section above the board. It holds, in order:

1. **Service**: Service update state, deployed and latest commits, last check time. The update control appears only when available.
2. **Capacity**: each Agent provider, percent left, Reserve, reset countdown. Circuit state when open or half open.
3. **Incidents**: kind, scope link, message, Recovery, occurrence count, age. No dismiss control.
4. **Routines**: name, schedule, latest run state. Candidates and terminal behind disclosures. Only when the host answers the Routine trigger.
5. **Host**: temperatures, load, services, only on the Tailscale host.

An unresolved Incident also renders as one compact error row above the board columns. It is the one System item that must be seen now.

### Cards

Trello cards. A card face carries identity and one decision. Everything else opens.

- Face: author avatar, `repository#number`, title, work chip. Then one state line: the reason it needs you, the queue position or blocking reason, the phase and elapsed time, or the outcome badge.
- One primary action on Needs you cards: `Review and repair` or `Approve`. Keyboard `a` presses it.
- Running cards carry `Eject` inline; it arms then confirms.
- Every other action sits in the card's overflow menu: `Open on GitHub`, `Rerun review`, `Cancel`, `Dismiss`. Cancel and Dismiss confirm in a modal that states the consequence in one sentence.
- Clicking the face opens the card slideover: full reason text, session and commit identifiers, terminal, timeline, and the same actions.
- Done cards are recessive and show the outcome badge and identity only. Evidence lives on History.

### Board rules

- Column order is fixed. Needs you keeps its slot when empty so the board never reflows.
- An entry lives in exactly one column, decided by state.
- Column headings are a label, a count pill, and a hairline. Never a title.
- Columns are a muted surface; cards are elevated white on it. Column surfaces are the only recessed area in the app.
- Queued work carries a position. Pending work sits under Waiting with a dashed border and never gets a position.
- An empty column names its cause in one line. If the cause has a control, the control is there.
- One work kind filter, all four columns, hidden until two kinds are present.
- Done holds eight. The ninth is a link to History.

## Every Element Earns Its Place

New copy has to answer one question the reader cannot already answer from the screen. If it cannot, it does not ship.

Never show:

- Eyebrow labels, section descriptions, or captions that restate a heading or a chart.
- Summary counter tiles. Counts live in headings.
- Static configuration on a live surface. Model lists, cron strings, host kernel strings, security notes.
- The same record in two places. Recently finished is gone; Done is the terminus.
- Provenance on a card face. Session id, commit SHA, agent id open on demand.
- Agent percentage progress. Show phase and elapsed.
- Keyboard hints as page copy. They live in the overflow menu under `Keyboard`.
- Internal words: Item, Revision, Observation, Publication, lease, fence, journal, snapshot, worker, job, bot.
- A control the controller would refuse.
- Reserve reached as an Incident.

Hide on demand: terminal, evidence, candidates, per-repository controls, host metrics, Dismissed items, per-role models, the workflow explainer.

## Color Decisions

| Role | Value | Why |
| --- | --- | --- |
| Primary | Ink `#1F1E1B` light, paper `#F4F2EE` dark | Primary actions are the darkest thing on the page, the way a GitHub or Vercel primary button is. No brand hue competes with state |
| Neutral | Warm tinted greys, OKLCH hue 80, chroma 0.004 to 0.008 | Pure grey reads clinical. A trace of warmth reads as paper |
| Success | `#1A7F37` | READY, Passed, live. Primer's success foreground |
| Warning | `#9A6700` | Needs you, PENDING, work cannot start. Primer's attention foreground |
| Error | `#CF222E` | BLOCKED, Failed, Incident. Primer's danger foreground |

- **Neutral tinting**: every background, border, and text step is OKLCH hue 80 with chroma 0.004 to 0.01. Never `#000`, never `#FFF` in dark mode.
- **Surface steps**: `--ui-bg` page paper, `--ui-bg-muted` column surface, `--ui-bg-elevated` card. Three steps, no more. Depth comes from the step and a hairline, never a shadow, except overlays.
- **Split**: 90 percent neutrals, 8 percent ink, 2 percent semantic colour on badges, dots, and one alert row.
- **Semantic colour is a signal, never a fill.** Badges are outlined or subtly tinted with strong foreground. The only tinted surfaces are the Needs you column's amber hairline and the Incident row.
- **Work kind is never a colour.**

### Contrast and Accessibility

- Body text: `--ui-text` on `--ui-bg` is above 12:1 in both modes.
- Muted text: `--ui-text-muted` sits at 4.6:1 or better on every surface step.
- Semantic text uses the `.status-*` ramp, mixed toward ink in light and toward paper in dark, so it clears 4.5:1 on tinted badges.
- Dark mode: primary flips to paper on ink; success, warning, error lighten one step; body weight stays 400 because Mona Sans is already light.

## Typography

| Role | Font | Why |
| --- | --- | --- |
| Body and display (`--font-sans`) | Mona Sans, 400 to 600 | GitHub's own face. Wide, even, calm at 14px. One family for everything |
| Mono (`--font-mono`) | JetBrains Mono 400 | SHAs, positions, elapsed time, terminal. Distinct from the sans at a glance |

- **Type system**: fixed rem scale. 0.75rem labels, 0.875rem body, 1rem card titles, 1.125rem page titles. Nothing larger anywhere in the app.
- **Weights**: 400 body, 500 titles and buttons, 600 counts. Hierarchy comes from weight and colour, never size jumps.
- **OpenType**: `tabular-nums` globally. Mono for every number that changes while you watch.
- **Floor**: 14px. Labels are 12px and uppercase only in `.field-label`, nowhere else.

## Icons

- **Collection**: Octicons via `@iconify-json/octicon`. One set, no mixing.
- **Why**: GitHub's icon language for GitHub entities. Issue, pull request, merge, check, and dot-fill read instantly to anyone who lives on GitHub.
- **Size**: 16px default, 14px inside badges and chips. Badge and chip text is 14px, the floor.

- **Colour**: `currentColor` only. Colour arrives from the semantic text class, never from the icon.

## Component Rules

- **Buttons**: primary is `solid` ink; used once per card and once per modal at most. Secondary is `outline` with a hairline. Tertiary is `ghost` for icon triggers and menu triggers. Never two solid buttons in one row.
- **Badges**: `outline` for outcome and state, `subtle` for counts. Uppercase only for Review outcomes (`READY`, `PENDING`, `BLOCKED`).
- **Cards**: `bg-elevated`, hairline `border-default`, `rounded-md`, 12px padding. Hover raises the border to `border-accented`. No shadow.
- **Columns**: `bg-muted`, `rounded-lg`, 8px padding, 8px gap between cards.
- **List rows**: History and Watching use divided rows on `bg-default`, no cards. Row height 44px minimum. Hover tints to `bg-muted`.
- **Slideovers**: 480px, `bg-default`, hairline left edge, header with title and close. All detail and all evidence lives here.
- **Modals**: confirmation only. One sentence of consequence, one solid button, one ghost cancel.
- **Menus**: Nuxt UI `UDropdownMenu`. Destructive items last, error colour.
- **Chips**: work kind chip is icon plus label, neutral outline, 14px.
- **Inputs**: hairline, `rounded-md`, 32px tall in dense rows, 40px in forms.
- **Focus**: 2px ink outline, 2px offset, everywhere.
- **Links to GitHub**: `.entity-link`, quiet underline that darkens on hover. Every repository, pull request, issue, commit, and comment links out.

## Spatial and Motion

- **Spacing**: 4pt grid. 4, 8, 12, 16, 24, 40.
- **Page margins**: 24px, 40px above `xl`. Content max width 1600px.
- **Rhythm**: sections separated by 40px and a hairline. Never a heading alone doing the separating.
- **Transitions**: 120ms colour and opacity on hover, 160ms on state, 200ms slide for overlays, `cubic-bezier(0.2, 0, 0, 1)`.
- **Animation**: the live dot pulses. Nothing else loops. Nothing enters with motion.
- **Reduced motion**: every transition drops to 0ms; the live dot holds solid.

## Responsive Strategy

- **Approach**: desktop first, three breakpoints. Below `xl` the board is two columns; below `md` one column, in pipeline order.
- **Chrome**: below `md` the tabs move into the overflow menu and the header keeps wordmark, System chip, and the menu.
- **Input method**: `pointer: coarse` raises every control to 44px. Hover styles only under `hover: hover`.
- **Tables**: scroll inside their own container. The page never scrolls sideways.

## Voice and Tone

- **Button labels**: verb plus object. `Review and repair`, `Approve`, `Cancel task`, `Dismiss`, `Eject`, `Resume`. Never `OK`, never `Submit`.
- **State lines**: one sentence, present tense, names the reason. `Blocked on a draft.` `Position 3.` `Issue work stops above 8 open pull requests, and 17 are open.`
- **Errors**: what happened, then the next action. `Approval refused: the head commit moved. Reload.`
- **Empty states**: one line naming the cause. A control if the cause has one. No second sentence.
- **Confirmations**: consequence first. `This pull request will never run again.` then `Dismiss`.
- **Simplified Technical English**: one idea per sentence, under 20 words, active voice, condition before command.

## Avoid

- Shadows on cards or rows. Overlays only.
- Gradients, textures, grid backgrounds.
- Coloured left border stripes.
- More than one solid button in view inside one card or row.
- Colour to encode work kind, repository, or provider.
- A tinted background larger than a badge, except the Incident row.
- Font sizes above 1.125rem.
- Uppercase outside `.field-label` and Review outcomes.
- Section text that explains the section.
- Tailwind `gray-`, `zinc-`, `slate-`, `stone-` utilities. Only `--ui-*` tokens.
- Hard-coded hex in components.
- Emoji.
- A second heading system. `.field-label` is the only section heading style.

## Custom Utilities

| Class or token | What it does | When to use |
| --- | --- | --- |
| `.field-label` | 12px, 500, uppercase, dimmed, 0.06em tracking | Column headings, table headers, detail list terms |
| `.entity-link` | Quiet underline in `border-accented`, darkens on hover | Any link that resolves to GitHub |
| `.status-success` `.status-warning` `.status-error` | Semantic text mixed toward ink or paper for AA on tints | Text inside badges, dots, alert rows |
| `.live-dot` | 2s opacity pulse, held solid under reduced motion | The Running column and the System chip while agents run |
| `.stale` | 55 percent opacity | Board content once the snapshot is over 90 seconds old |
| `.terminal` | Capped 20rem, mono, muted surface, wraps | Agent and Routine output inside slideovers |
| `.skip-link` | Offscreen until keyboard focus, then a solid ink pill at the top left | The first focusable element in the layout, targets `#main` |
| `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | Every transition |

## Design Decisions

- The System pane is a slideover behind one header chip. It was a section above the board and pushed Needs you below the fold on every visit. The chip carries the only two facts that must be seen without opening it: capacity and whether an Incident is open.
- Incidents also render as one row above the columns. An Incident is the one System fact that must interrupt watching.
- Recently finished is removed. It repeated three of Done's eight records.
- The status bar and footer are removed. Non-default service state moved into the System chip. Model configuration moved into the Agent selection menu. Security copy and keyboard hints were decoration.
- Flow is reached from the overflow menu. It is documentation, not monitoring, and a tab gave it monitoring weight.
- Cards open a slideover. Terminals, identifiers, and evidence were disclosures on the card face and made every column ragged. A card is now a fixed shape and detail has one home.
- Secondary card actions live in an overflow menu. Four buttons on a card face made the one that mattered hard to find.
- Cancel and Dismiss confirm in a modal from the menu. Eject stays inline and arms then confirms, because it is pressed while watching a live agent and a modal would cover the terminal.
- Primary is ink, not a hue. The only colours on the page are state colours, so a decision or a failure is the most saturated thing in view.
- Neutrals are warm tinted. True neutral read as a diagnostic tool; a trace of warmth reads as a desk.
- Mona Sans replaces Geist. The dashboard is a GitHub tool and borrows GitHub's face; Geist read as Vercel.
- Octicons replace Lucide. One set, and it is the set GitHub already taught the reader.
- Body is 14px. This is a dense tool watched from a distance on a large screen, and 14px is the documented floor.
- Column order is fixed and Needs you keeps its slot when empty. A board that reflows on state is unwatchable.
- An entry lives in one column, decided by state. Active work with no session yet still lands in Running, so a task cannot vanish between starting and reporting.
- Queue position is always visible on Up next. Pending work never gets a position, because it does not start on its own.
- A blocked forecast names its own limit. "Issue work stops above 8 open pull requests, and 17 are open."
- Never offer a control the controller would refuse. `Rerun review` appears only when the pull request is open, not draft, mergeable, and approved.
- Work kind is a chip, never a column and never a colour.
- A dismissed item leaves the board and reappears only under Dismissed on Watching.
- The tab title carries the Needs you count and the favicon carries its colour. Notifications are opt in and never fire on the first snapshot.
- Keyboard: `j` and `k` move through Needs you, `a` presses its primary action, `/` focuses the Watching filter, `?` opens the keyboard list.
- One snapshot and one event stream, shared by every page through `useDashboard`. Changing page never costs a reconnect.
- Presentation logic lives in `app/utils/dashboard.ts`, pure and unit tested. Every write lives in `app/composables/useDashboard.ts`. Pages hold layout and local filters only.
- Stats stays free of scores, rankings, and money. Bars start at zero, labels sit on the mark, no chart library, no legend.
- Shared visual primitives (`Card`, `ColumnHeading`, `StateBadge`, `WorkChip`, `EntityIdentity`, `ConfirmButton`, `DetailList`) live in `app/components/`. Page-local pieces stay `_Name.vue` beside their page.
