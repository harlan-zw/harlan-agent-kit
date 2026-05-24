---
name: Frost
description: Premium dark glassmorphism with luminous purple-blue gradients bleeding through translucent glass panels
colors:
  primary: "#a855f7"
  secondary: "#3b82f6"
  accent: "#22d3ee"
  neutral: "#0a0a0a"
  surface: "#0f0f14"
  elevated: "#14141e"
typography:
  sans:
    fontFamily: Satoshi
    fontSize: 1rem
    lineHeight: 1.5
  mono:
    fontFamily: JetBrains Mono
    fontSize: 0.875rem
rounded:
  sm: 6px
  md: 12px
  lg: 16px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: 12px
  button-primary-hover:
    backgroundColor: "#b46cf9"
  card-default:
    backgroundColor: "#ffffff0d"
    textColor: "#ffffffe6"
    rounded: "{rounded.lg}"
    padding: 24px
  input-default:
    backgroundColor: "#ffffff0d"
    textColor: "#ffffffe6"
    rounded: "{rounded.md}"
---

# Frost Theme

Premium dark glassmorphism. Deep blacks with luminous purple-blue gradients bleeding through translucent glass panels.

**Vibe**: Ice crystals, frosted glass, premium docs
**Trends**: Glassmorphism + Scrollytelling
**Mode**: Dark only
**Fonts**: Satoshi (sans) + JetBrains Mono (code)
**Icons**: `heroicons` outline — clean 1.5px strokes glow beautifully against dark glass
**Principle**: luminous restraint over busy contrast — the glass does the work, decoration fights it
**Motion**: 200-300ms with `ease-out-quart`; glow intensifies on hover rather than translating

---

## Nuxt Config

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  colorMode: { preference: 'dark', fallback: 'dark' },
  fonts: {
    families: [
      { name: 'Satoshi', provider: 'google' },
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
  --color-frost-base: #0a0a0a;
  --color-frost-surface: rgba(15, 15, 20, 0.8);
  --color-frost-elevated: rgba(25, 25, 35, 0.6);
  --color-frost-purple: #a855f7;
  --color-frost-blue: #3b82f6;
  --color-frost-cyan: #22d3ee;
  --color-glass-bg: rgba(255, 255, 255, 0.05);
  --color-glass-border: rgba(255, 255, 255, 0.08);
  --color-glass-border-hover: rgba(255, 255, 255, 0.12);
  --color-mesh-purple: rgba(168, 85, 247, 0.15);
  --color-mesh-blue: rgba(59, 130, 246, 0.1);
  --color-mesh-cyan: rgba(34, 211, 238, 0.08);
  --font-sans: 'Satoshi', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
  --shadow-glass: 0 8px 32px rgba(0, 0, 0, 0.4);
  --shadow-glow-purple: 0 0 40px rgba(168, 85, 247, 0.15);
  --shadow-glow-blue: 0 0 40px rgba(59, 130, 246, 0.12);
  --shadow-glass-inset: inset 0 1px 0 rgba(255, 255, 255, 0.05);
  --radius-glass: 1rem;
}

:root, .dark {
  --ui-bg: #0a0a0a;
  --ui-bg-muted: rgba(15, 15, 20, 0.8);
  --ui-bg-elevated: rgba(20, 20, 30, 0.6);
  --ui-border: rgba(255, 255, 255, 0.08);
  --ui-border-muted: rgba(255, 255, 255, 0.05);
  --ui-text: rgba(255, 255, 255, 0.9);
  --ui-text-muted: rgba(255, 255, 255, 0.6);
  --ui-radius: 0.75rem;
}

/* Utilities */
.glass { @apply backdrop-blur-xl bg-white/5 border border-white/8; }
.glass-elevated { @apply backdrop-blur-2xl bg-white/8 border border-white/10 shadow-glass; }

.bg-mesh {
  background-image:
    radial-gradient(at 20% 30%, var(--color-mesh-purple) 0%, transparent 50%),
    radial-gradient(at 80% 20%, var(--color-mesh-blue) 0%, transparent 40%),
    radial-gradient(at 60% 80%, var(--color-mesh-cyan) 0%, transparent 45%);
}

.text-gradient-frost {
  @apply bg-gradient-to-r from-purple-400 via-blue-400 to-cyan-400 bg-clip-text text-transparent;
}

@keyframes glow-pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}

/* Opacity-only animation is safe under reduced-motion, but honour the preference explicitly */
@media (prefers-reduced-motion: reduce) {
  .glow-pulse { animation: none; opacity: 0.75; }
}
```

## App Config

```ts
// app.config.ts
export default defineAppConfig({
  ui: {
    colors: { primary: 'purple', secondary: 'blue', neutral: 'slate' },
    card: {
      slots: { root: 'backdrop-blur-xl bg-white/5 border border-white/8 shadow-2xl' },
      variants: {
        variant: {
          outline: { root: 'bg-white/5 ring-0 border border-white/8 backdrop-blur-xl' },
          soft: { root: 'bg-white/3 backdrop-blur-lg border border-white/5' }
        }
      }
    },
    button: {
      slots: { base: 'backdrop-blur-md transition-all duration-300' },
      compoundVariants: [
        { color: 'primary', variant: 'solid', class: 'hover:shadow-[0_0_30px_rgba(168,85,247,0.4)]' },
        { color: 'neutral', variant: 'outline', class: 'bg-white/5 border-white/20 hover:bg-white/10' }
      ]
    },
    modal: {
      slots: {
        overlay: 'bg-black/60 backdrop-blur-sm',
        content: 'backdrop-blur-2xl bg-white/5 border border-white/10 shadow-2xl'
      }
    },
    tabs: {
      slots: { list: 'bg-white/5 backdrop-blur-md border border-white/8' },
      variants: { variant: { pill: { indicator: 'bg-white/10 backdrop-blur-sm' } } }
    },
    input: { slots: { root: 'backdrop-blur-md bg-white/5 border-white/10' } }
  }
})
```

## Key Patterns

### Blur Levels

| Component | Level |
|-----------|-------|
| Cards | `backdrop-blur-xl` (24px) |
| Modals | `backdrop-blur-2xl` (32px) |
| Inputs | `backdrop-blur-md` (12px) |
| Nav | `backdrop-blur-lg` (16px) |
| Overlays | `backdrop-blur-sm` (4px) |

### Border Opacity

- Default: `border-white/8`
- Hover: `border-white/12`
- Focus: `border-purple-500/50`

## Animations

- Cards: fade up + scale from 0.95, stagger 100ms
- Hover: spring translateY(-4px), border glow intensifies
- Hero: parallax mesh at 0.3x scroll speed
- Page transitions: blur + opacity fade
