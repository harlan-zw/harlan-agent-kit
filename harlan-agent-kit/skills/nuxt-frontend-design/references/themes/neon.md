---
name: Neon
description: Cyberpunk neon with glowing accents on deep black. Electric energy, high contrast, digital edge.
colors:
  primary: "#00FFFF"
  secondary: "#FF00FF"
  neutral: "#0a0a0a"
typography:
  display:
    fontFamily: Syne
    fontSize: 1rem
  mono:
    fontFamily: Fira Code
    fontSize: 1rem
  sans:
    fontFamily: Fira Code
    fontSize: 1rem
rounded:
  sm: 0px
  md: 0px
  lg: 0px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#000000"
    rounded: "{rounded.md}"
    padding: 12px
  button-primary-hover:
    boxShadow: "0 0 20px #00FFFF4d"
  button-outline:
    borderColor: "{colors.primary}"
    textColor: "{colors.primary}"
    rounded: "{rounded.md}"
    borderWidth: 1px
  card-default:
    backgroundColor: "#111111"
    borderColor: "#ffffff1a"
    borderWidth: 1px
    rounded: "{rounded.lg}"
    padding: 24px
  card-outline:
    backgroundColor: "#111111"
    borderColor: "{colors.primary}"
    borderWidth: 1px
    boxShadow: "0 0 20px #00FFFF1a"
---

# Neon Theme

Cyberpunk neon with glowing accents on deep black. Electric energy, high contrast, digital edge.

**Vibe**: Cyberpunk, electric, high-tech portfolio
**Trends**: Cyberpunk Neon
**Mode**: Dark only
**Fonts**: Syne (display) + Fira Code (mono/body)
**Icons**: `solar` bold — sharp geometric fills with neon glow via `drop-shadow` match the cyberpunk edge
**Principle**: saturated energy over subtlety — nothing whispers, everything signals
**Motion**: 120-180ms snappy `ease-out`; glow pulses and flicker are acceptable here (one of the few themes where they fit)

---

## Nuxt Config

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  colorMode: { preference: 'dark', fallback: 'dark' },
  fonts: {
    families: [
      { name: 'Syne', provider: 'google' },
      { name: 'Fira Code', provider: 'google' }
    ]
  }
})
```

## CSS Tokens

```css
@import "tailwindcss";
@import "@nuxt/ui";

@theme {
  --font-display: 'Syne', sans-serif;
  --font-mono: 'Fira Code', monospace;
  --font-sans: 'Fira Code', monospace;
  --color-neon-bg: #0a0a0a;
  --color-neon-surface: #111111;
  --color-neon-cyan: #00FFFF;
  --color-neon-magenta: #FF00FF;
  --color-neon-green: #39FF14;
  --color-neon-yellow: #FFE600;
  --shadow-neon-cyan: 0 0 20px rgba(0, 255, 255, 0.3), 0 0 40px rgba(0, 255, 255, 0.1);
  --shadow-neon-magenta: 0 0 20px rgba(255, 0, 255, 0.3), 0 0 40px rgba(255, 0, 255, 0.1);
}

:root, .dark {
  --ui-bg: #0a0a0a;
  --ui-bg-muted: #111111;
  --ui-bg-elevated: #1a1a1a;
  --ui-text: rgba(255, 255, 255, 0.9);
  --ui-text-muted: rgba(255, 255, 255, 0.5);
  --ui-border: rgba(255, 255, 255, 0.1);
  --ui-primary: var(--color-neon-cyan);
  --ui-radius: 0;
}

.text-neon-cyan { color: var(--color-neon-cyan); text-shadow: 0 0 10px rgba(0, 255, 255, 0.5); }
.text-neon-magenta { color: var(--color-neon-magenta); text-shadow: 0 0 10px rgba(255, 0, 255, 0.5); }
.glow-cyan { box-shadow: var(--shadow-neon-cyan); }
.glow-magenta { box-shadow: var(--shadow-neon-magenta); }

.border-glow {
  border: 1px solid var(--color-neon-cyan);
  box-shadow: inset 0 0 10px rgba(0, 255, 255, 0.1), 0 0 10px rgba(0, 255, 255, 0.1);
}

@keyframes neon-flicker {
  0%, 100% { opacity: 1; }
  92% { opacity: 1; }
  93% { opacity: 0.8; }
  94% { opacity: 1; }
  96% { opacity: 0.9; }
  97% { opacity: 1; }
}

@keyframes glitch {
  0%, 100% { transform: translate(0); }
  20% { transform: translate(-2px, 2px); }
  40% { transform: translate(2px, -2px); }
  60% { transform: translate(-1px, -1px); }
  80% { transform: translate(1px, 1px); }
}

/* Flicker and glitch are classic motion-sickness triggers — disable for reduced-motion users */
@media (prefers-reduced-motion: reduce) {
  .neon-flicker, .glitch { animation: none; }
}
```

## App Config

```ts
// app.config.ts
export default defineAppConfig({
  ui: {
    colors: { primary: 'cyan', secondary: 'fuchsia', neutral: 'zinc' },
    button: {
      slots: { base: 'font-mono uppercase tracking-wider text-sm' },
      compoundVariants: [
        {
          color: 'primary',
          variant: 'solid',
          class: 'bg-neon-cyan text-black hover:shadow-neon-cyan hover:glow-cyan'
        },
        {
          color: 'primary',
          variant: 'outline',
          class: 'border-neon-cyan text-neon-cyan hover:bg-neon-cyan/10 hover:shadow-neon-cyan'
        }
      ]
    },
    card: {
      slots: { root: 'bg-neon-surface border border-white/10' },
      variants: {
        variant: {
          outline: { root: 'border-neon-cyan/30 hover:border-neon-cyan hover:shadow-neon-cyan' }
        }
      }
    },
    input: {
      slots: { base: 'bg-black border-white/20 font-mono focus:border-neon-cyan focus:shadow-neon-cyan' }
    },
    badge: {
      slots: { base: 'font-mono uppercase text-xs tracking-wider' },
      compoundVariants: [
        { color: 'primary', variant: 'solid', class: 'bg-neon-cyan text-black' },
        { color: 'secondary', variant: 'solid', class: 'bg-neon-magenta text-black' }
      ]
    }
  }
})
```

## Key Patterns

1. **No radius**: `--ui-radius: 0` — sharp, digital
2. **Neon glow**: Colored `box-shadow` + `text-shadow`
3. **Monospace everything**: Body text in Fira Code
4. **Uppercase labels**: `uppercase tracking-wider` on interactive elements
5. **Flicker animation**: Subtle neon flicker on key elements
6. **Cyan + Magenta**: Primary accent pair
7. **Border glow on hover**: Cards/inputs gain neon border glow
