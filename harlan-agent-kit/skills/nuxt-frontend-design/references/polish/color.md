# Color Strategy

Intentional color systems that create cohesive, distinctive interfaces.

For deriving new tones from existing tokens (`color-mix`, axis-by-axis OKLCH stepping), see [css-toolkit.md](css-toolkit.md). Use derivation before inventing a new swatch.

---

## Use OKLCH, Not HSL

OKLCH is perceptually uniform — equal lightness steps *look* equal, unlike HSL where 50% yellow looks bright but 50% blue looks dark.

```css
/* OKLCH: lightness (0-100%), chroma (0-0.4+), hue (0-360) */
--color-primary: oklch(60% 0.15 250);
--color-primary-light: oklch(85% 0.08 250);  /* Reduce chroma toward white */
--color-primary-dark: oklch(35% 0.12 250);   /* Reduce chroma toward black */
```

**Key**: As you approach white or black, reduce chroma. High chroma at extreme lightness looks garish.

---

## Tinted Neutrals

Pure gray has no personality. Add a tiny hint of your brand hue:

```css
/* Dead grays — avoid */
--gray-100: oklch(95% 0 0);
--gray-900: oklch(15% 0 0);

/* Warm-tinted (brand warmth) */
--gray-100: oklch(95% 0.01 60);
--gray-900: oklch(15% 0.01 60);

/* Cool-tinted (tech, professional) */
--gray-100: oklch(95% 0.01 250);
--gray-900: oklch(15% 0.01 250);
```

Chroma of 0.01 is subtle but perceptible — creates subconscious cohesion between brand and UI. Never use pure black (`#000`) or pure gray for large areas; real shadows always carry a color cast.

---

## CSS Variable Strategy

Always define colors as CSS variables, never hardcode:

```css
/* app/assets/css/main.css */
@theme {
  --color-surface: #ffffff;
  --color-surface-elevated: #fafafa;
  --color-accent: #ff6b35;
  --color-accent-subtle: rgba(255, 107, 53, 0.1);
}
```

Override Nuxt UI semantic tokens for global consistency:

```css
:root {
  --ui-bg: var(--color-surface);
  --ui-bg-elevated: var(--color-surface-elevated);
}
```

Use two layers: primitive tokens (`--blue-500`) and semantic tokens (`--color-primary: var(--blue-500)`). For dark mode, only redefine the semantic layer.

---

## Dominant + Accent Pattern (60-30-10)

One dominant color + one sharp accent outperforms evenly-distributed palettes:

- **60%**: Neutral backgrounds, white space, base surfaces
- **30%**: Secondary — text, borders, inactive states
- **10%**: Accent — CTAs, highlights, focus states

Accent colors work *because* they're rare. Overuse kills their power.

```ts
// app.config.ts
export default defineAppConfig({
  ui: {
    colors: {
      primary: 'amber', // Dominant — used for CTAs, active states
      neutral: 'stone' // Background system
    }
  }
})
```

Skip secondary/tertiary colors unless truly needed — most apps work fine with one accent.

---

## Contrast & Accessibility

### WCAG Requirements

| Content | AA Minimum | AAA Target |
|---------|------------|------------|
| Body text | 4.5:1 | 7:1 |
| Large text (18px+ or 14px bold) | 3:1 | 4.5:1 |
| UI components, icons | 3:1 | 4.5:1 |

### Dangerous Combinations

- Light gray text on white — the #1 accessibility fail
- **Gray text on colored backgrounds** — looks washed out. Use a darker shade of the background color, or transparency
- Red on green / green on red — 8% of men can't distinguish
- Blue on red — vibrates visually
- Yellow on white — almost always fails
- Thin light text on images — unpredictable contrast
- Placeholder text still needs 4.5:1 — most fail this

---

## Dark Mode

Don't just invert. Design dark mode intentionally:

```css
:root {
  --ui-bg: #faf8f5;
  --ui-bg-muted: #f0ebe4;
  --ui-bg-elevated: #ffffff;
  --ui-text: #1a1a1a;
  --ui-text-muted: #6b6b6b;
  --ui-border: rgba(0, 0, 0, 0.08);
}

.dark {
  --ui-bg: #0a0a0a;
  --ui-bg-muted: #141414;
  --ui-bg-elevated: #1a1a1a;
  --ui-text: rgba(255, 255, 255, 0.9);
  --ui-text-muted: rgba(255, 255, 255, 0.5);
  --ui-border: rgba(255, 255, 255, 0.08);
}
```

### Dark Mode Rules

| Light Mode | Dark Mode |
|------------|-----------|
| Shadows for depth | Lighter surfaces for depth (no shadows) |
| Dark text on light | Light text on dark (reduce font weight) |
| Vibrant accents | Desaturate accents slightly |
| White backgrounds | Never pure black — use dark gray (oklch 12-18%) |

- Use lower opacity for backgrounds (`bg-white/5` not solid colors)
- Borders become lighter opacity, not darker
- Reduce body font weight in dark mode (350 instead of 400) — light text on dark appears heavier

---

## Force Dark/Light Mode

For themes that only work in one mode:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  colorMode: {
    preference: 'dark',
    fallback: 'dark'
  }
})
```

---

## Alpha Is a Design Smell

Heavy use of transparency (`rgba`, `hsla`) usually means an incomplete palette. Alpha creates unpredictable contrast, performance overhead, and inconsistency. Define explicit overlay colors for each context. Exception: focus rings and interactive states where see-through is intentional.

---

## Glass/Transparency Colors

For glassmorphism themes (use sparingly — see above):

```css
@theme {
  --color-glass-bg: rgba(255, 255, 255, 0.05);
  --color-glass-border: rgba(255, 255, 255, 0.08);
  --color-glass-border-hover: rgba(255, 255, 255, 0.15);
}
```

| Layer | Background | Blur |
|-------|------------|------|
| Back | `rgba(0,0,0,0.25)` | `24-32px` |
| Middle | `rgba(0,0,0,0.35)` | `12-16px` |
| Front | `rgba(0,0,0,0.4)` | `8-12px` |

---

## Glow Effects

For dark themes, replace shadows with colored glows:

```css
@theme {
  --shadow-glow: 0 0 40px rgba(var(--color-primary-500), 0.15);
  --shadow-glow-intense: 0 0 60px rgba(var(--color-primary-500), 0.3);
}
```

---

## Anti-Patterns

- Relying on color alone to convey information (always pair with text/icons)
- Pure black (`#000`) for large areas — tint toward brand hue
- Cyan-on-dark or neon-on-dark clichés
- Creating palettes without clear roles for each color
- Skipping color blindness testing

