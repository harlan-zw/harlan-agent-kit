---
name: Clay
description: Plump, playful claymorphism with soft pastels and sculpted shadows. Tactile warmth via triple-layer shadow system and springy interactions.
colors:
  primary: "#d6a2ff"
  secondary: "#a7f3d0"
  accent: "#fed7aa"
  neutral: "#78716c"
  surface: "#ffffff"
  elevated: "#faf8f5"
  tertiary: "#bae6fd"
typography:
  display:
    fontFamily: Quicksand
    fontSize: 1.5rem
    lineHeight: 1.3
  sans:
    fontFamily: Nunito
    fontSize: 1rem
    lineHeight: 1.5
rounded:
  sm: 1rem
  md: 1.5rem
  lg: 2rem
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#1f2937"
    rounded: "{rounded.md}"
    padding: 12px 24px
    shadow: "0 4px 6px rgba(0, 0, 0, 0.05), 0 10px 20px rgba(0, 0, 0, 0.05), 0 20px 40px rgba(0, 0, 0, 0.03)"
  button-primary-hover:
    shadow: "0 8px 12px rgba(0, 0, 0, 0.06), 0 16px 32px rgba(0, 0, 0, 0.06), 0 32px 64px rgba(0, 0, 0, 0.04)"
  button-primary-active:
    shadow: "0 1px 2px rgba(0, 0, 0, 0.06), 0 2px 4px rgba(0, 0, 0, 0.04), inset 0 2px 4px rgba(0, 0, 0, 0.06)"
    transform: translateY(2px)
  card-default:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    shadow: "0 4px 6px rgba(0, 0, 0, 0.05), 0 10px 20px rgba(0, 0, 0, 0.05), 0 20px 40px rgba(0, 0, 0, 0.03)"
    padding: 24px
---

# Clay Theme

Plump, playful claymorphism with soft pastels and sculpted shadows. Like touching toy-like 3D objects.

**Vibe**: Soft, rounded, tactile, joyful
**Trends**: Claymorphism + Bento Grid
**Mode**: Light
**Fonts**: Quicksand (display) + Nunito (body)
**Icons**: `phosphor` duotone — soft two-tone fills feel playful and rounded like the clay aesthetic
**Principle**: tactile warmth over minimalism — soft depth invites touching
**Motion**: 300-400ms springy (`bounce: 0.2-0.25`); buttons press *down* with `translateY(1px)`, not scale

---

## Nuxt Config

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  fonts: {
    families: [
      { name: 'Quicksand', provider: 'google' },
      { name: 'Nunito', provider: 'google' }
    ]
  }
})
```

## CSS Tokens

```css
/* app/assets/css/main.css */
@import "tailwindcss";
@import "@nuxt/ui";

@theme {
  --font-display: 'Quicksand', system-ui, sans-serif;
  --font-sans: 'Nunito', system-ui, sans-serif;
  --color-clay-bg: #faf8f5;
  --color-clay-surface: #ffffff;
  --color-clay-purple: #d6a2ff;
  --color-clay-mint: #a7f3d0;
  --color-clay-peach: #fed7aa;
  --color-clay-sky: #bae6fd;
  --radius-clay: 1rem;
  --radius-clay-lg: 1.5rem;
  --radius-clay-xl: 2rem;

  /* Triple shadow system — creates sculptural depth */
  --shadow-clay-sm:
    0 2px 4px rgba(0, 0, 0, 0.04),
    0 4px 8px rgba(0, 0, 0, 0.04),
    0 8px 16px rgba(0, 0, 0, 0.02);
  --shadow-clay:
    0 4px 6px rgba(0, 0, 0, 0.05),
    0 10px 20px rgba(0, 0, 0, 0.05),
    0 20px 40px rgba(0, 0, 0, 0.03);
  --shadow-clay-lg:
    0 8px 12px rgba(0, 0, 0, 0.06),
    0 16px 32px rgba(0, 0, 0, 0.06),
    0 32px 64px rgba(0, 0, 0, 0.04);
  --shadow-clay-pressed:
    0 1px 2px rgba(0, 0, 0, 0.06),
    0 2px 4px rgba(0, 0, 0, 0.04),
    inset 0 2px 4px rgba(0, 0, 0, 0.06);
}

:root {
  --ui-bg: var(--color-clay-bg);
  --ui-radius: 1rem;
}

/* Bento grid */
.bento-grid { @apply grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 lg:gap-6; }
.bento-featured { @apply col-span-1 row-span-1 lg:col-span-2 lg:row-span-2; }
.bento-wide { @apply col-span-1 lg:col-span-2; }
.bento-tall { @apply row-span-1 lg:row-span-2; }
```

## App Config

```ts
// app.config.ts
export default defineAppConfig({
  ui: {
    colors: { primary: 'purple', secondary: 'emerald', neutral: 'stone' },
    button: {
      slots: { base: 'rounded-2xl font-semibold shadow-clay transition-all duration-200' },
      variants: { size: { lg: { base: 'px-6 py-3 text-base' } } },
      compoundVariants: [
        {
          color: 'primary',
          variant: 'solid',
          class: 'bg-clay-purple text-gray-800 hover:shadow-clay-lg active:shadow-clay-pressed active:translate-y-0.5'
        }
      ],
      defaultVariants: { size: 'lg' }
    },
    card: {
      slots: {
        root: 'rounded-3xl bg-white shadow-clay',
        header: 'p-6',
        body: 'p-6',
        footer: 'p-6'
      },
      variants: {
        variant: {
          outline: { root: 'bg-white shadow-clay border-0' },
          soft: { root: 'bg-white/80 shadow-clay-sm' }
        }
      }
    },
    accordion: {
      slots: {
        root: 'w-full space-y-3',
        item: 'rounded-2xl bg-white shadow-clay-sm border-0 overflow-hidden',
        trigger: 'px-6 py-4 font-semibold text-base hover:bg-clay-surface/50',
        content: 'px-6',
        body: 'pb-4 text-gray-600'
      }
    }
  }
})
```

## Key Patterns

1. **Border radius**: `rounded-2xl` / `rounded-3xl` everywhere
2. **Shadows**: Triple-layer shadow system (not flat `box-shadow`)
3. **Active states**: `active:translate-y-0.5` + `active:shadow-clay-pressed` (squish feel)
4. **Colors**: Soft pastels — purple, mint, peach, sky
5. **No borders**: Shadows define edges, not borders

## Animations

- Spring easing on hover (bounce: 0.25, duration: 0.4s)
- Card hover: lift + shadow-clay-lg
- Button press: translate down + shadow-clay-pressed
- Staggered bento entrance: scale from 0.95 + fade
