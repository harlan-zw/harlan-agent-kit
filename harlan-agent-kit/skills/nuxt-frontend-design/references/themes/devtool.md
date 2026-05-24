---
name: DevTool
description: Technical schematic aesthetic inspired by voidzero with grid backgrounds, dashed borders, monospace annotations. Information density over breathing room for developers reading schematics.
colors:
  primary: "#0a0a0a"
  secondary: "#1a1a1a"
  accent: "#888888"
  neutral: "#ffffff"
typography:
  sans:
    fontFamily: IBM Plex Sans
    fontSize: 1rem
    lineHeight: 1.5
  mono:
    fontFamily: IBM Plex Mono
    fontSize: 0.875rem
rounded:
  sm: 4px
  md: 4px
  lg: 4px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: 12px
    borderStyle: none
  button-primary-hover:
    backgroundColor: "{colors.secondary}"
    transform: translateY(-1px)
  button-outline:
    backgroundColor: transparent
    borderStyle: dashed
    borderColor: "#d0d0d0"
    textColor: "{colors.primary}"
  card-default:
    backgroundColor: "{colors.neutral}"
    borderStyle: dashed
    borderColor: "#d0d0d0"
    textColor: "{colors.primary}"
    rounded: "{rounded.md}"
    padding: 24px
---

# DevTool Theme

Technical schematic aesthetic inspired by voidzero. Grid backgrounds, dashed borders, monospace annotations.

**Vibe**: Blueprint, TUI hybrid, developer tools, technical documentation
**Trends**: Blueprint DevTool
**Mode**: Light (with dark sections)
**Fonts**: IBM Plex Mono (code/labels) + IBM Plex Sans (body)
**Icons**: `lucide` — clean consistent 2px strokes match the schematic precision
**Principle**: information density over breathing room — this is a tool for users who read the schematic
**Motion**: 80-150ms `linear` or `ease-out` for hover and press — fast enough to read as instant. Drop animation entirely for high-frequency, keyboard-triggered actions (command palette toggle, tab switches, keyboard shortcut targets) per the frequency rule. Reserve longer motion (>200ms) for rare events only (first-run, celebrations).

---

## Nuxt Config

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  fonts: {
    families: [
      { name: 'IBM Plex Mono', provider: 'google' },
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
  --font-sans: 'IBM Plex Sans', sans-serif;
  --font-mono: 'IBM Plex Mono', monospace;
  --color-ds-white: #ffffff;
  --color-ds-off-white: #f8f8f8;
  --color-ds-grid: #e8e8e8;
  --color-ds-border: #d0d0d0;
  --color-ds-muted: #888888;
  --color-ds-text: #555555;
  --color-ds-heading: #1a1a1a;
  --color-ds-black: #0a0a0a;
  --color-ds-dark-surface: #1a1a1a;
  --color-ds-dark-border: #333333;
  --color-ds-dark-text: #cccccc;
  --radius-ds: 4px;
}

:root {
  --ui-bg: var(--color-ds-white);
  --ui-bg-muted: var(--color-ds-off-white);
  --ui-border: var(--color-ds-border);
  --ui-radius: 4px;
}

/* Grid background */
.bg-grid {
  background-image:
    linear-gradient(var(--color-ds-grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--color-ds-grid) 1px, transparent 1px);
  background-size: 40px 40px;
}

/* Annotations */
@layer components {
  .ds-annotation {
    @apply font-mono text-xs text-ds-muted tracking-wide;
  }
  .ds-card-annotation {
    @apply absolute -top-3 right-4 font-mono text-xs text-ds-muted bg-ds-white px-2;
  }
  .ds-section-num {
    @apply font-mono text-5xl font-light text-ds-grid;
  }
  .ds-section {
    @apply grid grid-cols-[60px_1fr] gap-6 py-12 border-t border-dashed border-ds-border;
  }
  .ds-terminal {
    @apply bg-ds-off-white border border-ds-border rounded-ds font-mono text-sm overflow-hidden;
  }
}
```

## App Config

```ts
// app.config.ts
export default defineAppConfig({
  ui: {
    colors: { primary: 'neutral', neutral: 'neutral' },
    button: {
      slots: { base: 'font-sans font-medium transition-all duration-150' },
      variants: {
        variant: {
          solid: 'bg-ds-black text-white hover:bg-ds-heading hover:-translate-y-px active:translate-y-0',
          outline: 'border-dashed border-ds-border text-ds-heading hover:bg-ds-off-white',
          ghost: 'text-ds-text hover:text-ds-heading hover:bg-ds-off-white'
        }
      }
    },
    card: {
      slots: {
        root: 'bg-ds-white border border-dashed border-ds-border rounded-ds',
        header: 'border-b border-dashed border-ds-border px-6 py-4',
        body: 'p-6',
        footer: 'border-t border-dashed border-ds-border px-6 py-4'
      }
    },
    badge: {
      slots: { root: 'font-mono text-xs tracking-wide' },
      variants: {
        variant: {
          solid: 'bg-ds-black text-white',
          outline: 'border-dashed border-ds-border text-ds-text',
          subtle: 'bg-ds-off-white text-ds-muted'
        }
      }
    },
    input: {
      slots: { base: 'border border-ds-border rounded-ds focus:border-ds-heading focus:ring-1 focus:ring-ds-heading' }
    },
    table: {
      slots: {
        th: 'font-mono text-xs uppercase tracking-wider text-ds-muted',
        td: 'border-b border-dashed border-ds-grid'
      }
    },
    tabs: {
      slots: {
        list: 'border-b border-dashed border-ds-border',
        trigger: 'font-mono text-sm text-ds-muted data-[state=active]:text-ds-heading data-[state=active]:border-b-2 data-[state=active]:border-ds-black'
      }
    },
    tooltip: {
      slots: { content: 'bg-ds-black text-white font-mono text-xs rounded-ds px-2 py-1' }
    }
  }
})
```

## Key Patterns

1. **Dashed borders**: `border-dashed` on all structural elements
2. **Grid background**: Subtle graph-paper grid
3. **Monospace labels**: `font-mono text-xs tracking-wide` for annotations
4. **Section numbers**: Large light numbers in left gutter
5. **Annotations**: Floating filename/label badges on cards
6. **Minimal radius**: 4px everywhere
7. **Black + white**: Near-monochrome, structure over color
8. **Terminal blocks**: Monospace output panels for data
