---
name: Kinetic Paper
description: Tactile paper objects with real weight, texture, and craft-inspired motion. Stationery, letterpress, origami, and handmade aesthetics.
colors:
  primary: "#C53D2F"
  secondary: "#3B5998"
  neutral: "#2C2C2C"
  paper-white: "#FEFDFB"
  paper-cream: "#F8F4ED"
  paper-ivory: "#F2EDE3"
  paper-kraft: "#D4C5A9"
  ink-charcoal: "#2C2C2C"
  ink-sepia: "#5C4A32"
typography:
  display:
    fontFamily: Fraunces
    fontSize: 1.5rem
    lineHeight: 1.3
  sans:
    fontFamily: IBM Plex Sans
    fontSize: 1rem
    lineHeight: 1.5
rounded:
  sm: 2px
  md: 2px
  lg: 2px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.paper-white}"
    rounded: "{rounded.md}"
    padding: 12px
    shadow: "0 2px 4px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)"
  button-primary-hover:
    transform: translateY(-4px)
    shadow: "0 4px 8px rgba(0,0,0,0.1), 0 8px 24px rgba(0,0,0,0.08), 0 16px 48px rgba(0,0,0,0.06)"
  card-default:
    backgroundColor: "{colors.paper-white}"
    rounded: "{rounded.md}"
    padding: 24px
    shadow: "0 2px 4px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)"
---

# Kinetic Paper Theme

Tactile paper objects with real weight, texture, and craft-inspired motion.

**Vibe**: Stationery, letterpress, origami, handmade
**Trends**: Tactile Paper UI + Kinetic Typography
**Mode**: Light (warm cream)
**Fonts**: Fraunces (serif display) + IBM Plex Sans (body)
**Icons**: `phosphor` thin — delicate 1px strokes feel hand-drawn and craft-like
**Principle**: craft movement over digital slickness — paper has weight, folds, and rest positions
**Motion**: 300-500ms spring (`bounce: 0.25`); elements settle like paper coming to rest. Fold/unfold transitions with `clip-path` or `rotate3d` are in scope; simple fades are not.

---

## Nuxt Config

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  fonts: {
    families: [
      { name: 'Fraunces', provider: 'google' },
      { name: 'IBM Plex Sans', provider: 'google' }
    ]
  }
})
```

## CSS Tokens

```css
@import "tailwindcss";
@import "@nuxt/ui";

@theme {
  --font-display: 'Fraunces', serif;
  --font-sans: 'IBM Plex Sans', sans-serif;
  --color-paper-white: #FEFDFB;
  --color-paper-cream: #F8F4ED;
  --color-paper-ivory: #F2EDE3;
  --color-paper-kraft: #D4C5A9;
  --color-ink-charcoal: #2C2C2C;
  --color-ink-sepia: #5C4A32;
  --color-vermillion: #C53D2F;
  --color-indigo: #3B5998;
  --radius-paper: 2px;

  --shadow-paper-sm:
    0 1px 2px rgba(0,0,0,0.06),
    0 2px 4px rgba(0,0,0,0.04);
  --shadow-paper:
    0 2px 4px rgba(0,0,0,0.08),
    0 4px 12px rgba(0,0,0,0.06),
    0 8px 24px rgba(0,0,0,0.04);
  --shadow-paper-lg:
    0 4px 8px rgba(0,0,0,0.1),
    0 8px 24px rgba(0,0,0,0.08),
    0 16px 48px rgba(0,0,0,0.06);
}

:root {
  --ui-bg: var(--color-paper-cream);
  --ui-bg-elevated: var(--color-paper-white);
  --ui-border: var(--color-paper-kraft);
  --ui-radius: 2px;
}

/* Washi texture */
.washi {
  background-image: url("data:image/svg+xml,%3Csvg width='60' height='60' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='0.65' numOctaves='3'/%3E%3C/filter%3E%3Crect width='60' height='60' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
}

/* Letterpress indent */
.letterpress { text-shadow: 0 1px 0 rgba(255,255,255,0.6), 0 -1px 0 rgba(0,0,0,0.1); }

/* Corner fold */
.corner-fold {
  position: relative;
}
.corner-fold::after {
  content: '';
  position: absolute;
  top: 0; right: 0;
  width: 24px; height: 24px;
  background: linear-gradient(135deg, var(--color-paper-cream) 50%, var(--color-paper-kraft) 50%);
}
```

## App Config

```ts
// app.config.ts
export default defineAppConfig({
  ui: {
    colors: { primary: 'red', secondary: 'blue', neutral: 'stone' },
    button: {
      slots: { base: 'rounded-paper font-semibold shadow-paper transition-all duration-300' },
      compoundVariants: [
        {
          color: 'primary',
          variant: 'solid',
          class: 'bg-vermillion text-paper-white letterpress hover:shadow-paper-lg hover:-translate-y-1 active:translate-y-0.5 active:shadow-paper-sm'
        },
        {
          color: 'primary',
          variant: 'outline',
          class: 'border-ink-charcoal text-ink-charcoal hover:bg-paper-ivory'
        }
      ]
    },
    card: {
      slots: {
        root: 'rounded-paper bg-paper-white shadow-paper washi',
        header: 'p-6',
        body: 'p-6',
        footer: 'p-6'
      },
      variants: {
        variant: {
          outline: { root: 'bg-paper-cream border border-paper-kraft shadow-none' },
          soft: { root: 'bg-paper-ivory/80 shadow-paper-sm' }
        }
      }
    },
    input: {
      slots: { base: 'bg-paper-cream border border-ink-sepia/30 shadow-paper-sm focus:border-ink-charcoal rounded-paper' }
    },
    badge: {
      slots: { base: 'rounded-paper px-3 py-1 text-sm shadow-paper-sm' },
      compoundVariants: [
        { color: 'primary', class: 'bg-paper-ivory text-ink-charcoal' }
      ]
    }
  }
})
```

## Key Patterns

1. **Minimal radius**: 2px — crisp paper edge
2. **Multi-layer shadows**: Simulate paper depth/stacking
3. **Washi texture**: Noise overlay on all surfaces
4. **Letterpress text**: Subtle inset text-shadow
5. **Corner fold**: CSS triangle fold on highlighted cards
6. **Warm colors**: Cream, ivory, kraft, sepia, vermillion
7. **Spring hover**: Paper lift with bouncy easing
8. **Serif display**: Fraunces for headlines
