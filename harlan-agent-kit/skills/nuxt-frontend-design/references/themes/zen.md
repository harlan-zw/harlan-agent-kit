---
name: Zen
description: Japanese minimalism with generous negative space, earth tones, and contemplative typography. Wabi-sabi sensibility meets kinetic serif typography with deliberate, slow motion.
colors:
  primary: "#2C2C2C"
  accent: "#C53D2F"
  cream: "#FAF7F2"
  surface: "#F5F0E8"
  sand: "#D4C5A9"
  moss: "#7A8B69"
  muted: "#8A8A8A"
typography:
  display:
    fontFamily: Crimson Pro
    fontSize: 2.5rem
    fontWeight: 400
    lineHeight: 1.2
  sans:
    fontFamily: IBM Plex Sans
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.6
rounded:
  sm: 2px
  md: 4px
  lg: 8px
spacing:
  ma-sm: 24px
  ma-md: 48px
  ma-lg: 80px
  ma-xl: 128px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.cream}"
    rounded: "{rounded.sm}"
    padding: 12px 24px
  button-primary-hover:
    backgroundColor: "{colors.primary}"
    boxShadow: 0 4px 12px rgba(44, 44, 44, 0.08)
    transform: translateY(-2px)
  button-outline:
    backgroundColor: transparent
    borderColor: "{colors.primary}"
    textColor: "{colors.primary}"
    rounded: "{rounded.sm}"
    padding: 12px 24px
  button-outline-hover:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.cream}"
  card-default:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.sm}"
    padding: 48px
    boxShadow: 0 4px 12px rgba(44, 44, 44, 0.08)
  card-outline:
    backgroundColor: transparent
    borderColor: "{colors.sand}"
    rounded: "{rounded.sm}"
    padding: 48px
  input-default:
    backgroundColor: transparent
    borderColor: transparent
    borderBottomColor: "{colors.sand}"
    rounded: 0px
    padding: 12px 0px
  input-focus:
    borderBottomColor: "{colors.primary}"
---

# Zen Theme

Japanese minimalism with generous negative space, earth tones, and contemplative typography.

**Vibe**: Ma (negative space), wabi-sabi, meditative
**Trends**: Japanese Zen Minimalism + Kinetic Typography
**Mode**: Light
**Fonts**: Crimson Pro (serif display) + IBM Plex Sans (body)
**Icons**: `lucide` — thin 2px strokes match the restrained, minimal aesthetic
**Principle**: contemplation over urgency — space and time are design elements
**Motion**: 400-600ms with `ease-zen` (gentle); transitions are deliberate, never snappy. No bounce.

---

## Nuxt Config

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  fonts: {
    families: [
      { name: 'Crimson Pro', provider: 'google' },
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
  --font-display: 'Crimson Pro', serif;
  --font-sans: 'IBM Plex Sans', sans-serif;
  --color-zen-cream: #FAF7F2;
  --color-zen-surface: #F5F0E8;
  --color-zen-charcoal: #2C2C2C;
  --color-zen-sand: #D4C5A9;
  --color-zen-moss: #7A8B69;
  --color-zen-vermillion: #C53D2F;
  --color-zen-muted: #8A8A8A;

  /* Ma spacing — generous */
  --spacing-ma-sm: 1.5rem;
  --spacing-ma-md: 3rem;
  --spacing-ma-lg: 5rem;
  --spacing-ma-xl: 8rem;

  /* Zen shadows — warm, subtle */
  --shadow-zen-sm: 0 1px 3px rgba(44, 44, 44, 0.06);
  --shadow-zen: 0 4px 12px rgba(44, 44, 44, 0.08);
  --shadow-zen-lg: 0 8px 24px rgba(44, 44, 44, 0.1);
}

:root {
  --ui-bg: var(--color-zen-cream);
  --ui-bg-muted: var(--color-zen-surface);
  --ui-bg-elevated: #ffffff;
  --ui-border: var(--color-zen-sand);
  --ui-radius: 0.125rem;  /* Minimal — 2px */
}

/* Washi paper texture */
.washi {
  background-image: url("data:image/svg+xml,%3Csvg width='60' height='60' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='0.65' numOctaves='3'/%3E%3C/filter%3E%3Crect width='60' height='60' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
}

/* Zen easing — contemplative */
.ease-zen { transition-timing-function: cubic-bezier(0.25, 0.1, 0.25, 1); }
```

## App Config

```ts
// app.config.ts
export default defineAppConfig({
  ui: {
    colors: { primary: 'stone', secondary: 'emerald', neutral: 'stone' },
    button: {
      slots: { base: 'rounded-sm font-medium shadow-zen-sm transition-all duration-300 ease-zen' },
      variants: { size: { lg: { base: 'px-8 py-3 text-base tracking-wide' } } },
      compoundVariants: [
        {
          color: 'primary',
          variant: 'solid',
          class: 'bg-zen-charcoal text-zen-cream hover:shadow-zen hover:-translate-y-0.5'
        },
        {
          color: 'primary',
          variant: 'outline',
          class: 'border-zen-charcoal text-zen-charcoal hover:bg-zen-charcoal hover:text-zen-cream'
        }
      ],
      defaultVariants: { size: 'lg' }
    },
    card: {
      slots: {
        root: 'rounded-sm bg-zen-surface shadow-zen washi',
        header: 'p-[var(--spacing-ma-md)]',
        body: 'p-[var(--spacing-ma-md)]',
        footer: 'p-[var(--spacing-ma-md)]'
      },
      variants: {
        variant: {
          outline: { root: 'bg-transparent border border-zen-sand shadow-none' },
          soft: { root: 'bg-zen-surface/80 shadow-zen-sm' }
        }
      }
    },
    accordion: {
      slots: {
        root: 'w-full',
        item: 'border-b border-zen-sand',
        trigger: 'py-6 font-serif text-lg hover:text-zen-vermillion transition-colors duration-300',
        body: 'text-zen-muted leading-relaxed'
      }
    },
    input: {
      slots: {
        base: 'bg-transparent border-b border-zen-clay focus:border-zen-charcoal transition-colors duration-300 rounded-none'
      }
    }
  }
})
```

## Key Patterns

1. **Minimal radius**: `rounded-sm` (2px) — paper feel
2. **Ma spacing**: Generous padding, `py-24 md:py-32` between sections
3. **Earth tones**: Cream, sand, charcoal, moss, vermillion accent
4. **Serif headlines**: `font-display` for headings
5. **Slow transitions**: 300-600ms with ease-zen
6. **Washi texture**: Subtle noise overlay on surfaces
7. **Inputs**: Bottom-border only, no box
8. **Vermillion accent**: Used sparingly for emphasis
