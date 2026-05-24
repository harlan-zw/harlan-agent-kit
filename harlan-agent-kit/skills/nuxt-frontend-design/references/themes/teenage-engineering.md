---
name: Teenage Engineering
description: Industrial hardware aesthetic with functional mechanical design, exposed structure, orange accents, and screw indicators
colors:
  primary: "#ffc003"
  secondary: "#1270b8"
  accent: "#ce2021"
  neutral: "#1a1a1a"
  surface: "#f5f5f5"
  elevated: "#e5e5e5"
  success: "#1aa167"
typography:
  sans:
    fontFamily: Space Mono
    fontSize: 1rem
    lineHeight: 1.5
  mono:
    fontFamily: JetBrains Mono
    fontSize: 0.875rem
rounded:
  sm: 2px
  md: 4px
  lg: 4px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#0f0e12"
    rounded: "{rounded.sm}"
    padding: 12px
    border: "1px solid #d4a500"
  button-primary-hover:
    backgroundColor: "#e6b300"
    boxShadow: "0 2px 4px rgba(0,0,0,0.15)"
  card-default:
    backgroundColor: "#f5f5f5"
    textColor: "#0f0e12"
    rounded: "{rounded.md}"
    padding: 24px
    border: "1px solid #bdbdbd"
  input-default:
    backgroundColor: "#ffffff"
    textColor: "#0f0e12"
    rounded: "{rounded.sm}"
    border: "1px solid #bdbdbd"
---

# Teenage Engineering Theme

Industrial hardware aesthetic. Functional, mechanical, exposed structure with orange accents and screw indicators.

**Vibe**: Physical hardware, knobs and switches, workshop
**Trends**: Teenage Engineering product design
**Mode**: Light
**Fonts**: Space Mono (technical) + JetBrains Mono (code)
**Icons**: `tabler` — thick mechanical strokes match the industrial hardware feel
**Principle**: deliberate utility over smoothness — this is hardware, not software-pretending-to-be
**Motion**: 100-150ms, near-stepped `linear`; click feedback is mechanical (`translateY(1px)`), no bounce, no spring. Think switch-flip, not UI-easing.

---

## Nuxt Config

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  fonts: {
    families: [
      { name: 'Space Mono', provider: 'google' },
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
  --font-mono: 'JetBrains Mono', monospace;
  --font-technical: 'Space Mono', monospace;
  --color-te-black: #0f0e12;
  --color-te-dark: #1a1a1a;
  --color-te-gray: #808080;
  --color-te-silver: #bdbdbd;
  --color-te-light: #e5e5e5;
  --color-te-off-white: #f5f5f5;
  --color-te-orange: #ffc003;
  --color-te-blue: #1270b8;
  --color-te-green: #1aa167;
  --color-te-red: #ce2021;
  --radius-te: 2px;
  --radius-te-lg: 4px;

  --shadow-te-button: inset 0 1px 0 rgba(255,255,255,0.5), 0 1px 2px rgba(0,0,0,0.1);
  --shadow-te-button-hover: inset 0 1px 0 rgba(255,255,255,0.5), 0 2px 4px rgba(0,0,0,0.15);
  --shadow-te-pressed: inset 0 2px 4px rgba(0,0,0,0.2);
  --shadow-te-panel: 0 2px 8px rgba(0,0,0,0.08);
  --shadow-te-screen: inset 0 2px 8px rgba(0,0,0,0.5);
}

:root {
  --ui-bg: var(--color-te-off-white);
  --ui-radius: 2px;
}

@layer utilities {
  .te-label { @apply font-mono text-xs uppercase tracking-widest text-te-gray; }
  .te-readout { @apply font-technical text-te-orange tracking-wide; }
}

@layer components {
  .te-panel {
    @apply bg-te-off-white border border-te-silver rounded-te-lg shadow-te-panel p-6 relative;
  }
  .te-screen {
    @apply bg-te-black border-2 border-te-gray rounded-te-lg p-4 font-technical text-te-orange shadow-te-screen;
  }
  .te-knob {
    @apply w-12 h-12 rounded-full bg-gradient-to-br from-gray-200 to-gray-300 border-2 border-te-gray shadow-sm cursor-pointer relative;
  }
  .te-knob::after {
    content: '';
    @apply absolute top-1 left-1/2 w-0.5 h-2 bg-te-black -translate-x-1/2;
  }
  .te-led { @apply w-2 h-2 rounded-full; }
  .te-led-green { @apply bg-te-green shadow-[0_0_8px_var(--color-te-green)]; }
  .te-led-orange { @apply bg-te-orange shadow-[0_0_8px_var(--color-te-orange)]; }

  /* Screw indicators */
  .te-panel-exposed { @apply te-panel bg-te-light; }
  .te-panel-exposed::before, .te-panel-exposed::after {
    content: '+';
    @apply absolute text-xs text-te-gray font-mono;
  }
  .te-panel-exposed::before { @apply top-2 left-2; }
  .te-panel-exposed::after { @apply top-2 right-2; }
}
```

## App Config

```ts
// app.config.ts
export default defineAppConfig({
  ui: {
    colors: { primary: 'amber', secondary: 'zinc', neutral: 'stone' },
    button: {
      slots: { base: 'rounded-te font-mono text-xs uppercase tracking-widest shadow-te-button transition-all duration-100' },
      compoundVariants: [
        {
          color: 'primary',
          variant: 'solid',
          class: 'bg-te-orange text-te-black border border-amber-500 hover:shadow-te-button-hover active:shadow-te-pressed active:translate-y-px'
        },
        {
          color: 'neutral',
          variant: 'solid',
          class: 'bg-te-light text-te-black border border-te-silver hover:bg-te-off-white active:shadow-te-pressed active:translate-y-px'
        }
      ]
    },
    card: {
      slots: {
        root: 'rounded-te-lg bg-te-off-white border border-te-silver shadow-te-panel',
        header: 'p-6 border-b border-te-silver',
        body: 'p-6',
        footer: 'p-6 border-t border-te-silver'
      }
    },
    input: {
      slots: { base: 'rounded-te font-mono text-sm bg-white border border-te-silver focus:border-te-orange focus:ring-2 focus:ring-te-orange/20' }
    },
    badge: {
      slots: { base: 'rounded-te px-2 py-1 font-mono text-xs uppercase tracking-widest' },
      compoundVariants: [
        { color: 'primary', variant: 'solid', class: 'bg-te-orange text-te-black border-amber-500' }
      ]
    }
  }
})
```

## Key Patterns

1. **Minimal radius**: 2px / 4px — machined precision
2. **Mechanical press**: `active:translate-y-px` + inset shadow
3. **Monospace everything**: Labels, badges, inputs all `font-mono`
4. **Uppercase tracking**: `uppercase tracking-widest` on all controls
5. **Orange accent**: Used for primary actions, LED indicators, screen readouts
6. **Silver borders**: `border-te-silver` on all panels
7. **Screw indicators**: `+` pseudo-elements in corners of exposed panels
8. **LED dots**: Small glowing status indicators
