---
name: Harlan GitHub Agent
description: A quiet neutral control room where weight, scale, and position carry the whole hierarchy.
colors:
  primary: "#059669"
  neutral: "#171717"
  warning: "#d97706"
  error: "#dc2626"
typography:
  body:
    fontFamily: Geist
    fontSize: 1rem
    lineHeight: 1.5
  heading:
    fontFamily: Geist
    fontSize: 1.875rem
    fontWeight: "600"
    lineHeight: "1.15"
  mono:
    fontFamily: Geist Mono
    fontSize: 0.875rem
rounded:
  sm: 4px
  md: 6px
  lg: 6px
spacing:
  sm: 8px
  md: 16px
  lg: 24px
  xl: 48px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: 12px
  card-default:
    backgroundColor: "#ffffff"
    borderColor: "#ececec"
    rounded: "{rounded.md}"
    padding: 20px
---

# Design: Harlan GitHub Agent

> Captures the intent behind the dashboard so later work stays cohesive. Front matter holds machine-readable tokens. Prose holds rationale and judgment.

## Aesthetic Direction

- **Theme**: Minimal control room. Neutral field, one accent, no ornament.
- **Mode**: Light and dark.
- **Vibe**: Quiet, legible, exact.
- **Influences**: Linear's information density, Vercel's neutral surfaces, air traffic control displays where one glance must find the exception.
- **Design principle**: We prioritize hierarchy over uniformity. When two elements could look the same, the more important one gets more weight.
- **Personality of motion**: Almost none. Colour and opacity transitions finish in 120ms to 150ms. Nothing moves on the page unless the underlying state moved.

## What This Dashboard Is For

Harlan keeps it open on a second screen to watch a fleet of agents work his repositories. It answers four questions, in this order, and the layout is nothing more than that order made visible:

1. **Does anything need me?** The engine stops on approvals and on failures it cannot resolve.
2. **What is running right now?** The reason the page is open.
3. **What is coming?** A forecast, so nothing is a surprise.
4. **What already happened?** Evidence for a decision that was already made.

Everything else, meaning repository health and the open GitHub items being polled, is reference material. It is not an event, so it does not get event weight.

## The Board Contract

The first three questions are stages of one pipeline, so they are columns, left to
right, on one board. The last two are reference, so they are their own pages.

| Column | Answers | Weight |
| --- | --- | --- |
| **Needs you** | Does anything need me? | Amber bordered and tinted cards, solid primary action. A muted line when empty; the column keeps its slot so the board never reflows. |
| **Up next** | What is coming? | Elevated cards, dimmed position numeral, scroll capped at 42rem. |
| **Running** | What is running? | Elevated cards, live dot, progress bar, terminal behind a disclosure. |
| **Done** | What just happened? | Recessive cards, outcome badge leading, eight at most, then a link to History. |

Two pages carry what the board cannot hold:

| Page | Answers | Weight |
| --- | --- | --- |
| **History** | What happened, and on what evidence? | Dense divided rows, outcome badge leading, evidence behind a toggle. |
| **Watching** | What is being polled? | Recessive. Repository table and open items, hairline rules only. |

Rules that follow from this:

- **Column headings recede so the data can advance.** A heading is a 0.75rem uppercase label, a count, and a hairline rule that runs to the edge. It is a marker, not a title. Six bold `text-lg` headings were what made an earlier layout read as six equal panels.
- **Never show the same thing in two columns.** A Queue entry belongs to exactly one column, decided by its state. Work the Queue calls Active with no agent session yet still lands in Running, so a task cannot vanish between starting and reporting.
- **Done is a terminus, not a second History.** It carries the outcome badge and nothing else. Every piece of evidence lives on the History page.
- **One filter, all four columns.** Work kind filters the whole board at once. Filtering one column would break the pipeline reading.
- **No summary counter row.** Counts live in the zone headings. A separate tile row is a second navigation system competing with the sections it points at.
- **Exceptions bubble up, detail stays down.** A repository that fails polling raises a red count on the Watching tab. The table itself stays on that page.

## Every Element Earns Its Place

Removed, and not to be reintroduced:

- **Eyebrow labels above headings.** "Highest priority", "Next up", "Agent output", "Repository mappings". Each restated the heading below it in smaller type.
- **Section descriptions that paraphrase the heading.** "Active reviews and fixes. Updates appear live."
- **The summary counter row.** Four tiles that duplicated four section headings.
- **The page grid background.** Decoration with no referent.
- **Copy that restates its own button.** An approval row said "Review and repairs require your approval." next to a button reading "Review and repair". A failure row keeps its reason, because the reason is the only information on the row.
- **Provenance on the card face.** Session identifier, agent identifier, and commit SHA are debugging aids, not watching aids. They sit behind a "Session and commit" disclosure on running agents and behind "Evidence" in history.
- **Static configuration in the live status bar.** The per-role model list does not change while you watch, so it belongs in the footer.

New copy has to answer one question the reader cannot already answer from the screen. If it cannot, it does not ship.

## Color Decisions

| Role | Value | Why |
| --- | --- | --- |
| Primary | Emerald | Marks live, healthy, and the single most important action. Used on roughly 5% of pixels. |
| Neutral | True neutral grey | Untinted, so semantic colour reads as the only colour on the page. |
| Warning | Amber | Needs a decision. Distinct from failure. |
| Error | Red | Failed, blocked, or cancelled. |

- **Neutral tinting**: None. Earlier revisions tinted every grey toward green, which muddied the point where emerald actually meant something.
- **60-30-10 split**: Neutral surfaces dominate. Text and hairline borders build structure. Semantic colour marks state only.

### Contrast and Accessibility

- **Body text contrast**: Text targets WCAG AA in both modes. Muted text sits at `oklch(52%)` in light and `oklch(66%)` in dark, both above 4.5:1 on their own ground.
- **Dark mode adjustments**: Ground is `oklch(14.5%)`, never pure black. Panels lift by lightness, never by shadow.
- **Known risks**: Nuxt UI subtle badges fall short of AA on small text, so state text uses the `.status-*` ramp instead of the badge default.

## Typography

| Role | Font | Why |
| --- | --- | --- |
| Body (`--font-sans`) | Geist | Neutral grotesque with genuine tabular numerals, which dense state tables need. |
| Display | Not used | Headings are Geist at 600. A second family would add voice this interface does not want. |
| Mono (`--font-mono`) | Geist Mono | Metrically matched to Geist, so mono identifiers sit inside sans copy without a jump. |

- **Type scale**: Five sizes only. 0.75rem for badges and micro labels, 0.875rem for metadata, 1rem for body, 1.125rem for section headings, 1.875rem for the page title.
- **Weights**: Three only. 400 body, 500 emphasis, 600 headings. Never bold.
- **Mono rule**: Mono marks machine-generated values, meaning commit SHAs, session identifiers, repository slugs, durations, and counts. Buttons, navigation, and prose are sans.
- **OpenType features**: `tabular-nums` on the body element, so every column of numbers aligns without per-component opt-in.

## Icons

- **Collection**: Lucide.
- **Why**: One consistent stroke weight, and it already covers the GitHub verbs this dashboard names.
- **Color rule**: Icons inherit text colour. Semantic colour only when the adjacent text already carries the same state.

## Component Rules

- **Panels**: one hairline border, elevated background, `{rounded.md}`. No shadows, no nesting a panel inside a panel. Only the top two zones get panels at all.
- **Dashed borders**: reserved. A dashed border means "documented but not connected" on the workflow map. Nothing decorative may use one.
- **Buttons**: solid primary for the single most important action in a zone, which in practice means the approval action. Every other control is ghost neutral. Never two solid buttons in one row.
- **Badges**: subtle variant, always paired with the `.status-*` text ramp, always carrying a word. Never a bare colour dot as the only signal.
- **Avatars**: the GitHub author of a pull request or issue, from `https://github.com/{login}.png?size=64`. The avatar leads the card and links to the author, because identity is what separates "mine, proceed automatically" from "outside contributor, needs approval". Every card and every row that names an item carries one, on the board, in History, and in Watching. The service ships `author` on running agents and review runs for exactly this reason.
- **Work chips**: an icon and a word saying what a card is for, in neutral only. Amber, red, and emerald mean state on this board, so work kind may never take a second colour axis. The icon carries the distinction: review is an eye, repair a wrench, conflict a merge, baseline a pulse, triage an inbox, issue work a hammer.
- **Tap targets**: controls run at their natural desktop height. A `pointer: coarse` media query raises buttons, inputs, and summaries to 44px. Inline links inside a sentence are exempt under WCAG 2.5.8; forcing them to 44px inflated every metadata row on mobile.
- **Focus rings**: 2px primary outline with 2px offset on every interactive element, including `summary`.
- **Empty states**: one muted mono line inside a zone. A full empty-state card is event weight given to a non-event.
- **Errors**: what failed, then the next action, in that order.
- **Terminal panel**: collapsed by default on running agents, capped at 20rem, mono. It answers "is this agent wedged or working", which is a question you ask, not a signal you watch. Rendered output is redacted upstream; never render raw command output.
- **Destructive controls**: Cancel arms on the first press and commits on the second, reverting after five seconds. It ends minutes of agent work, so it does not fire on a single misclick.
- **Per-repository pause** lives in the Watching table, as a column showing Running or Paused. A paused repository keeps polling and stays fully visible; it only stops starting new agents. Pausing is not hiding.
- **Fields that appear when they mean something**: the stalled-progress warning is absent while an agent reports normally, and appears in amber once it has been silent for two minutes. Showing an always-on "last update" timestamp is noise; showing it only when it turns into a signal is not.

## Spatial and Motion

- **Spacing system**: Four pixel base grid. Rows use 16px, panels 20px, sections separate by 32px.
- **Spacing philosophy**: Compact inside a group, generous between groups. Whitespace is the section divider wherever a border is not carrying meaning.
- **Transition speed**: 120ms to 150ms, ease out, colour and opacity only.
- **Animation style**: State changes fade. Lists never animate on update, because a live list that reflows is unreadable.
- **The one animation**: the live dot pulses on a 2s opacity cycle, on the connection indicator and on every running agent. A monitoring surface has to prove it is not a frozen screenshot, and that is the cheapest possible proof. Nothing else on the page moves on its own.
- **Reduced motion**: All transitions collapse to 0.01ms and the live dot stops pulsing.

## Responsive Strategy

- **Approach**: Mobile first. Dense multi-column layouts unlock at 768px, the widest table layouts at 1280px.
- **Input method**: `pointer: coarse` raises control heights. Inline entity links become 44px flex targets below 768px.
- **Navigation adaptation**: The header wraps. The board drops from four columns to two at 1280px and to one below 768px, which turns the pipeline into a vertical reading order rather than hiding a stage.

## Voice and Tone

- **Button labels**: Verb first. "Approve", "Rerun review", "Cancel". Never "OK" or "Submit".
- **Error style**: State what failed, then what to do. "The request failed. Refresh and retry."
- **Empty states**: Name what the agent is waiting to observe.
- **Vocabulary**: `GLOSSARY.md` is canonical. Never expose Subject, Revision, Worker, or Publication in the interface.

## Avoid

- Decorative dashed borders, now that dashed carries meaning.
- Background grids, meshes, or gradients.
- Eyebrow labels above headings.
- Mono type on buttons, navigation, or prose.
- Colour without a word next to it.
- Nested panels.
- A second solid button in the same row as a primary action.
- Invented metrics or filler sections.

## Custom Utilities

| Class or token | What it does | When to use |
| --- | --- | --- |
| `.zone-header` | Lays out a column or page marker: label, count, hairline rule to the edge. | The heading of every board column and every page section. |
| `.zone-rule` | The rule that fills the remainder of a zone header. | Inside `.zone-header` only. |
| `.live-dot` | 2s opacity pulse, disabled under reduced motion. | Connection indicator and running agents. |
| `.field-label` | 0.75rem uppercase dimmed micro label. | Detail list terms, table headers, zone headings. |
| `.entity-link` | Quiet underline that firms up on hover. | Any link that resolves to a GitHub URL. |
| `.status-{success,warning,primary,error}` | Darkens or lightens state text to reach AA against a subtle badge. | Every semantic badge and every state sentence. |
| `.skip-link` | Offscreen skip target that slides in on focus. | First element in each page. |
| `.agent-terminal` | Scrolling mono log capped at 20rem. | Live shell activity on a running agent. |
| `.stale-content` | Drops the page to 55% opacity. | Applied to the zones when the snapshot passes 90 seconds old. |
| `.deferred-section` | Defers offscreen rendering with `content-visibility`. | History and Watching. |
| `kbd` | Hairline key cap. | The shortcut hint in the footer. |

Panels use plain utilities (`border border-default rounded-md bg-elevated`) rather than a named class, so a panel that needs to differ can differ without forking a token.

## Design Decisions

- Column order is fixed: Needs you, Up next, Running, Done. It reads as the pipeline, left to right, so the eye learns positions instead of hunting.
- Needs you keeps its column when empty, unlike the stacked layout that removed the zone. On a board a missing column moves every other column, and a layout that reflows on state is unwatchable. The heading loses its amber instead.
- Chrome lives in one layout, not per page. Header, tabs, status bar, banners, and footer are `layouts/default.vue`, so the board, History, Watching, and Flow cannot drift apart.
- One snapshot and one event stream, shared by every page through `useDashboard`. Changing page must never cost a reconnect.
- Work kind is a chip, never a column and never a colour. Grouping by kind would break the pipeline reading, and colouring by kind would compete with state.
- A running card shows work, elapsed time, author, subject, progress sentence, and progress bar. The terminal and the session identifier stay behind a disclosure.
- Work the Queue calls Active with no agent session yet still lands in Running, so a task cannot vanish between starting and reporting.
- The status bar carries only live state: connection, agent capacity, whether GitHub writes are enabled, and repository failures. Fixed configuration sits in the footer.
- Queue order reflects engine priority. Position is always visible.
- Every repository, pull request, issue, commit, automated review, and agent identifier links to its source.
- Completed reviews are History. They never appear as running agents.
- The workflow map separates implemented paths, Harlan decisions, and missing service paths. Dashed borders there are load bearing.
- Skip link, entity link, status ramp, zone header, and live dot live in `main.css`, not in per page scoped blocks, because every page needs them identically.
- The tab title carries the decision count and the favicon carries its colour, because this page is meant to be watched from another window. Notifications are opt in behind the bell, and the first snapshot after load only seeds the baseline so opening the page never fires one.
- Agent activity is ephemeral and in process. It answers what an agent is doing now, not what it did. Keeping it out of the journal means no schema, no retention policy, and nothing to leak after a restart.
- Command output is redacted in the service before it reaches the dashboard. Loopback binding and a dashboard password are not a reason to ship raw stdout that can contain installation tokens.
- Keyboard: `j` and `k` move through the Needs you column and `a` approves the focused card, listed under the board. `/` focuses the repository filter on Watching, where that filter lives.
- Notifications fire on a new decision. Failures are visible in Done and on History, so they raise a badge rather than a notification.
- The Agent selection is a control, not configuration, so it sits with Pause in the header. The button carries the current Agent provider and the menu carries the model and the reasoning effort. The menu also offers Follow configuration, so a pin is never a one way door. The footer keeps the resolved per-role model list, because that answers a different question: what each role will run.
- Pause, global or per repository, stops new claims only. Work already running keeps its lease and finishes. Pause is not cancel, and the two controls stay distinct.
- Presentation logic lives in `app/utils/dashboard.ts`, not in the page. It is pure, takes its clock and engine state as arguments, and is unit tested. Shared state and every write live in `app/composables/useDashboard.ts`. Pages keep only their own layout and filters.
