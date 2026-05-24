# CSS Toolkit

Native CSS features most interfaces leave on the table. Prefer these over JS polyfills or custom tokens when the design calls for the effect they provide.

For palette construction (OKLCH axes, tinted neutrals, 60-30-10), see [color.md](color.md). This file covers derivation techniques and non-colour CSS wins.

---

## Text Wrapping

```css
h1, h2, h3 { text-wrap: balance; }   /* even line lengths in short headings */
p          { text-wrap: pretty; }    /* avoids orphans in body copy */
```

`balance` is for ≤ 6 lines of heading; `pretty` is for prose. Both are free wins and fix most "that last line looks weird" complaints without manual line breaks.

---

## Deriving Colour, Not Inventing It

When you need a tone that isn't in the design system, derive it from an existing token. Never pick a new hex by eye.

```css
.surface {
  /* Lighter / darker without leaving the hue */
  background: color-mix(in oklch, var(--ui-primary) 70%, white);
}
.surface-dim {
  background: color-mix(in oklch, var(--ui-primary) 80%, black);
}
.surface-wash {
  /* Translucent overlay from a brand colour */
  background: color-mix(in oklch, var(--ui-primary) 12%, transparent);
}
```

For brand-new shades, stay in OKLCH and vary one axis at a time:

```css
:root {
  --accent:        oklch(62% 0.18 250);
  --accent-muted:  oklch(62% 0.08 250);   /* lower chroma, same hue */
  --accent-subtle: oklch(92% 0.04 250);   /* lighter + lower chroma */
}
```

---

## Container Queries

Components that need to adapt to their slot, not the viewport:

```css
.card-shell { container-type: inline-size; }

@container (min-width: 480px) {
  .card { grid-template-columns: 160px 1fr; }
}
```

Use when the same card renders in a sidebar (narrow) and a main column (wide). `container-type: inline-size` on the parent is mandatory; forgetting it is the top gotcha. Tailwind v4 exposes this as the `@container` variant (`@md:grid-cols-2`) once you mark the parent with `@container`, so prefer the utility form in components.

---

## View Transitions

Single-line upgrade for route and state changes:

```css
@view-transition { navigation: auto; }

.card-image { view-transition-name: hero-image; }
```

Nuxt 4 exposes `$router` view-transition support; match the `view-transition-name` on source and destination elements. Fall back silently on unsupported browsers.

---

## Entry Animations

Default to motion-v's `initial` / `animate` / `exit` for DOM-inserted elements (toasts, popovers, menus, overlays). It handles enter/exit symmetry, interruptibility, and Safari fallback without extra CSS.

Reach for `@starting-style` only when you want zero JS and the animation is trivial:

```css
.toast {
  opacity: 1;
  transform: translateY(0);
  transition: opacity 200ms ease-out, transform 200ms ease-out;

  @starting-style {
    opacity: 0;
    transform: translateY(100%);
  }
}
```

Note: `@starting-style` has no exit counterpart and is Safari 17.5+. For anything with exit animations, spring physics, or staggered children, use motion-v.

---

## `clip-path` for Animation

`clip-path` is underrated as an animation primitive. Because `inset(top right bottom left)` eats into the element from each side, it becomes a declarative way to reveal, wipe, and compare without extra DOM.

```css
.hidden   { clip-path: inset(0 100% 0 0); }   /* fully clipped from right */
.visible  { clip-path: inset(0 0 0 0); }
```

### Hold-to-delete / fill-on-press

Overlay a coloured fill inside the button, clipped from the right. Animate to full on `:active` over 2s linear (deliberate). Snap back on release with 200ms ease-out.

```css
.hold-fill {
  clip-path: inset(0 100% 0 0);
  transition: clip-path 200ms ease-out;
}
.hold-button:active .hold-fill {
  clip-path: inset(0 0 0 0);
  transition: clip-path 2s linear;
}
```

### Tabs with perfect colour transitions

Duplicate the tab labels. Style the copy as "active" (different text colour, different background). Clip the copy so only the hovered/active tab shows through, and animate the clip on change. Achieves a single-element colour crossfade that per-tab `transition: color` can never match.

### Reveal-on-scroll

Start at `clip-path: inset(0 0 100% 0)` (hidden from bottom), animate to `inset(0 0 0 0)` when the element enters the viewport. Drive the transition with motion-v's `whileInView`; the clip-path is just the visual shape, motion-v controls the trigger.

### Before/after comparison sliders

Stack two images. Clip the top one with `clip-path: inset(0 var(--split) 0 0)` and bind `--split` to pointer or drag position. No overlay divs, no mask images.

---

## Scroll-Driven Animations

Default to motion-v's `whileInView` for entrance animations; it handles threshold, `once: true`, and Safari without extra wiring.

Pure-CSS `animation-timeline: view()` is a progressive enhancement for cases where you don't want the component to own the animation (e.g. a utility class applied in content/MDX):

```css
@supports (animation-timeline: view()) {
  .reveal {
    animation: reveal linear both;
    animation-timeline: view();
    animation-range: entry 10% cover 30%;
  }
}

@keyframes reveal {
  from { opacity: 0; translate: 0 24px; }
  to   { opacity: 1; translate: 0 0; }
}
```

Leave elements visible by default outside the `@supports` block so unsupported browsers don't hide content.

---

## Anchor Positioning

Use Reka UI (via Nuxt UI `UPopover`, `UTooltip`, `UDropdownMenu`) for all floating positioning; it handles collision detection, flipping, and scroll containment that pure CSS doesn't. CSS anchor positioning (`anchor-name` / `position-anchor`) is worth knowing but Safari is late; reach for it only when you need a decorative connector outside a Reka primitive.

---

## Grid Techniques Worth Using

```css
/* Content-aware columns without media queries */
.auto-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
}

/* Subgrid for card alignment inside a parent grid */
.card { display: grid; grid-template-rows: subgrid; grid-row: span 3; }
```

`auto-fit + minmax` replaces most responsive grid breakpoints. `subgrid` aligns headings/bodies/footers across sibling cards.

---

## When Not to Use These

- Don't reach for scroll-driven animations on above-the-fold content — users see the animation before the first paint finishes and it feels broken.
- Don't use `view-transition` for route changes longer than ~400ms; it amplifies perceived latency.
- Don't use container queries on leaf elements that only ever render in one context — it's overhead for no reason.
