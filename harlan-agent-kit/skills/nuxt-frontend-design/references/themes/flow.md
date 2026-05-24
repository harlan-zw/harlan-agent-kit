---
name: Flow
description: Liquid organic shapes with soft curves, ocean colors, and scrollytelling depth. Water-inspired design with continuous state morphing.
colors:
  primary: "#1a8fb5"
  secondary: "#ff6b5a"
  accent: "#ff6b5a"
  neutral: "#0a3d4f"
typography:
  sans:
    fontFamily: Manrope
    fontSize: 1rem
    lineHeight: 1.5
  serif:
    fontFamily: Playfair Display
    fontSize: 1.5rem
    lineHeight: 1.6
rounded:
  sm: 12px
  md: 24px
  lg: 40px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: 12px 24px
  button-primary-hover:
    backgroundColor: "#0d5f7a"
  card-default:
    backgroundColor: "#faf8f3"
    textColor: "{colors.neutral}"
    rounded: "{rounded.lg}"
    padding: 24px
    boxShadow: "0 4px 20px rgba(26, 143, 181, 0.08)"
---

# Flow Theme

Liquid organic shapes with soft curves, ocean colors, and scrollytelling depth.

**Vibe**: Water, organic, calming, nature
**Trends**: Liquid Organic + Scrollytelling
**Mode**: Light
**Fonts**: Playfair Display (serif display) + Manrope (body)
**Icons**: `mingcute` — rounded 2px corners feel organic and warm like water curves
**Principle**: continuity over separation — states morph, they don't swap
**Motion**: 500-800ms `ease-in-out`; shape morphs and flowing gradients dominate. Use view transitions and `clip-path` for state changes rather than opacity crossfades.

---

## Nuxt Config

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  fonts: {
    families: [
      { name: 'Playfair Display', provider: 'google' },
      { name: 'Manrope', provider: 'google' }
    ]
  }
})
```

## CSS Tokens

```css
@import "tailwindcss";
@import "@nuxt/ui";

@theme {
  --font-display: 'Playfair Display', serif;
  --font-sans: 'Manrope', sans-serif;

  --color-ocean-50: #f0f9ff;
  --color-ocean-100: #d4eef7;
  --color-ocean-200: #a8dcef;
  --color-ocean-500: #1a8fb5;
  --color-ocean-700: #0d5f7a;
  --color-ocean-900: #0a3d4f;
  --color-sand-50: #faf8f3;
  --color-sand-100: #f0ebe0;
  --color-coral: #ff6b5a;

  --radius-blob: 1.5rem;
  --radius-blob-lg: 2.5rem;
  --radius-blob-sm: 0.75rem;

  --shadow-soft: 0 4px 20px rgba(26, 143, 181, 0.08);
  --shadow-soft-lg: 0 8px 40px rgba(26, 143, 181, 0.12);
}

:root {
  --ui-radius: 1rem;
  --ui-primary: var(--color-ocean-500);
  --ui-bg: var(--color-sand-50);
  --ui-bg-muted: var(--color-sand-100);
  --ui-bg-elevated: white;
  --ui-text: var(--color-ocean-900);
  --ui-text-muted: var(--color-ocean-700);
  --ui-border: var(--color-ocean-100);
}

/* Blob background shapes */
.blob-bg::before {
  content: '';
  position: absolute;
  width: 400px; height: 400px;
  border-radius: 40% 60% 70% 30% / 40% 50% 60% 50%;
  background: linear-gradient(135deg, var(--color-ocean-100), var(--color-coral)/10);
  filter: blur(80px);
  animation: blob-morph 8s ease-in-out infinite;
}

@keyframes blob-morph {
  0%, 100% { border-radius: 40% 60% 70% 30% / 40% 50% 60% 50%; }
  50% { border-radius: 60% 40% 30% 70% / 50% 60% 40% 60%; }
}

@media (prefers-reduced-motion: reduce) {
  .blob { animation: none; }
}

/* Wave divider */
.wave-divider {
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 1200 120' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M0,60 C200,120 400,0 600,60 C800,120 1000,0 1200,60 V120 H0 Z' fill='%23f0f9ff'/%3E%3C/svg%3E");
  background-size: cover;
  height: 80px;
}
```

## App Config

```ts
// app.config.ts
export default defineAppConfig({
  ui: {
    colors: { primary: 'sky', secondary: 'orange', neutral: 'stone' },
    button: {
      slots: { base: 'rounded-blob font-medium transition-all duration-300' },
      defaultVariants: { variant: 'solid' }
    },
    card: {
      slots: { root: 'rounded-blob-lg overflow-hidden shadow-soft' },
      variants: {
        variant: {
          soft: { root: 'bg-sand-50/80 backdrop-blur-sm' }
        }
      }
    },
    badge: { slots: { base: 'rounded-blob-sm' } },
    input: { slots: { root: 'rounded-blob' } }
  }
})
```

## Key Patterns

1. **Large radius**: `rounded-blob` (1.5rem+) — organic curves
2. **Ocean-sand palette**: Cool blues + warm sand
3. **Coral accent**: Sparingly, for CTAs
4. **Soft shadows**: Ocean-tinted, low opacity
5. **Blob shapes**: Background morphing blobs (CSS animated)
6. **Wave dividers**: SVG waves between sections
7. **Serif display**: Playfair for headlines
8. **Scrollytelling**: Content reveals tied to scroll position
