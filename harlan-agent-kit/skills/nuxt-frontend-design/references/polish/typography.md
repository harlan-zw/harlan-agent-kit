# Typography

Font choices, scale, and rhythm that create character and hierarchy.

---

## Font Selection

See gotchas in `nuxt-frontend-design` for banned font list and rationale.

### Better Alternatives to Overused Defaults

| Instead of... | Try |
|---------------|-----|
| Inter | Instrument Sans, Plus Jakarta Sans, Outfit |
| Roboto | Onest, Figtree, Urbanist |
| Open Sans | Source Sans 3, Nunito Sans, DM Sans |
| Montserrat | Syne, Manrope, General Sans |

### Recommended Pairings

| Style | Display | Body |
|-------|---------|------|
| Editorial | Playfair Display | IBM Plex Sans |
| Technical | JetBrains Mono | Atkinson Hyperlegible |
| Playful | Bricolage Grotesque | Nunito |
| Luxury | Instrument Serif | Satoshi |
| Geometric | Syne | Manrope |
| Industrial | Archivo Black | Outfit |
| Minimal | Crimson Pro | Source Sans 3 |
| Premium | Fraunces | Newsreader |

### Pairing Rules
- One well-chosen font family in multiple weights creates cleaner hierarchy than two competing typefaces
- High contrast = interesting: serif + monospace, display + geometric sans
- Use weight extremes: 100/200 vs 800/900 (not 400 vs 600)
- Size jumps of 3x+ (not 1.5x) — timid contrast looks unintentional
- Never pair similar-but-not-identical typefaces — creates tension without hierarchy

---

## Setup in Nuxt

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  fonts: {
    families: [
      { name: 'Instrument Serif', provider: 'google' },
      { name: 'Satoshi', provider: 'google' }
    ]
  }
})
```

```css
/* app/assets/css/main.css */
@theme {
  --font-display: 'Instrument Serif', serif;
  --font-sans: 'Satoshi', sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
}
```

Use in templates:
```html
<h1 class="font-display text-5xl font-bold">Headline</h1>
<p class="font-sans text-base text-muted">Body text</p>
<code class="font-mono text-sm">code</code>
```

### Font Loading

Use `font-display: swap` for visibility during loading. Match fallback font metrics to minimize layout shift — Nuxt Fonts handles this automatically with `@nuxt/fonts`.

---

## Type Scale

Use fewer sizes with greater distinction — not 14/15/16/18px crawl, but deliberate jumps:

```css
@theme {
  /* Display — hero headlines */
  --font-size-display: 4rem;      /* 64px */
  --font-size-display-sm: 3rem;   /* 48px */

  /* Headings */
  --font-size-h1: 2.5rem;         /* 40px */
  --font-size-h2: 2rem;           /* 32px */
  --font-size-h3: 1.5rem;         /* 24px */
  --font-size-h4: 1.25rem;        /* 20px */

  /* Body */
  --font-size-body-lg: 1.125rem;  /* 18px */
  --font-size-body: 1rem;         /* 16px */
  --font-size-body-sm: 0.875rem;  /* 14px */
  --font-size-caption: 0.75rem;   /* 12px */
}
```

### Fixed vs Fluid Type

- **App UIs, dashboards, data-dense**: Use fixed `rem` scales with optional breakpoints. No major design system (Material, Polaris, Primer) uses fluid type in product UI.
- **Marketing/content pages**: Fluid `clamp()` scales smoothly across viewports:

```css
/* Fluid display: 2.5rem at 320px → 4rem at 1280px */
.display { font-size: clamp(2.5rem, 1.5rem + 2.5vw, 4rem); }
```

---

## Vertical Rhythm

Use `line-height` as the base unit for vertical spacing. With body at `line-height: 1.5` on 16px (= 24px), spacing values should be multiples of 24px. Text and space share a mathematical foundation.

```css
/* Tight for headings */
h1, h2 { line-height: 1.1; }

/* Comfortable for body */
p, li { line-height: 1.6; }

/* Generous for small text */
.caption { line-height: 1.5; }

/* Dark mode: increase line-height by 0.05-0.1 — light text on dark has reduced perceived weight */
```

---

## Letter Spacing

```css
/* Tight for large display text */
.display { letter-spacing: -0.02em; }

/* Wide for uppercase labels */
.label { letter-spacing: 0.05em; text-transform: uppercase; }

/* Default for body */
p { letter-spacing: 0; }
```

---

## OpenType Features

Advanced typography polish — check font support with [Wakamai Fondue](https://wakamaifondue.com/):

```css
/* Tabular numbers for data tables — digits align in columns */
.tabular-nums { font-variant-numeric: tabular-nums; }

/* Proper fractions */
.fractions { font-variant-numeric: diagonal-fractions; }

/* Small caps for abbreviations */
.small-caps { font-variant-caps: all-small-caps; }

/* Disable ligatures in code */
code { font-variant-ligatures: none; }
```

---

## Accessibility

- Always use `rem`/`em` for font sizes — respects user preferences
- Never disable zoom (`user-scalable=no`) — fix layouts instead
- Minimum 16px body text
- Ensure 44px+ tap targets for text links via padding or line-height
- Use `ch` units for measure (line length) — `max-width: 65ch` for readable body text

---

## Text Gradients

For hero headlines:

```css
.text-gradient {
  @apply bg-gradient-to-r from-primary-500 via-accent-500 to-secondary-500 bg-clip-text text-transparent;
}
```
