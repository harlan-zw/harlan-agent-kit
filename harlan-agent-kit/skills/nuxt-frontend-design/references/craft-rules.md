# Craft Rules

Rules that hold on every Nuxt UI site, whatever the theme. A project `DESIGN.md` binds them to its own components. It does not restate them.

Read when you build or review a list, table, dashboard, async state, or custom CSS class.

## Colour budget

Colour is a signal with a fixed attention budget. The more instances on screen, the less colour each one spends.

| Density | Treatment |
|---------|-----------|
| Repeated (3 or more rows, tables, lists) | Coloured dot beside neutral text |
| Singular emphasis (one in a header or card) | Subtle tinted chip |
| Page level or blocking | Neutral surface with a coloured icon or accent |

- Nothing uses a saturated solid fill for status.
- Expected states (Indexed, Ready, Passing) are non-events. Render them neutral.
- A three-way threshold is not three colours. The passing value is a plain numeral. Only failures take a hue.
- Repeated per-row metrics stay neutral text (`212 impr · pos 8`), never a column of tinted badges.
- Encode status once per row. If the icon container carries the colour, do not add a dot beside it. The value slot may repeat the colour, because it states quantity, not identity.
- Coloured trends live in the page's primary artifact only. Supporting and detail trends render neutral.
- A red count must mean "you must act". Split failures the user cannot fix into a neutral signal.

## Hierarchy

- One pop per viewport. At any scroll position one element dominates. Demote a competitor by position, size, or weight. Colour is the last carrier.
- A column where every visible row reads the same carries no signal. Cut it, or move it to the detail view.
- Repeated rows show paths, not absolute URLs. Every row shares one origin. Keep the full URL in `title`.

## Async and missing data

- Loading is not a clean bill. Never render `0` while the query behind it is in flight.
- Gate a summary on every query that feeds it. An errored query also opens the gate, so a failure shows what it has.
- Check the error branch before every empty or "connect" branch. A failed fetch shown as "no data yet" lies about the user's setup.
- Missing is not zero. Render an unknown value as absent or `null`, never as `0`.
- A capped count says so (`200+`). A cap never reads as a total.
- Show a percentage only for measured progress. Opaque work shows stable copy and elapsed time.
- A loading state keeps the loaded footprint. Render the real chrome with skeleton bars where data lands, so nothing shifts.
- Keep previous data visible while a refetch runs. Flashing empty then full fails review.
- A sparkline or trend needs a series in the same measure as its value, comparable across points. With no honest series, ship none.

## Motion

- A chart animates once on first reveal, then stands still. It never re-animates on hover, filter, or refresh. Pointer tracers are the exception.
- Every pure CSS animation or transition joins the site's `prefers-reduced-motion` block. motion-v gates only its own animations.
- An animated element ends opaque and untransformed, so `animation: none` still shows the final state.

## Navigation

- Navigate with `NuxtLink :to`. Never `@click` with `router.push` for navigation. A link must work before hydration and on middle click.

## Contrast

- Nuxt UI's stock 500 shades fail AA as text on white. Amber measures about 2.15:1 and emerald about 2.5:1.
- If a status or primary colour is text on a light surface, step it down to the lightest AA stop. Success and warning usually land on 700, info and error on 600.
- Keep the stock ramp for fills, tints, borders, and chart marks. Text on the page was the contrast problem.
- `text-dimmed` is tertiary metadata only. Never use it for primary content or a label. Measure it in dark mode, where it fails first.
- Contrast is size independent below 18.66px bold. Shrinking text never earns a lower ratio.
- Nuxt UI draws focus with `outline-primary/25`. If `primary` is dark or neutral, that ring fails the 3:1 focus bar. Restore full opacity with one rule.

## CSS gotchas

- Put custom classes in `@layer components`. Unlayered CSS beats every Tailwind utility, so a call site can no longer override it.
- An unlayered base rule such as `p { text-wrap: pretty }` silently defeats utilities like `truncate` on every `<p>`.
- Do not use `text-box` (leading trim) on text that can truncate. With `overflow: hidden` it clips descenders.
- Never write `*/` inside a CSS comment, for example `--wght-*/--wdth-*`. It closes the comment and breaks the parse.
- Use `content-visibility: auto` only with `contain-intrinsic-size`. Without it the scrollbar jumps as sections render.

## Dates

- Do not format a stored calendar date with `Intl.DateTimeFormat` short months. Locales disagree: `en-AU` writes `Sept` where `en-US` writes `Sep`.
- `new Date('2024-11-25')` parses as UTC midnight. West of UTC it prints 24 November. Split the ISO string instead.
