---
name: Wolfstar GitHub Agent
description: Cursor-inspired Agent panel. Neutral surfaces, compact navigation, real terminal input, colour only for state.
colors:
  primary: '#1F1E1B'
  neutral: '#78746D'
  success: '#1A7F37'
  warning: '#9A6700'
  error: '#CF222E'
typography:
  display:
    fontFamily: Hubot Sans
    fontSize: 1.125rem
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: Hubot Sans
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
  easeOut: 'cubic-bezier(0.2, 0, 0, 1)'
  durationQuick: 120ms
  durationDefault: 160ms
  durationOverlay: 200ms
---

# Design: Wolfstar GitHub Agent dashboard

Single source of truth for the dashboard in `packages/wolfstar-github-agent/dashboard`. Tokens live in `app/assets/css/main.css` and `app/app.config.ts`. The `/kit` route renders every token and primitive live; it is a dev page and the service never serves it. This file holds the rules code cannot enforce. A section earns its place only if it can reject a change.

Vocabulary is `../GLOSSARY.md`. GitHub's word wins where GitHub has one.

## Aesthetic Direction

- **Theme**: Cursor-inspired developer tool. Neutral surfaces, compact tabs, hairline borders, no ornament.
- **Mode**: Dark first. Preserve light mode and the saved theme preference.
- **Vibe**: Quiet, exact, calm.
- **Influences**: GitHub Primer for entities, Cursor for persistent navigation and terminal views, Linear for density, Scandinavian print for restraint.
- **Design principle**: We prioritise the exception over the inventory. The screen shows what changed or what needs a decision; everything else waits one click away.
- **Personality of motion**: Nearly none. 120ms to 160ms ease-out on colour and opacity. Overlays slide 200ms. The live dot is the only looping animation.

## What This Dashboard Is For

Wolfstar starts desktop Agent sessions and monitors repository work from one workspace.
Sessions give terminal Agents a stable home. The Board answers four monitoring questions.

1. Does anything need me?
2. What is running right now?
3. What is coming?
4. What already happened?

Repository health, provider limits, Routines, and host metrics are reference material. They live behind one control and surface on the board only when they block work or fail.

## Screens

| Route       | Answers                                   | Shape                                                                                                                         |
| ----------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `/` Board   | Questions 1 to 3, and the last eight of 4 | A full-width **Needs you** list, then three fixed columns: **Up next** (with a **Waiting** disclosure), **Running**, **Done** |
| `/sessions` | What to work on in a desktop project      | Projects and sessions at left, terminal at center, optional diff dock                                                         |
| `/history`  | What happened, on what evidence           | GitHub style list rows. Evidence opens in a slideover                                                                         |
| `/watching` | What is being polled                      | Repository table that flags exceptions only, open items, Dismissed group                                                      |
| `/routines` | What is coming on the clock               | Schedule table, soonest first, then the last runs                                                                             |
| `/stats`    | What the work produced over a range       | A stats strip, one bar chart, one table. No score, no money                                                                   |
| `/flow`     | How work moves through the service        | Static explainer. Reached from the overflow menu, never a tab                                                                 |
| `/kit`      | The design system, rendered               | Dev only                                                                                                                      |

### Chrome

One persistent 48px activity rail and one compact view header.
The header uses 40px on desktop and 48px on touch layouts.

- Navigation: Agent icon, then `Sessions`, `Board`, `History`, `Watching`, `Routines`, `Stats`.
  Icons have accessible names and tooltips. `How it works` sits below.
- Right: **System** chip, Agent selection button, Pause or Resume, overflow menu.
- The System chip reads `n/3` agents with a state dot. Grey is normal. Amber means work cannot start (Paused, Manual, writes off, Reserve reached, capacity unavailable, restart requested) and the chip names the reason. Red means an unresolved Incident and the chip carries the count. Red outranks amber. Before the first snapshot the chip shows a grey placeholder and no reason. Clicking it opens the System slideover.
- The overflow menu holds `Selection mode`, `Restart after current work`, `Notifications`, `Theme`, `How it works`.
- Terminal views may show their host and input ownership in a quiet status bar.
  Per-role maintenance model configuration stays inside the Agent selection menu.

### Agent sessions

- A 240px Project list borders one full-height terminal.
- The CLI owns models, conversation input, commands, and approvals.
- The host and Agent provider stay visible.
- Closing a view detaches it. Stop remains explicit.
- Historical structured Sessions and Watch logs stay read-only.
- Diffs open on demand beside the terminal.
- Mobile stacks Project controls above the terminal.
- Standalone mode hides maintenance controls and does not subscribe to maintenance events.
- Keep heavy terminal and diff renderers outside the initial route bundle.

### System slideover

The System pane is a slideover, not a section above the board. It holds, in order:

A compact exception summary leads the pane. Each entry links to evidence or a recovery control.
Service data expires after 90 seconds. Then the chip shows Unavailable without live counts.
The pane shows its last confirmed update and Reload. Settings wait for fresh data.
Host samples and runner samples expire separately after 30 seconds.
An incompatible desktop shows Update required and takes no new work.
The API returns every open Incident. The pane shows 50 rows, with errors first, and offers Show more.
Recovery shows a retry deadline or names the next operation. A due deadline never claims execution.

1. **Hosts**: Hogwild and the desktop, each with its running Agents, its Agent slot control, and the memory it holds. The slot buttons run from zero to the ceiling the controller allows. Host memory sits under them as advice, in amber when the count passes it.
2. **Service**: Service update state, deployed and latest commits, last check time. The update control appears only when available.
3. **Capacity**: each Agent provider, percent left, Reserve, reset countdown. Circuit state when open or half open.
4. **Incidents**: kind, scope link, message, Recovery, occurrence count, age. No dismiss control.
5. **Routines**: name, schedule, latest run state. Candidates and terminal behind disclosures. Only when the host answers the Routine trigger.
6. **Host**: temperatures, load, services, only on the Tailscale host.

An unresolved Incident also renders as one compact error row above the board columns. It is the one System item that must be seen now.

### Cards

Three shapes for three questions. A Needs you entry is a one-line row, because a decision is read as a line and twenty of them must fit half a screen. Queued and Running entries are three-line cards. A Done entry is a one-line row, because an outcome is read, not decided. Every shape opens the same slideover.

- Needs you row, left to right: state dot (red for Action required, amber for Approval required), avatar, kind icon and title, `owner/repo #number`, the reason on one truncated line, then a fixed action slot holding the one primary button and the menu. The full reason opens with the row.
- Card, top to bottom: kind icon and `owner/repo #number` with the queue position and the avatar at the right; the title clamped to two lines; one state line with a dot, the reason or phase truncated to one line, and mono elapsed time for a running agent. Nothing else. The terminal, including the last command, opens with the card.
- Done row: the outcome as a dot and a word with mono confidence in a fixed slot, then `repo #number title` truncated, then mono age.
- The overflow menu appears on hover, focus, or a coarse pointer. Forty always-visible kebabs were forty invitations to nothing.
- Every Needs you row carries one recommended action. Keyboard `a` presses it.
- `Approve` and `Review and repair` appear only for entries awaiting Approval.
- `Write spec`, `Provide info`, `Review issues`, and `View failure` open the full task with `Copy task`.
- `Resolve conflicts` and `View checks` open GitHub. Their external-link icon names that boundary.
- Conflicting contributor pull requests show `Approve on GitHub` when the current head still requires Approval.
- `Dismiss` is recommended only by the latest review of the current head. It still confirms the consequence.
- Unknown blockers use `View details`. They never imply Approval or Dismissal.
- No card or row carries a second button. `Watch logs` opens the running Agent in Sessions.
- Every other action sits in the card's overflow menu: `Open on GitHub`, `Rerun review`, `Cancel`, `Dismiss`. Cancel and Dismiss confirm in a modal that states the consequence in one sentence.
- Clicking the face opens the card slideover: full reason text, session and commit identifiers, terminal, timeline, and the same actions.
- Done rows are recessive and show the outcome and identity only. Evidence lives on History.

### Board rules

- The order is fixed: the Needs you list, then Up next, Running, Done. Needs you keeps its slot when empty so the board never reflows.
- On desktop the board fills the viewport and never scrolls as a page. Needs you takes at most half of it; the three columns share the rest. Each region scrolls on its own.
- An entry lives in exactly one column, decided by state.
- Column headings are the name in sentence case, then the count in mono. A dot in front carries state: amber on Needs you while it holds cards, green and pulsing on Running while agents run. No hairline, no uppercase, no title.
- Columns are a muted surface; cards are elevated white on it. Column surfaces are the only recessed area in the app.
- Queued work carries a position. Pending work folds into a `Waiting` disclosure at the foot of Up next and never gets a position. Its state line says why it waits.
- An empty column names its cause in one line. If the cause has a control, the control is there.
- One work kind filter, all four columns, hidden until two kinds are present.
- Done holds eight rows in one bordered list. The ninth is a link to History.

## Every Element Earns Its Place

New copy has to answer one question the reader cannot already answer from the screen. If it cannot, it does not ship.

Never show:

- Eyebrow labels, section descriptions, or captions that restate a heading or a chart.
- Summary counter tiles on a live surface. Counts live in headings; the Stats strip is the one place a number is the content.
- Static configuration on a live surface. Model lists, cron strings, host kernel strings, security notes.
- The same record in two places. Recently finished is gone; Done is the terminus.
- Provenance on a card face. Session id, commit SHA, agent id, last command open on demand.
- A column of identical cells. `Healthy`, `Enabled`, `Running` on every row said nothing; Watching flags `Action required`, `Starting`, `Paused`, `Writes off` and shows nothing for the normal case.
- A stored record in a row. A forty character SHA reads as seven; JSON evidence becomes a sentence or waits in the Evidence slideover.
- A page title that repeats the tab. History and Watching headings carry a count; Stats has no heading.
- Agent percentage progress. Show phase and elapsed.
- Keyboard hints as page copy. They live in the overflow menu under `Keyboard`.
- Internal words: Item, Revision, Observation, Publication, lease, fence, journal, snapshot, worker, job, bot.
- A control the controller would refuse.
- Reserve reached as an Incident.

Hide on demand: terminal, evidence, candidates, per-repository controls, host metrics, Dismissed items, per-role models, the workflow explainer.

## Color Decisions

| Role    | Value                                     | Why                                                                                                                               |
| ------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Primary | Ink `#1F1E1B` light, paper `#F4F2EE` dark | Primary actions are the darkest thing on the page, the way a GitHub or Vercel primary button is. No brand hue competes with state |
| Neutral | Neutral greys, OKLCH chroma zero          | Neutral surfaces give terminal content and state priority                                                                         |
| Success | `#1A7F37`                                 | READY, Passed, live. Primer's success foreground                                                                                  |
| Warning | `#9A6700`                                 | Needs you, PENDING, work cannot start. Primer's attention foreground                                                              |
| Error   | `#CF222E`                                 | BLOCKED, Failed, Incident. Primer's danger foreground                                                                             |

- **Neutral tinting**: workspace background, border, and text steps use zero OKLCH chroma. Never `#000`, never `#FFF` in dark mode.
- **Surface steps**: `--ui-bg` page paper, `--ui-bg-muted` column surface, `--ui-bg-elevated` card. Three steps, no more. Depth comes from the step and a hairline, never a shadow, except overlays.
- **Split**: 90 percent neutrals, 8 percent ink, 2 percent semantic colour on badges, dots, and one alert row.
- **Semantic colour is a signal, never a fill.** Badges are outlined or subtly tinted with strong foreground. The only tinted surfaces are the Needs you column's amber hairline and the Incident row.
- **Work kind is never a colour.**

### Contrast and Accessibility

- Body text: `--ui-text` on `--ui-bg` is above 12:1 in both modes.
- Muted text: `--ui-text-muted` sits at 4.6:1 or better on every surface step.
- Semantic text uses the `.status-*` ramp, mixed toward ink in light and toward paper in dark, so it clears 4.5:1 on tinted badges.
- Dark mode: primary flips to paper on ink; success, warning, error lighten one step; body weight stays 400.

## Typography

| Role                             | Font                   | Why                                                                         |
| -------------------------------- | ---------------------- | --------------------------------------------------------------------------- |
| Body and display (`--font-sans`) | Hubot Sans, 400 to 600 | Requested UI face. One family for every panel                               |
| Mono (`--font-mono`)             | JetBrains Mono 400     | SHAs, positions, elapsed time, terminal. Distinct from the sans at a glance |

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
- **Links to GitHub**: `.entity-link`, plain until hover or focus, then underlined. A board of forty titles reads as text, not as forty links. Every repository, pull request, issue, commit, and comment links out.

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

`COPY.md` owns dashboard copy. `../GLOSSARY.md` owns product concepts.

## Custom Utilities

| Class or token                                      | What it does                                                          | When to use                                                |
| --------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------- |
| `.field-label`                                      | 12px, 500, uppercase, dimmed, 0.06em tracking                         | Table headers and detail list terms only                   |
| `.entity-link`                                      | No underline until hover or focus                                     | Any link that resolves to GitHub                           |
| `.status-success` `.status-warning` `.status-error` | Semantic text mixed toward ink or paper for AA on tints               | Text inside badges, dots, alert rows                       |
| `.live-dot`                                         | 2s opacity pulse, held solid under reduced motion                     | The Running column and the System chip while agents run    |
| `.stale`                                            | 55 percent opacity                                                    | Board content once the snapshot is over 90 seconds old     |
| `.terminal`                                         | Capped 20rem, mono, muted surface, wraps                              | Agent and Routine output inside slideovers                 |
| `.skip-link`                                        | Offscreen until keyboard focus, then a solid ink pill at the top left | The first focusable element in the layout, targets `#main` |
| `--ease-out`                                        | `cubic-bezier(0.2, 0, 0, 1)`                                          | Every transition                                           |

## Migration decisions

- 2026-10-12: The user approved the whole panel overhaul.
- Keep production routes, controls, histories, and settings accessible through the shared shell.
- Use Hubot Sans through Nuxt Fonts. Keep JetBrains Mono for terminal text.
- Use neutral surfaces and dark mode by default. Preserve saved theme preferences.
- Keep GitHub entities and Octicons. Colour describes state.
- Keep the existing Board, System pane, History, Routines, and Stats contracts.
- New interactive work uses Codex, Claude Code, or OpenCode terminals.
- Do not add an app chat composer, full editor, language server, index, or extension system.
