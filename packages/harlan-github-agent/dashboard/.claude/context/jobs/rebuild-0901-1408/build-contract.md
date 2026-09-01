# Build contract: dashboard rebuild (rebuild-0901-1408)

Spec: `DESIGN.md`. Vocabulary: `../GLOSSARY.md`. Data: `src/types.ts` (`DashboardSnapshot`), state and writes in `app/composables/useDashboard.ts`, pure presentation in `app/utils/dashboard.ts`.

Every page is rebuilt from scratch on the new foundation (Phase 1). Keep the composable contract and pure utils; add to them, remove dead branches, keep tests green in `test/dashboard-view.test.ts`, `test/stats-view.test.ts`, `test/hogwild-status.test.ts`, `test/eject-recovery.test.ts`. A behaviour changed on purpose deletes its old test and writes the new one.

## What will be built

### Shell (`app/layouts/default.vue`, `app/app.vue`, `app/components/`)

- 48px header: wordmark; tabs Board, History, Watching, Stats (below `md` the tabs move into the overflow menu).
- `SystemChip.vue`: `n/3` agents, state dot (grey normal, amber cannot start with reason, red Incident count). Opens `SystemSlideover.vue`.
- `SystemSlideover.vue`: Capacity, Incidents, Routines (only when present), Host (only on the Tailscale host). Disclosures for Routine candidates and terminal.
- `AgentSelectionMenu.vue`: button shows current provider; menu shows models, Reasoning effort, `Follow configuration`, `Automatic`, and a read only per-role model list.
- Pause / Resume button.
- `OverflowMenu.vue`: Selection mode (Auto / Manual), Restart after current work, Notifications (opt in toggle), Theme, Keyboard, How it works (`/flow`).
- Banners kept: stale snapshot (after 90s, content gets `.stale`), eject notice with copyable command, restart request state.
- Tab title carries the Needs you count; favicon carries its colour. Skip link kept.
- No status bar, no footer.

### Board (`app/pages/index.vue` + `_Board*.vue` locals)

- `IncidentRow` above columns when any unresolved Incident exists: kind, scope link, message, Recovery, occurrences, age. Links to the System slideover.
- Work kind filter, hidden until two kinds are present.
- Four columns on `bg-muted` surfaces: Needs you, Up next (Queued with position; Waiting group below for Pending, dashed cards), Running (agents plus Active entries with no session), Done (eight, then a link to History).
- `BoardCard.vue`: face per DESIGN.md "Cards". Primary action inline for Needs you (`Review and repair` / `Approve`). `Eject` inline on Running (arm then confirm). Overflow menu: Open on GitHub, Rerun review (only when `canRunReview`), Cancel, Dismiss. Cancel and Dismiss open `ConfirmModal.vue`.
- `CardSlideover.vue`: full reason, `DetailList` (session, commit, agent, revision as links), terminal (`.terminal`), actions.
- Empty column copy from one pure function (`columnEmptyReason`) replacing the duplicated `nothingQueuedReason` / `queueDetail` mapping. Resume control inline when Paused.
- Keyboard: `j` `k` through Needs you, `a` presses its primary action, `?` opens the keyboard list.

### History (`app/pages/history.vue`)

- Outcome filter pills, Stats range strip with Clear when arriving from Stats.
- Divided list rows: outcome badge, work chip, identity, relative time, duration. Row click opens `EvidenceSlideover.vue`: gates, findings, agent (provider, model, version), Review usage, session id with copy, commit link, canonical comment link, Agent feedback (`UTextarea` plus Useful / Noisy / Wrong; hidden once recorded, showing the recorded verdict instead).
- `Rerun review` in the row overflow menu only on the current revision.

### Watching (`app/pages/watching.vue`)

- Repository table in its own scroll container: repository link, health badge, open count, ownership, writes, agents, last success. Writes and Pause controls in a row overflow menu; enabling writes confirms in a modal.
- `/` focuses the filter through a template ref.
- Open items list with All / Pull requests / Issues filter.
- Dismissed group with Restore, only when any exist.

### Stats (`app/pages/stats.vue` + `_Stats*.vue`)

- Range form (two date inputs, 7 / 30 / 90 presets, Apply), URL is the source of truth.
- Outcome chart and daily chart with no captions; the chart title carries the meaning. Bars start at zero, direct labels, no legend, no library.
- Work table with Evidence links into History.
- Loading skeleton, range error, load error with Retry, empty state with `Show 90 days`.

### Flow (`app/pages/flow.vue`)

- Same content, rebuilt on tokens with no scoped CSS beyond what Tailwind cannot express. `.field-label` headings only. Reached from the overflow menu.

## Testable behaviours

### Shell

- [S1] GIVEN any route, WHEN the page renders, THEN one header of height 48px exists and no footer or status bar element exists.
- [S2] GIVEN `agentStart._tag === 'Paused'`, WHEN the header renders, THEN the System chip is amber and reads `Paused`, and the header shows `Resume`.
- [S3] GIVEN one unresolved Incident, WHEN the header renders, THEN the System chip is red and carries `1`.
- [S4] GIVEN the System chip, WHEN clicked, THEN a slideover opens with headings Capacity and Incidents, and Routines only when `routines.length > 0`.
- [S5] GIVEN the overflow menu, WHEN opened, THEN it lists Selection mode, Restart after current work, Notifications, Theme, Keyboard, How it works.
- [S6] GIVEN viewport 375px, WHEN the header renders, THEN the tabs are absent from the header and present in the overflow menu.
- [S7] GIVEN the snapshot is older than 90s, WHEN the board renders, THEN a stale banner shows and board content carries `.stale`.
- [S8] GIVEN two Needs you entries, WHEN the page title is read, THEN it starts with `(2)`.
- [S9] GIVEN SSR, WHEN `/` is fetched without JS, THEN the HTML contains the four column labels.
- [S10] GIVEN dark mode, WHEN any page renders, THEN `--ui-bg` is not pure black and solid buttons are paper on ink.
- [S11] GIVEN keyboard only, WHEN tabbing from the top, THEN the skip link is first, then wordmark, tabs, System chip, Agent selection, Pause, overflow.

### Board

- [B1] GIVEN an AwaitingApproval entry, WHEN the board renders, THEN the card sits in Needs you with one solid button `Review and repair` or `Approve`.
- [B2] GIVEN focus on a Needs you card, WHEN `a` is pressed, THEN the primary action fires once.
- [B3] GIVEN a Needs you card, WHEN its overflow menu opens, THEN it lists Open on GitHub, Cancel (only with a live task), Dismiss, and Dismiss is last and error coloured.
- [B4] GIVEN Dismiss chosen, WHEN the modal opens, THEN it states one consequence sentence and one solid `Dismiss` button; confirming calls `dismissItem` and the card leaves the board.
- [B5] GIVEN a Queued entry, WHEN the board renders, THEN the card shows its position in mono and sits in Up next.
- [B6] GIVEN a Pending entry, WHEN the board renders, THEN the card sits under Waiting with a dashed border, shows the reason, and shows no position.
- [B7] GIVEN a Running agent, WHEN the board renders, THEN the card shows work chip, live dot, elapsed, phase, latest activity, and an inline `Eject` that arms then confirms.
- [B8] GIVEN a Running agent silent for 120s, WHEN the board renders, THEN the card shows a stalled warning.
- [B9] GIVEN any card face, WHEN clicked, THEN a slideover opens with the terminal and a DetailList holding session and commit links.
- [B10] GIVEN nine or more Done records, WHEN the board renders, THEN eight cards show and a link to `/history` follows.
- [B11] GIVEN Needs you is empty, WHEN the board renders, THEN the column stays in place with one line `Nothing needs you.`
- [B12] GIVEN `agentStart._tag === 'Paused'` and nothing queued, WHEN Up next renders, THEN the empty line names Paused and includes a `Resume` button.
- [B13] GIVEN one unresolved Incident, WHEN the board renders, THEN one error row sits above the columns with kind, scope, Recovery.
- [B14] GIVEN only one work kind on the board, WHEN it renders, THEN no filter is shown; with two kinds the filter appears.
- [B15] GIVEN loading, WHEN the first snapshot is pending, THEN skeleton cards render in each column.
- [B16] GIVEN a fetch error, WHEN `/api/state` fails, THEN a banner names the failure and offers Retry.
- [B17] GIVEN 375px, WHEN the board renders, THEN columns stack in order Needs you, Up next, Running, Done.
- [B18] GIVEN 768px, WHEN the board renders, THEN two columns per row.
- [B19] GIVEN SSR, WHEN `/` is fetched, THEN the HTML contains `Needs you`.
- [B20] GIVEN dark mode, WHEN a Needs you card renders, THEN the amber hairline and text pass 4.5:1.
- [B21] GIVEN screen reader, WHEN a column is read, THEN it is a region labelled by its heading and the count is in the accessible name.

### History

- [H1] GIVEN records, WHEN `/history` renders, THEN rows are divided list rows, 44px minimum, no cards.
- [H2] GIVEN a row, WHEN clicked, THEN an Evidence slideover opens with gates, findings, agent, usage, session, commit, comment link.
- [H3] GIVEN a review with no feedback, WHEN evidence opens, THEN Useful / Noisy / Wrong show; Noisy and Wrong require a reason before enabling.
- [H4] GIVEN feedback recorded, WHEN evidence opens, THEN the recorded verdict shows and the form is gone.
- [H5] GIVEN outcome filter `Ready`, WHEN chosen, THEN only READY rows remain and the count updates.
- [H6] GIVEN arrival with `?from&to&work`, WHEN rendered, THEN a range strip shows with Clear; Clear removes the query.
- [H7] GIVEN the current revision, WHEN the row overflow opens, THEN `Rerun review` is present; on an old revision it is absent.
- [H8] GIVEN no records, WHEN rendered, THEN one line `Nothing has finished yet.`
- [H9] GIVEN 375px, WHEN rows render, THEN identity wraps under the badge and nothing overflows.
- [H10] GIVEN 768px, WHEN the slideover opens, THEN it covers the viewport width.
- [H11] GIVEN SSR, WHEN `/history` is fetched, THEN the HTML contains `History`.
- [H12] GIVEN dark mode, WHEN outcome badges render, THEN each passes 4.5:1.
- [H13] GIVEN keyboard, WHEN a row is focused and Enter is pressed, THEN the slideover opens and focus moves inside it.

### Watching

- [W1] GIVEN repositories, WHEN `/watching` renders, THEN the table scrolls inside its own container and the page does not scroll sideways at 375px.
- [W2] GIVEN a repository row, WHEN its overflow menu opens, THEN it shows Pause or Resume and Enable or Disable writes.
- [W3] GIVEN Enable writes chosen, WHEN the modal opens, THEN it states the consequence and confirming calls `setRepositoryWritesEnabled`.
- [W4] GIVEN `/` pressed, WHEN not in an input, THEN the repository filter input receives focus.
- [W5] GIVEN the Issues filter, WHEN chosen, THEN only issues remain in Open.
- [W6] GIVEN dismissed items, WHEN rendered, THEN a Dismissed group shows with Restore; with none the group is absent.
- [W7] GIVEN a repository with `lastError`, WHEN the Watching tab renders in the header, THEN it carries a red count.
- [W8] GIVEN no repositories, WHEN rendered, THEN one line names the cause.
- [W9] GIVEN 768px, WHEN rendered, THEN Repositories and Open stack.
- [W10] GIVEN SSR, WHEN `/watching` is fetched, THEN the HTML contains `Repositories`.
- [W11] GIVEN dark mode, WHEN health badges render, THEN each passes 4.5:1.
- [W12] GIVEN screen reader, WHEN the table is read, THEN it has a caption or aria-label and column headers.

### Stats

- [T1] GIVEN `/stats` with no query, WHEN mounted, THEN the URL gains a 30 day `from` and `to`.
- [T2] GIVEN preset 90, WHEN clicked, THEN the URL updates and data refetches.
- [T3] GIVEN Apply with `from > to`, WHEN submitted, THEN a range error shows and no fetch runs.
- [T4] GIVEN loading, WHEN pending, THEN skeletons show in place of charts.
- [T5] GIVEN a load error, WHEN shown, THEN Retry refetches.
- [T6] GIVEN an empty range, WHEN rendered, THEN one line and a `Show 90 days` button.
- [T7] GIVEN charts, WHEN rendered, THEN no caption text exists under either chart and every bar starts at zero.
- [T8] GIVEN a work table row, WHEN Evidence is clicked, THEN History opens with the matching query.
- [T9] GIVEN 375px, WHEN the daily chart renders, THEN it scrolls inside a focusable container.
- [T10] GIVEN 768px, WHEN rendered, THEN the two charts sit side by side.
- [T11] GIVEN SSR, WHEN `/stats` is fetched, THEN the HTML contains `Stats`.
- [T12] GIVEN dark mode, WHEN bars render, THEN this period and previous period differ by more than lightness alone (ink vs muted).
- [T13] GIVEN keyboard, WHEN tabbing the form, THEN order is from, to, presets, Apply.

### Flow

- [F1] GIVEN `/flow`, WHEN rendered, THEN no scoped `<style>` block exists beyond connector pseudo elements, and headings use `.field-label`.
- [F2] GIVEN the overflow menu, WHEN How it works is chosen, THEN `/flow` opens.
- [F3] GIVEN 375px, WHEN rendered, THEN lanes stack and nothing overflows.
- [F4] GIVEN SSR, WHEN `/flow` is fetched, THEN the HTML contains the pull request lane heading.
- [F5] GIVEN dark mode, WHEN the legend renders, THEN the three marker styles remain distinguishable.

### Kit

- [K1] GIVEN `/kit`, WHEN rendered in dev, THEN every swatch shows its contrast ratio and none intended for text is below 4.5.
- [K2] GIVEN `/kit`, WHEN the build runs, THEN `/kit` is not in `.output/public` prerender output and no page links to it.

## Design expectations

- Tokens only. No hex, no `gray-`/`zinc-`/`slate-`/`stone-`, no shadows outside overlays.
- Type never above 1.125rem. `.field-label` is the only section heading style.
- Semantic colour only on badges, dots, the Needs you hairline, and the Incident row.
- Octicons only, `currentColor`.
- One solid button per card or modal.
- The design principle, "the exception over the inventory", shows as: a board that is mostly paper when nothing needs Harlan, and one amber card that is the most saturated thing on screen when something does.

## Out of scope

- Service or API changes. The dashboard consumes the existing `DashboardSnapshot` and endpoints.
- New pages beyond `/kit`.
- Chart libraries.
- Optimistic updates.
