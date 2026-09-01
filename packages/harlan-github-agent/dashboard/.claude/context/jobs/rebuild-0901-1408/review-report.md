---
verdict: PARTIAL
failed_criteria: []
failed_files: []
categories: []
---

verdict: PARTIAL

## PARTIAL — 2026-09-01 (re-review after repair)

Job `rebuild-0901-1408`. REVIEW_ROOT `/home/harlan/pkg/harlan-agent-kit.feat-dashboard-redesign/packages/harlan-github-agent/dashboard`. Base `2670f98e` (origin/main). Handoff `schema_version` 4, `theme_name` custom, graded against `DESIGN.md` (`## Design Decisions` settled). Read 63/63 changed files under `dashboard/` and `test/` (26 tracked, 37 untracked; job dir excluded).

No hard rejection. No rubric violation. Zero defects to repair. The verdict is PARTIAL, not PASS, only because four contract criteria (B10, B12, H8, W8) cannot be rendered by the dev mock and were graded on unit tests plus template inspection. Every attempt to inject an empty or overflow snapshot from the browser side (`route.fulfill`, `addInitScript`) is unsupported by the `dev-browser` sandbox, and the reviewer never edits code or the mock.

Dev server: `NUXT_IGNORE_LOCK=1 pnpm dashboard:dev --port 4817` from the package root, started fresh for `default`, `calm`, `stale`, `paused` and four further default runs; killed at the end (`fuser 4817/tcp` empty, no `nuxt dev dashboard` process). Logs `review3-dev-server*.log`: zero `[error]`, `[warn]`, `[Vue warn]`, hydration, or resolve lines on every run. Browser: `dev-browser --browser review3 --headless` (Chromium), 1440 and 375 on every route, 768 and 1280 where the contract names them, light and dark.

### Previous findings, re-verified

| # | Finding (previous pass) | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Outcomes chart per-row scale | Fixed | `app/utils/stats.ts:141` `outcomeScale` = max over both periods (68); `app/pages/_StatsOutcomeChart.vue:27` to `:28` pass `scale` to every bar. Rendered widths: 20→29.4%, 34→50%, 4→5.9%, 15→22.1%, 58→85.3%, 68→100%. A 4 no longer draws as long as a 34. |
| 2 | Title drops the Needs you count on `/stats`, `/flow` | Fixed | `app/composables/usePageTitle.ts:7` to `:11` is the one `useHead({ title })`; pages pass only their name (`stats.vue:120`, `flow.vue:8`, `history.vue:99`, `watching.vue:108`, `index.vue:73`). Direct loads: `(2) Stats · Harlan GitHub Agent`, `(2) How it works · Harlan GitHub Agent`. Client navigation Board→Stats→History→Board→Watching→Stats→Board→Flow→Board: every title correct, count kept, name dropped again on Board. |
| 3 | Skip link removed | Fixed | `app/layouts/default.vue:47` `a.skip-link[href="#main"]`, `main.css:104` to `:120`. First Tab from top focuses "Skip to content" (visible at 8,8, `transform: none`); Enter sets `#main` and the next Tab lands inside `main` (Incident row kind button). Full order after it: wordmark, Board, History, Watching, Stats, System chip, Agent selection, Pause, More. |
| 4 | `text-xs` below the 14px floor | Fixed | ripast: `text-xs` ×7, all in `app/pages/kit.vue` (dev page). DOM sweep of every visible text node outside `.field-label` on `/`, `/history`, `/watching`, `/stats`, `/flow` at 1440 and on `/` at 375: zero nodes under 14px. `/flow` max font 14px. |
| 5 | Card state line restates the WorkChip | Fixed | `app/utils/dashboard.ts:394` Queued line is `Starts when an agent is free.`; `runningPhaseLine` (`dashboard.ts:410` to `:416`) drops a phase equal to the chip label. Rendered Running card: `Repair · live dot · 6m 10s · Edited src/runtime/sitemap/urlset.ts · 3 minutes ago`; no second "Repair". Slideover text for 418 is one sentence pair with no repeated "starts review"; DetailList has no Work/Phase rows (`_BoardCardSlideover.vue:76` to `:115`). Done cards show badge and identity only (`_BoardCard.vue:211` to `:226`). Flow lane count pills gone (only Known gaps keeps `2`). |
| 6 | Stats headline restates the Outcomes row | Fixed | No `.text-lg` on `/stats`; `stats.vue:126` to `:198` has no headline; Review row Results reads `27 READY, 11 PENDING, 7 BLOCKED` (`stats.ts:198`). |
| 7 | System chip amber while loading | Fixed | `app/utils/system.ts:67` to `:69` returns `Loading` when `generatedAt` is empty; `SystemChip.vue:37` to `:40`. With `/api/state` delayed 4s: chip `…`, grey dot `oklch(0.3 0.008 80)`, not pulsing, aria "System: loading", Pause disabled, Agent selection "Loading", 8 skeletons. After load: `1/4 · 1 Incident`. |
| 8 | Needs you border contrast | Fixed | `_BoardCard.vue:183` `border-warning` (full). Measured: light `rgb(154,103,0)` on card `oklch(0.994)`; dark `rgb(210,153,34)` 6.67:1 on the card, 7.17:1 on the column; column hairline 7.17; state text 7.95. |
| 9 | "Item changed" and eject banner "Dismiss" | Fixed | `dashboard.ts:500` `subject_changed: 'Head commit moved'`, `:510` "Issue changed" for issue operations; unit test "names which GitHub state moved, never an Item". `AppBanners.vue:63` to `:65` button reads `Close`, aria "Close this notice"; verified after Eject. |
| 10 | Watching mock validates after mutating | Fixed | `server/utils/watching-mock.ts:60` to `:64` checks `items` before `updateMock`. Dismiss on `unjs/unhead#731` (not in mock `items`): `POST /api/items/dismiss 404`, modal stays open with "This issue or pull request is no longer tracked. Refresh and retry.", card stays, Needs you count unchanged. |
| 11 | Single-caller global components | Fixed | `app/components/` no longer holds CardSlideover, EvidenceSlideover, IncidentRow; they are `app/pages/_BoardCardSlideover.vue`, `_HistoryEvidenceSlideover.vue`, `_BoardIncidentRow.vue`, imported by their one page. `Sparkline` has two callers (SystemSlideover, kit). Every remaining `app/components/*` has ≥2 callers or is layout-owned (AgentSelectionMenu, AppBanners, KeyboardModal, OverflowMenu, SystemChip, SystemSlideover), which cannot live under `layouts/`. |
| 12 | Coarse pointer anchors | Fixed (with a recorded exception) | `main.css:93` to `:101` now covers `a:not(.entity-link)` and adds `min-width`. Headless Chromium cannot match `pointer: coarse` (CDP `setEmulatedMedia` features and a touch context are both unavailable in the sandbox), so the block was injected unconditionally at 375: kebab 44×44, avatar link 44×44, filter pills 44 tall, zero non-entity controls under 44px, no overflow. `.entity-link` stays inline text by design (comment at `main.css:92`); that is the WCAG 2.5.8 inline exception. DESIGN.md Responsive Strategy still says "raises every control"; see Observations. |
| 13 | Stats date inputs 28px | Fixed | `stats.vue:134`, `:138` `size="md"`; rendered 40px at 1440 and 375. |
| 14 | S2 amber only without Incident | Fixed as specified | DESIGN.md Chrome now records "Red outranks amber". `calm` scenario + Pause: chip `1/4 Paused`, amber dot `rgb(210,153,34)`, aria "System: 1 of 4 agents running, Paused", header shows solid Resume. Default scenario + Pause: chip stays red `0/4 · 1 Incident` and header shows Resume (documented precedence). |

### Hard rejections

None.

### Rubric violations

None.

### Observations (not counted)

- `DESIGN.md` Responsive Strategy: "`pointer: coarse` raises every control to 44px." The implementation exempts `.entity-link` inline links on purpose (`main.css:92`). Either wording or code should say the same thing; the exemption is defensible (inline links), so record it in DESIGN.md rather than change the CSS.
- Stats range form at 1440 mixes heights in one row: date inputs 40px, Apply 32px, preset pills 28px. Every value sits on the 4pt grid and no rule names button height, so this is polish, not a defect.
- Needs you pull request card reads "Review" three times (chip, "Approval starts Review.", "Review and repair"). The state line is the reason plus consequence and the issue card needs the same sentence ("Approval starts Issue work." beside a plain "Approve"), so it is kept for consistency.
- `_BoardCardSlideover.vue:86` `Task` row prints a 64-character id with no copy control. Provenance on demand is allowed; a copy button would make it useful.
- The Incident row (`_BoardIncidentRow.vue:33` to `:38`) is a clickable `div`; the keyboard path is the kind button inside it, which is correct, so nothing interactive nests.

### Contract Scorecard

Contract has 77 criteria (S 11, B 21, H 13, W 12, T 13, F 5, K 2). 73 PASS, 4 PARTIAL, 0 FAIL.

Shell
- ✅ PASS [S1]: `header` 48px on every route; `footer` count 0; no status bar element.
- ✅ PASS [S2]: `calm` + Pause: chip amber `1/4 Paused`, header solid Resume. With an Incident open, red outranks amber per DESIGN.md Chrome.
- ✅ PASS [S3]: chip `1/4 · 1 Incident`, dot `rgb(207,34,46)`, aria "System: 1 of 4 agents running, 1 Incident".
- ✅ PASS [S4]: slideover 480px, headings Capacity, Incidents, Routines (`v-if="routines.length > 0"`, `SystemSlideover.vue:123`), Terminal behind `<details>`, focus moves inside.
- ✅ PASS [S5]: menu lists Selection mode (Auto, Manual), Notifications, Theme, Keyboard, How it works (`a[href="/flow"]`), Restart after current work.
- ✅ PASS [S6]: at 375 `nav[aria-label=Pages]` is `display: none`; header holds wordmark, chip, More; the menu adds Board, History, Watching, Stats, Pause.
- ✅ PASS [S7]: `stale` scenario: banner "Last update 2 minutes ago. The board may have moved on." with Reload; `main .stale` opacity 0.55.
- ✅ PASS [S8]: `(2) …` on every route, direct load and client navigation; `(1) …` after one approval; `(n)` dropped when Needs you is empty (`calm`).
- ✅ PASS [S9]: SSR HTML of `/` contains Needs you, Up next, Running, Done.
- ✅ PASS [S10]: dark `--ui-bg` `oklch(17% 0.006 80)`; solid button paper `oklch(0.962)` on ink `oklch(0.17)`, 17.11:1.
- ✅ PASS [S11]: Tab order: Skip to content, wordmark, Board, History, Watching, Stats, System chip, Agent selection, Pause, More.

Board
- ✅ PASS [B1]: two Needs you cards, one solid button each: "Review and repair" (pull request), "Approve" (issue); `solidButtonsPerCard` = 1 for both, 0 elsewhere.
- ✅ PASS [B2]: `j` focused 418 (focus ring 2px ink, 2px offset), `j` 731, `k` back; `a` sent exactly one `POST /api/approvals` (200); Needs you 2→1, Up next 2→3, title `(1)`.
- ✅ PASS [B3]: 418 menu: Open on GitHub, Dismiss (error colour, last), no Cancel. Running 412: Open on GitHub, Cancel task, Dismiss. Queued 420: Open on GitHub, Dismiss.
- ✅ PASS [B4]: modal "Dismiss this pull request? | This pull request will never run again, and any running work on it stops now. | Cancel (ghost) | Dismiss (solid error)". Confirming 418 posted `/api/items/dismiss` 200; card left Up next (3→2); Watching then showed it under Dismissed.
- ✅ PASS [B5]: positions `04`, `05` in mono in Up next.
- ✅ PASS [B6]: `#421` under Waiting, dashed border, "Blocked on a draft.", no position.
- ✅ PASS [B7]: Running card: Repair chip, live dot (`live-pulse` 2s), elapsed, latest activity, Eject arms to "Confirm eject" then posts `/api/agents/eject` 200; banner with copyable ssh command, Copy and Close; Running reads "No agent is running."
- ✅ PASS [B8]: "No progress for 2m" rendered once the mock agent's last report passed 120s.
- ✅ PASS [B9]: Running face opens slideover with `.terminal` (`$ pnpm test --filter sitemap exit 1 …`), DetailList Repository, Head commit (link), Agent provider, Elapsed, Task, Session; focus inside; Copy session id.
- ⚠️ PARTIAL [B10]: mock holds 5 Done records. `doneOnBoard = 8` and unit test "holds eight Done cards and reports the full total"; link template `index.vue:176` to `:178`. Not rendered in the browser.
- ✅ PASS [B11]: `calm`: "Needs you, 0 | Nothing needs you.", column stays, hairline 0px.
- ⚠️ PARTIAL [B12]: `columnEmptyReason` Paused variant (`dashboard.ts:356`) plus unit test "offers Resume only when Pause is the cause"; Resume template `index.vue:143` to `:154`. The mock always has queued entries, so the empty Up next was not rendered. Paused with entries shows "Paused. Nothing starts until you select Resume." on each card.
- ✅ PASS [B13]: one row above the columns: "GitHub access | unjs/unhead | GitHub answered 403 … | Retrying · retry 2 | 3× | 4 minutes ago"; kind button opens System.
- ✅ PASS [B14]: four kinds present, filter shows All, Review, Repair, Conflict resolution, Issue work; hidden by `v-if="workKinds.length > 1"` and unit test.
- ✅ PASS [B15]: `/api/state` delayed: 8 skeletons; SSR HTML carries `animate-pulse`.
- ✅ PASS [B16]: `/api/state` aborted: banner "State could not load: … Check the local service." with Retry within 1s; Retry restored 11 cards.
- ✅ PASS [B17]: at 375 columns stack at x=24, tops 226, 703, 1209, 1477 in order; `scrollWidth` 375.
- ✅ PASS [B18]: at 768 two per row; at 1280 and 1440 four across.
- ✅ PASS [B19]: SSR HTML contains "Needs you".
- ✅ PASS [B20]: dark: card border 6.67:1, column hairline 7.17:1, state text 7.95:1, dimmed text on card 4.83:1.
- ✅ PASS [B21]: each column is `section[role=region]` labelled by an sr-only "Needs you, 2" span.

History
- ✅ PASS [H1]: divided rows 44 to 59px, `article` count 0.
- ✅ PASS [H2]: Evidence for 412: Review gates (Merge, Review, CI Passed), Findings, Agent `codex · gpt-5.6-sol · 1.4.2`, Review usage, Session, Head commit link, Review comment link, Finished, Took.
- ✅ PASS [H3]: Useful enabled, Noisy and Wrong disabled until a reason is typed, then all enabled.
- ✅ PASS [H4]: kit#122 shows "Useful · 7 hours ago · Caught the missing null guard before merge." with no textarea; after recording Useful on 412 the form was replaced by "Useful · just now".
- ✅ PASS [H5]: Ready: 3 rows, heading count 3.
- ✅ PASS [H6]: `?from&to&work=adversarial_review`: "Showing the Stats range." with Clear, 3 rows; Clear navigates to `/history`, 6 rows.
- ✅ PASS [H7]: 412 (current head) menu: Open on GitHub, Rerun review (posted `/api/reviews/rerun` 200); 418 (old head): Open on GitHub only.
- ⚠️ PARTIAL [H8]: `history.vue:51` to `:53` and `emptyLine`; the mock always has records.
- ✅ PASS [H9]: at 375 `scrollWidth` 375; badge top 189, identity top 241 (wrapped under); zero overflowing elements.
- ✅ PASS [H10]: at 768 the slideover measures 768px.
- ✅ PASS [H11]: SSR contains "History".
- ✅ PASS [H12]: dark badges READY 9.0, Completed 9.0, BLOCKED 7.32, Failed 7.32, PENDING 9.04; chips 10.98; dimmed text 5.49.
- ✅ PASS [H13]: focus row button, Enter: dialog open, focus on Close inside it.

Watching
- ✅ PASS [W1]: container `overflow-x: auto`; at 375 table scrolls (795 in 327), page `scrollWidth` 375.
- ✅ PASS [W2]: kit: Pause, Enable writes; nuxt-seo: Pause, Disable writes.
- ✅ PASS [W3]: modal "Enable writes for harlan-zw/harlan-agent-kit? | Agents can push branches and write comments on this repository." one solid button; confirm posted `/api/repositories/writes/enable` 200, cell reads Enabled.
- ✅ PASS [W4]: `/` focused `input[aria-label="Filter repositories"]`; typing "zzz" gives "No repository matches "zzz"."
- ✅ PASS [W5]: Issues: "No open issues.", count 0; Pull requests: 2.
- ✅ PASS [W6]: absent initially; after dismissing 418 a Dismissed group with Restore appeared; Restore removed it, Open back to 2.
- ✅ PASS [W7]: tab "Watching 1" with error badge.
- ⚠️ PARTIAL [W8]: filter-empty line verified; the no-repositories line (`watching.ts:29`) is unit-tested only.
- ✅ PASS [W9]: at 768 Repositories (y 72) and Open (y 352) stack at x=24.
- ✅ PASS [W10]: SSR contains "Repositories".
- ✅ PASS [W11]: dark Healthy 9.0, Action required 7.32.
- ✅ PASS [W12]: sr-only caption and eight `th[scope=col]`.

Stats
- ✅ PASS [T1]: `/stats` became `/stats?from=2026-08-03&to=2026-09-01`.
- ✅ PASS [T2]: 90 preset: URL `from=2026-06-04`, second `/api/stats` request.
- ✅ PASS [T3]: from 2026-08-20, to 2026-08-10, Apply: "The end date must follow the start date.", zero requests, URL unchanged.
- ✅ PASS [T4]: skeleton region "Loading Stats" with 3 skeletons while pending.
- ✅ PASS [T5]: aborted `/api/stats`: Retry shown, sections 0; Retry restored 3 sections.
- ✅ PASS [T6]: January range: "No completed work exists in this range." with Show 90 days; click set the 90 day URL.
- ✅ PASS [T7]: no `p`/`figcaption` under either chart; every bar width or height is `barWidth(value, max)` from zero; 0 draws `0%`.
- ✅ PASS [T8]: Evidence links `/history?from=…&to=…&work=pull_request_triage` and five more.
- ✅ PASS [T9]: daily region `role=region`, `tabindex=0`, `overflow-x: auto`; at 375 the 7 day range fits (84px), the 30 day range needs 360px in 327px and scrolls inside; page width 375.
- ✅ PASS [T10]: at 768 Outcomes at x=24 and Outcomes per day at x=404, same top.
- ✅ PASS [T11]: SSR contains "Stats".
- ✅ PASS [T12]: dark bars `oklch(0.962)` 8px vs `oklch(0.3)` 4px.
- ✅ PASS [T13]: Tab order from, to, 7 days, 30 days, 90 days, Apply.

Flow
- ✅ PASS [F1]: no `<style>` block in `app/`; `h1.field-label`, six `h2.field-label`; no uppercase outside `.field-label`.
- ✅ PASS [F2]: How it works is `a[href="/flow"]`; click landed on `/flow`.
- ✅ PASS [F3]: at 375 six sections at x=24; zero overflowing elements.
- ✅ PASS [F4]: SSR contains "Pull request".
- ✅ PASS [F5]: dark markers: solid `oklch(0.36)`, solid amber `rgb(210,153,34)`, dashed red `rgb(248,81,73)`.

Kit
- ✅ PASS [K1]: every swatch shows ratios; text tokens at or above 4.61 (light) and 4.83 (dark); status text at or above 5.75.
- ✅ PASS [K2]: `nuxt.config.ts` prerender routes exclude `/kit` and `ignore: ['/kit']`; no `/kit` link in `app/`; `/kit` page has no internal links. The generate step was verified in the previous pass; the config is unchanged since.

### Self-Assessment Comparison

- Generator confidence: medium. Weakest area named: empty and overflow board states (B10, B12, H8, W8) unit tested only. Accurate.
- Marked partial, found met: S7, B8, T5.
- Marked met, found partial: B12, H8, W8 (mock-unreachable, same as the previous pass).
- Self-assessment failures (marked met, found FAIL): none.

### Every Element Earns Its Place (per screen)

- Board: no restated copy left. Running card shows chip, elapsed, latest activity, stall warning. Queued line names only the condition. Done cards are badge plus identity. Loading chip shows `…` with no reason. Dismiss on an untracked entry is refused by the mock and the error has a home in the modal.
- Card slideover: one reason sentence plus one consequence sentence; DetailList holds Repository, Head commit, Agent provider, Elapsed, Task, Session; terminal shows text, never a percentage.
- History and Evidence: nothing restated.
- Watching: nothing restated.
- Stats: no headline, no captions, Results text no longer duplicates the Outcomes rows.
- Flow: lane count pills removed; Known gaps keeps its count.
- Shell: overflow menu descriptions explain a choice the labels alone do not; kept.

### Mechanical results

- Class-token inventory (`pnpm dlx @ripast/cli css-class-scan --glob 'app/**' --sort count-desc --json`): 294 tokens. `slate-`/`gray-`/`zinc-`/`stone-`/`bg-white`/`text-black`/raw hue utilities: 0. Banned fonts: 0. `shadow-lg` ×3 and `shadow-none` ×1, all in `app.config.ts` overlay slots: allowed. `text-lg` ×1 (`kit.vue:174`, the type scale sample). `text-xs` ×7, all `kit.vue`. `uppercase` ×1 in `StateBadge.vue` (Review outcomes) plus `.field-label` in `main.css`: allowed. `animate-[fade-in…]`/`[fade-out…]` overlays only.
- Hex: `main.css:39` to `:41`, `:63` to `:65` (token definitions); `useDocumentStatus.ts:10` to `:12`, `:22` (favicon data URI, commented). No hex in `.vue` files. No `rgb(`/`hsl(`.
- Custom tokens in `main.css`: `--ease-out`, `--default-transition-duration`, `--default-transition-timing-function`, `--status-mix`. None duplicates a `--ui-*` variable.
- TODO/FIXME/placeholder/Lorem: none. `<style>` blocks: none. Emoji: none (`✓` dingbat in kit's sample terminal). Lucide/Heroicons: none. `/kit` links: none.
- Dead code (`pnpm dlx @ripast/cli unused --tsconfig .nuxt/tsconfig.json --exports local --json`): hits only under `.nuxt/`; nothing under `app/`.
- Component locality: no single-caller page-owned component in `app/components/`.
- `pnpm lint`: `eslint .` exit 0.
- `pnpm typecheck`: `tsc --noEmit && nuxt typecheck dashboard` exit 0.
- `pnpm test:run`: `Test Files  102 passed (102)`, `Tests  1163 passed (1163)`, `Duration  7.44s`.
- Dev server logs: clean on every run. Console: zero errors on every route in normal use; the only 4xx is the intended `POST /api/items/dismiss 404` for the untracked entry.
- axe (wcag2a, wcag2aa, wcag21aa, best-practice) on `/`, `/history`, `/watching`, `/stats`, `/flow`: the only violation is `region` (moderate) on Nuxt DevTools' own `nuxt-devtools-frame`; zero app violations; `page-has-heading-one` cleared.

### What was verified

- Dev server started fresh per scenario, health-checked with curl, killed at the end.
- SSR HTML curled for all six routes: 200, `#__nuxt` present, no `nuxt-error`, skip link in the markup of every layout route, titles correct.
- Screenshots for every route at 1440 and 375 (light and dark for Board, History, Watching, Stats, Flow; Kit dark), plus DOM measurement at 768 and 1280 (33 files `~/.dev-browser/tmp/r3-*.png`).
- Exercised: every overflow menu (card, row, repository, header), ConfirmModal (Dismiss ×2, Cancel task, Enable writes), card slideover ×3, Evidence slideover ×2, System slideover, Agent selection menu, KeyboardModal, keyboard j/k/a/?, `/` on Watching, Tab from the top and the skip link, the Stats form (presets, Apply, invalid range, failure and Retry, empty state, Show 90 days), Pause/Resume (default and calm), Eject arm and confirm, banner Close, Dismiss (refused and accepted), Restore, Approve, Rerun review, Agent feedback.
- Contrast measured in-page (canvas-resolved colours) for both modes on Board, History, Watching, Flow and every token pair on `/kit`.
- Loading and error states with `/api/state` delayed and aborted; loading chip state.
- Coarse-pointer rule verified by injecting the block unconditionally (media match itself cannot be emulated here).

### Next Steps

No code repair is required. To turn PARTIAL into PASS, give the dev mock scenarios that reach the four unrendered states (`DASHBOARD_MOCK_SCENARIO=empty` with no records, no repositories, Paused with an empty queue; `overflow` with nine or more Done records), then re-run `/nuxt-frontend-review rebuild-0901-1408`. Optionally record the `.entity-link` coarse-pointer exception in DESIGN.md Responsive Strategy.

### Decision Log

- Broken feature: every control clicked produced a state change, navigation, or visible feedback (listed above). Verdict: pass.
- Build/runtime error: dev logs clean on eight runs, lint, typecheck, tests green, zero console errors. Verdict: pass.
- Invisible content: none; sr-only spans intentional. Verdict: pass.
- Unreadable text: kit measures every text token at or above 4.61:1 in light and 4.83:1 in dark; targeted measurements on cards, badges, and rows agree. A whole-page sweep of `.text-muted` produced values near 1.0 and was discarded: the probe composited semi-transparent tints (`bg-error/5`) as opaque, a probe bug, not a page bug; the affected texts measure 4.9 to 6.0 against the underlying paper. Verdict: pass.
- Layout break: 375, 768, 1280, 1440 without horizontal scroll or overflow on every route. Verdict: pass.
- Missing state handling: loading and error verified on Board and Stats; History and Watching skeletons render behind `loading`. Verdict: pass.
- Theme incoherence: paper neutrals, ink primary, semantic colour only on badges, dots, hairline, Incident row. Verdict: pass.
- Unnecessary custom tokens: none new. Verdict: pass.
- Token drift: `design_system_changes: true`; expected.
- Dataviz: Outcomes rows share one scale; daily bars scale to the period maximum from zero; no legend, no gridlines, direct labels only where they fit; table numerics right-aligned with `tabular-nums`. The Work table's per-row run bar (`_StatsWorkTable.vue:46`) uses its own maximum (runs), which is one series, so not a lie factor. Verdict: pass.
- S2: PASS on the calm scenario; the Incident-present case follows the precedence now written in DESIGN.md Chrome.
- B10, B12, H8, W8: PARTIAL. Browser injection was attempted four ways (`route.fetch`, `route.fulfill`, `addInitScript` as function and as string) and the sandbox rejects each; the reviewer does not edit the mock. Unit tests plus the one-line templates are the evidence.
- T9: the 7 day range does not need to scroll; the mechanism (min-width `columns × 0.75rem`, `overflow-x: auto`, `tabindex=0`) is verified and the 30 day case was observed scrolling in the previous pass. Kept PASS.
- K2: prerender config and link grep verified this pass; the generate output was verified in the previous pass with the same config. Kept PASS.
- Coarse pointer: media match unverifiable; the rule's effect verified by unconditional injection; `.entity-link` exemption accepted as the inline-link exception and recorded as an observation.
- Stats form heights and the Needs you triple "Review": considered, recorded as observations, not counted (no rule broken).
- Screenshot mid-run state: the `mut` page mutated the shared mock (approve, dismiss, eject, writes, pause, rerun, feedback); structural measurements that depend on the initial state (B20, S2, S7, S8) used fresh server runs.
