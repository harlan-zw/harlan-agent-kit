# Responsive Design

Mobile-first, content-driven responsive patterns.

---

## Mobile-First

Start with base styles for mobile, use `min-width` queries to layer complexity. Desktop-first (`max-width`) means mobile loads unnecessary styles first.

In Tailwind, unprefixed classes are mobile; `sm:`, `md:`, `lg:` add complexity upward.

---

## Breakpoints: Content-Driven

Don't chase device sizes. Start narrow, stretch until the design breaks, add a breakpoint there. Three breakpoints usually suffice — Tailwind's `sm` (640), `md` (768), `lg` (1024) cover most cases.

Use `clamp()` for fluid scalar values (padding, type, gap) without breakpoints:

```css
/* Fluid padding: 1rem at 320px → 3rem at 1280px */
.section { padding: clamp(1rem, 0.5rem + 2vw, 3rem); }
```

For grid *layouts* without breakpoints, use `auto-fit + minmax` instead — columns decide their own count based on available width. See [spatial.md](spatial.md) "Self-Adjusting Grid".

---

## Detect Input Method, Not Screen Size

Screen size doesn't tell you input method — laptops have touchscreens, tablets have keyboards.

```css
/* Fine pointer (mouse, trackpad) */
@media (pointer: fine) {
  .button { padding: 8px 16px; }
}

/* Coarse pointer (touch) */
@media (pointer: coarse) {
  .button { padding: 12px 20px; }
}

/* Only add hover effects if device supports hover */
@media (hover: hover) {
  .card:hover { transform: translateY(-2px); }
}
```

**Critical**: Don't rely on hover for functionality. Touch users can't hover.

---

## Safe Areas

Modern phones have notches, rounded corners, home indicators. Enable viewport-fit and use `env()`:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
```

```css
.footer {
  padding-bottom: max(1rem, env(safe-area-inset-bottom));
}
```

---

## Layout Adaptation Patterns

### Navigation
Three stages: hamburger + drawer on mobile → horizontal compact on tablet → full with labels on desktop. Nuxt UI's `UHeader` and `UDashboardSidebar` handle this — use their responsive props.

### Tables
Transform to cards on mobile — Nuxt UI's `UTable` handles responsive display. For custom tables, use `display: block` with `data-label` attributes.

### Progressive Disclosure
Use `<details>/<summary>` or Nuxt UI's `UAccordion` for content that can collapse on mobile.

---

## Responsive Images

```html
<img
  src="hero-800.jpg"
  srcset="hero-400.jpg 400w, hero-800.jpg 800w, hero-1200.jpg 1200w"
  sizes="(max-width: 768px) 100vw, 50vw"
  alt="Hero image"
>
```

Use `<NuxtImg>` with `sizes` prop — handles srcset generation automatically via `@nuxt/image`.

For art direction (different crops, not just sizes):

```html
<picture>
  <source media="(min-width: 768px)" srcset="wide.jpg">
  <source media="(max-width: 767px)" srcset="tall.jpg">
  <img src="fallback.jpg" alt="...">
</picture>
```

---

## Testing

DevTools device emulation misses actual touch interactions, real CPU/memory constraints, font rendering, and browser chrome. Test on at least one real iPhone and one real Android. Cheap Android phones reveal performance issues simulators hide.

---

## Anti-Patterns

- Desktop-first design
- Device detection instead of feature detection
- Separate mobile/desktop codebases
- Ignoring tablet and landscape orientations
- Assuming all mobile devices are powerful
- Hover-dependent functionality without touch fallback
