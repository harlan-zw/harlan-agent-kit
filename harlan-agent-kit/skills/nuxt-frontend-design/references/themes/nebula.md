---
name: Nebula
description: Aurora gradient mesh with cosmic depth. Cyan-violet gradients drifting through glass panels on void-black.
colors:
  primary: "#00DFD8"
  secondary: "#8B5CF6"
  accent: "#3B82F6"
  neutral: "#0A0A0F"
  surface: "#12121A"
  elevated: "#1A1A24"
typography:
  sans:
    fontFamily: Plus Jakarta Sans
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
    backgroundColor: "linear-gradient(to right, #00DFD8, #3B82F6)"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: 12px
  button-primary-hover:
    boxShadow: "0 0 30px rgba(0, 223, 216, 0.4)"
  card-default:
    backgroundColor: "#ffffff0d"
    textColor: "#ffffffe6"
    rounded: "{rounded.lg}"
    padding: 24px
    backdropFilter: blur(12px)
  input-default:
    backgroundColor: "#ffffff0d"
    textColor: "#ffffffe6"
    rounded: "{rounded.md}"
    backdropFilter: blur(12px)
---

# Nebula Theme

Aurora gradient mesh with cosmic depth. Cyan-violet gradients drifting through glass panels on void-black.

**Vibe**: Cosmic, premium SaaS, ethereal
**Trends**: Aurora Gradient Mesh + Glassmorphism
**Mode**: Dark only
**Fonts**: Plus Jakarta Sans (body) + JetBrains Mono (code)
**Icons**: `solar` linear — geometric 1.5px lines feel modern and sharp against cosmic gradients
**Principle**: atmospheric depth over literal clarity — the gradient mesh is the subject, content floats in it
**Motion**: 400-800ms slow `ease-in-out`; parallax and drift dominate, state changes crossfade rather than snap

---

## Nuxt Config

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  colorMode: { preference: 'dark', fallback: 'dark' },
  fonts: {
    families: [
      { name: 'Plus Jakarta Sans', provider: 'google' },
      { name: 'JetBrains Mono', provider: 'google' }
    ]
  }
})
```

## CSS Tokens

```css
@import "tailwindcss";
@import "@nuxt/ui";

@theme {
  --color-void: #0A0A0F;
  --color-deep: #12121A;
  --color-nebula-surface: #1A1A24;
  --color-aurora-cyan: #00DFD8;
  --color-aurora-violet: #8B5CF6;
  --color-aurora-blue: #3B82F6;
  --font-sans: 'Plus Jakarta Sans', sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
  --shadow-nebula-glow: 0 0 40px rgba(0, 223, 216, 0.15);
  --shadow-nebula-intense: 0 0 60px rgba(0, 223, 216, 0.3);
}

:root, .dark {
  --ui-bg: #0A0A0F;
  --ui-bg-muted: #12121A;
  --ui-bg-elevated: #1A1A24;
  --ui-bg-accented: #242432;
  --ui-text-dimmed: rgba(255,255,255,0.4);
  --ui-text-muted: rgba(255,255,255,0.6);
  --ui-text: rgba(255,255,255,0.9);
  --ui-text-highlighted: #FFFFFF;
  --ui-border: rgba(255,255,255,0.08);
  --ui-border-muted: rgba(255,255,255,0.05);
  --ui-border-accented: rgba(255,255,255,0.12);
  --ui-primary: #00DFD8;
  --ui-radius: 0.75rem;
}

/* Aurora background */
.bg-aurora {
  background-image:
    radial-gradient(ellipse at 20% 50%, rgba(0, 223, 216, 0.12) 0%, transparent 50%),
    radial-gradient(ellipse at 80% 20%, rgba(139, 92, 246, 0.1) 0%, transparent 50%),
    radial-gradient(ellipse at 50% 80%, rgba(59, 130, 246, 0.08) 0%, transparent 50%);
}

@keyframes aurora-drift {
  0%, 100% { transform: translate(0, 0) rotate(0deg); }
  33% { transform: translate(10px, -10px) rotate(1deg); }
  66% { transform: translate(-5px, 5px) rotate(-1deg); }
}

/* Drift is spatial — must be disabled for reduced-motion users */
@media (prefers-reduced-motion: reduce) {
  .aurora-drift { animation: none; }
}

.text-gradient-nebula {
  @apply bg-gradient-to-r from-cyan-400 via-blue-400 to-violet-400 bg-clip-text text-transparent;
}
```

## App Config

```ts
// app.config.ts
export default defineAppConfig({
  ui: {
    colors: { primary: 'cyan', secondary: 'violet', neutral: 'slate' },
    card: {
      variants: {
        variant: {
          subtle: { root: 'bg-white/5 backdrop-blur-xl border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.4)]' }
        }
      },
      defaultVariants: { variant: 'subtle' }
    },
    button: {
      slots: { base: 'backdrop-blur-md transition-all duration-300' },
      compoundVariants: [
        {
          color: 'primary',
          variant: 'solid',
          class: 'bg-gradient-to-r from-cyan-500 to-blue-500 hover:shadow-[0_0_30px_rgba(0,223,216,0.4)] border-0'
        },
        {
          color: 'neutral',
          variant: 'outline',
          class: 'bg-white/5 border-white/20 hover:bg-white/10 hover:border-white/30 hover:shadow-[0_0_20px_rgba(0,223,216,0.15)]'
        }
      ]
    },
    modal: {
      slots: {
        overlay: 'bg-black/60 backdrop-blur-sm',
        content: 'bg-[#12121A]/90 backdrop-blur-2xl border border-white/10 shadow-[0_25px_50px_rgba(0,0,0,0.5)]'
      }
    },
    input: {
      slots: { root: 'bg-white/5 backdrop-blur-md border-white/10 focus:border-cyan-500/50 focus:ring-cyan-500/20' }
    }
  }
})
```

## Key Patterns

1. **Glass surfaces**: `bg-white/5 backdrop-blur-xl border-white/10`
2. **Hover glow**: Cyan shadow on hover `shadow-[0_0_20px_rgba(0,223,216,0.15)]`
3. **Gradient buttons**: `bg-gradient-to-r from-cyan-500 to-blue-500`
4. **Aurora background**: Multi-radial-gradient with subtle animation
5. **Highlighted cards**: Cyan ring + glow
6. **Use `subtle` variant** as base for glass components
