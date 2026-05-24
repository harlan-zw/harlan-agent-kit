---
name: Blueprint
description: Neo-brutalist with thick borders, stark contrast, and hard offset shadows. Raw, honest, structural.
colors:
  primary: "#FFD600"
  secondary: "#00FF94"
  accent: "#0066FF"
  error: "#FF3B3B"
  neutral: "#FFFDF7"
typography:
  heading:
    fontFamily: Archivo Black
    fontSize: 1rem
    lineHeight: 1.2
  body:
    fontFamily: Outfit
    fontSize: 1rem
    lineHeight: 1.5
  mono:
    fontFamily: JetBrains Mono
    fontSize: 0.875rem
rounded:
  sm: 0
  md: 0
  lg: 0
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#000000"
    border: "3px solid black"
    padding: 12px
  button-primary-hover:
    boxShadow: "6px 6px 0 black"
    transform: "translateY(-2px)"
  button-primary-active:
    boxShadow: "2px 2px 0 black"
    transform: "translateY(0)"
  card-default:
    backgroundColor: "#FFFFFF"
    border: "3px solid black"
    boxShadow: "4px 4px 0 black"
    padding: 24px
  badge-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#000000"
    border: "2px solid black"
---

# Blueprint Theme

Neo-brutalist with thick borders, stark contrast, and hard offset shadows. Raw, honest, structural.

**Vibe**: Exposed structure, anti-polish, bold
**Trends**: Neo-Brutalism + Bento Grid
**Mode**: Light (cream background)
**Fonts**: Archivo Black (headings) + Outfit (body) + JetBrains Mono (code)
**Icons**: `tabler` — thick 2px rounded strokes match the bold, structural weight
**Principle**: honest structure over softness — every element announces what it is
**Motion**: 150-200ms with `linear` or minimal `ease-out`. No springs, no bounce, no fades — movement is abrupt and mechanical because polish would undercut the brutalist thesis.

---

## Nuxt Config

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  fonts: {
    families: [
      { name: 'Archivo Black', provider: 'google' },
      { name: 'Outfit', provider: 'google' },
      { name: 'JetBrains Mono', provider: 'google' }
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
  --color-cream: #FFFDF7;
  --color-yellow: #FFD600;
  --color-green: #00FF94;
  --color-red: #FF3B3B;
  --color-blue: #0066FF;
  --font-heading: 'Archivo Black', system-ui, sans-serif;
  --font-body: 'Outfit', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
  --border-width-3: 3px;
  --shadow-brutal-sm: 2px 2px 0 black;
  --shadow-brutal: 4px 4px 0 black;
  --shadow-brutal-lg: 6px 6px 0 black;
  --shadow-brutal-xl: 8px 8px 0 black;
  --shadow-brutal-yellow: 4px 4px 0 var(--color-yellow);
  --shadow-brutal-green: 4px 4px 0 var(--color-green);
}

:root {
  --ui-radius: 0;
  --ui-bg: var(--color-cream);
  --ui-bg-muted: var(--color-cream);
  --ui-bg-elevated: white;
  --ui-border: black;
  --ui-border-accented: black;
}

/* Brutal utilities */
.border-brutal { border: 3px solid black; }

.shadow-brutal-hover {
  box-shadow: var(--shadow-brutal);
  transition: box-shadow 0.15s, transform 0.15s;
}
.shadow-brutal-hover:hover {
  box-shadow: var(--shadow-brutal-lg);
  transform: translateY(-2px);
}
.shadow-brutal-hover:active {
  box-shadow: var(--shadow-brutal-sm);
  transform: translateY(0);
}

.brutal-lift {
  transition: transform 0.2s, box-shadow 0.2s;
}
.brutal-lift:hover {
  transform: translate(-4px, -4px);
  box-shadow: 8px 8px 0 black;
}
```

## App Config

```ts
// app.config.ts
export default defineAppConfig({
  ui: {
    colors: {
      primary: 'yellow',
      secondary: 'green',
      success: 'green',
      error: 'red',
      info: 'blue',
      neutral: 'slate'
    },
    button: {
      slots: { base: 'font-heading uppercase tracking-wide' },
      variants: {
        brutal: {
          true: {
            base: [
              'border-3 border-black shadow-brutal',
              'hover:-translate-y-0.5 hover:shadow-brutal-lg',
              'active:translate-y-0 active:shadow-brutal-sm'
            ].join(' ')
          }
        }
      },
      compoundVariants: [
        { color: 'primary', brutal: true, class: 'bg-yellow text-black' },
        { color: 'secondary', brutal: true, class: 'bg-green text-black' },
        { color: 'neutral', brutal: true, class: 'bg-white text-black' }
      ],
      defaultVariants: { variant: 'solid' }
    },
    card: {
      slots: {
        root: 'border-3 border-black shadow-brutal bg-white',
        header: 'border-b-3 border-black',
        footer: 'border-t-3 border-black bg-cream'
      }
    },
    badge: {
      slots: { base: 'border-2 border-black font-mono uppercase text-xs tracking-wider' },
      compoundVariants: [
        { color: 'primary', variant: 'solid', class: 'bg-yellow text-black' },
        { color: 'secondary', variant: 'solid', class: 'bg-green text-black' },
        { color: 'error', variant: 'solid', class: 'bg-red text-white' }
      ]
    },
    input: {
      slots: { base: 'border-3 border-black bg-white font-mono' },
      variants: { variant: { outline: 'focus:ring-0 focus:border-black focus:shadow-brutal-sm' } }
    },
    alert: {
      slots: { root: 'border-3 border-black', title: 'font-heading uppercase' },
      compoundVariants: [
        { color: 'warning', variant: 'soft', class: { root: 'bg-yellow/20' } },
        { color: 'error', variant: 'soft', class: { root: 'bg-red/20' } }
      ]
    }
  }
})
```

## Key Patterns

1. **Border-first**: Everything gets `border-3 border-black`
2. **Squared corners**: `--ui-radius: 0` globally
3. **Offset shadows**: Hard black shadow, no blur
4. **Hover = lift**: Translate up + bigger shadow
5. **Active = press**: Translate back down + smaller shadow
6. **Typography**: Headings uppercase with wide tracking
7. **Colors**: Cream bg, yellow primary, green secondary, stark contrast
