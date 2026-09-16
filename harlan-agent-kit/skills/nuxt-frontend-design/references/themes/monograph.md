---
name: Monograph
description: Academic publishing aesthetic drawn from specimen labels, herbarium sheets and university press monographs. Hairline rules, a committed text serif, letterspaced field labels and tabular figures, on warm paper and warm ink.
colors:
  primary: "#2E4C7E"
  secondary: "#8A2F28"
  accent: "#5E574D"
  ink: "#211E1A"
  ink-soft: "#3D3831"
  paper: "#FBF9F5"
  paper-leaf: "#F4F1EA"
  paper-shade: "#EDE9E0"
  rule: "#D9D3C6"
  rule-strong: "#C0B8A6"
  ink-dark: "#171512"
  ink-dark-leaf: "#1E1B17"
  ink-dark-shade: "#26221D"
  paper-dark: "#E4DED2"
  rule-dark: "#332E27"
typography:
  serif:
    fontFamily: Source Serif 4
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.55
  sans:
    fontFamily: Source Sans 3
    fontSize: 0.9375rem
    fontWeight: 400
    lineHeight: 1.45
  mono:
    fontFamily: Source Code Pro
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: Source Sans 3
    fontSize: 0.75rem
    fontWeight: 600
    letterSpacing: 0.08em
    textTransform: uppercase
rounded:
  sm: 2px
  md: 2px
  lg: 2px
spacing:
  field: 4px
  row: 8px
  block: 16px
  section: 32px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    padding: 10px 16px
    borderStyle: none
    typography: "{typography.sans}"
  button-primary-hover:
    backgroundColor: "#243C64"
  button-outline:
    backgroundColor: transparent
    borderStyle: solid
    borderColor: "{colors.rule-strong}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: 10px 16px
  button-outline-hover:
    backgroundColor: "{colors.paper-leaf}"
    borderColor: "{colors.ink-soft}"
  button-ghost:
    backgroundColor: transparent
    borderStyle: none
    textColor: "{colors.ink-soft}"
    padding: 10px 12px
  button-danger:
    backgroundColor: transparent
    borderStyle: solid
    borderColor: "{colors.secondary}"
    textColor: "{colors.secondary}"
    rounded: "{rounded.md}"
    padding: 10px 16px
  card-default:
    backgroundColor: "{colors.paper}"
    borderStyle: solid
    borderColor: "{colors.rule}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: 16px
    boxShadow: none
  card-elevated:
    backgroundColor: "{colors.paper}"
    borderStyle: solid
    borderColor: "{colors.rule}"
    rounded: "{rounded.md}"
    padding: 16px
    boxShadow: "0 1px 2px #211E1A0F"
  input-default:
    backgroundColor: "{colors.paper}"
    borderStyle: solid
    borderColor: "{colors.rule-strong}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: 10px 12px
  input-focus:
    borderColor: "{colors.primary}"
  badge-default:
    backgroundColor: "{colors.paper-shade}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.sm}"
    padding: 2px 6px
    typography: "{typography.label}"
  field-label:
    textColor: "{colors.accent}"
    typography: "{typography.label}"
  datum:
    textColor: "{colors.ink}"
    typography: "{typography.mono}"
  rule-hairline:
    borderStyle: solid
    borderColor: "{colors.rule}"
    borderWidth: 1px
---

# Monograph Theme

Academic publishing. A natural history museum specimen label, a herbarium sheet, a systematics journal, a university press monograph.

**Vibe**: specimen label, plate caption, catalogue of record
**Trends**: Academic Editorial + Information-Dense Reading UI
**Mode**: Light and dark, both first class. Dark is a warm scholarly reading mode, never blue-black.
**Fonts**: Source Serif 4 (body prose and headings) + Source Sans 3 (controls and field labels) + Source Code Pro (data)
**Icons**: `tabler` — a uniform 1.5px stroke on a 24px grid with square-cut terminals. It matches the weight of a 1px hairline rule and never out-weighs the serif text beside it. Rounded, branded or duotone sets (`ph` duotone, `material-symbols` filled) put more ink on an icon than on the datum it labels, which inverts this theme's whole hierarchy.
**Principle**: **we prioritise legibility of dense data over visual impact** — the page recedes so the data reads
**Motion**: 150-220ms `ease-out`. Colour, border colour and opacity only. No bounce, no spring, no `translateY` lift, no scale on hover. Academic work does not bounce. Overlays fade and the surface behind them does not move.

---

## Nuxt Config

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  fonts: {
    families: [
      { name: 'Source Serif 4', provider: 'google', weights: [400, 600] },
      { name: 'Source Sans 3', provider: 'google', weights: [400, 600] },
      { name: 'Source Code Pro', provider: 'google', weights: [400, 500] },
    ],
  },
  colorMode: { preference: 'system', fallback: 'light', classSuffix: '' },
})
```

## CSS Tokens

```css
@import "tailwindcss";
@import "@nuxt/ui";

@theme {
  --font-serif: "Source Serif 4", ui-serif, Georgia, serif;
  --font-sans: "Source Sans 3", ui-sans-serif, sans-serif;
  --font-mono: "Source Code Pro", ui-monospace, monospace;

  /* Paper, never white. Ink, never black. */
  --color-mg-paper: #FBF9F5;
  --color-mg-paper-leaf: #F4F1EA;
  --color-mg-paper-shade: #EDE9E0;
  --color-mg-rule: #D9D3C6;
  --color-mg-rule-strong: #C0B8A6;
  --color-mg-ink: #211E1A;
  --color-mg-ink-soft: #3D3831;
  --color-mg-ink-muted: #5E574D;

  /* Warm dark reading mode. */
  --color-mg-dark: #171512;
  --color-mg-dark-leaf: #1E1B17;
  --color-mg-dark-shade: #26221D;
  --color-mg-dark-rule: #332E27;
  --color-mg-dark-ink: #E4DED2;

  /* One restrained ink accent, one removal colour. Nothing else. */
  --color-mg-accent: #2E4C7E;
  --color-mg-accent-dark: #8FB3E0;
  --color-mg-strike: #8A2F28;
  --color-mg-strike-dark: #E0958E;

  --radius-mg: 2px;

  /* Paper is flat. Elevation is a rule plus the faintest possible shadow. */
  --shadow-mg-lift: 0 1px 2px rgb(33 30 26 / 0.06);
  --shadow-mg-sheet: 0 1px 2px rgb(33 30 26 / 0.08), 0 4px 10px rgb(33 30 26 / 0.05);

  --ease-mg: cubic-bezier(0.22, 0.61, 0.36, 1);
}

:root {
  --ui-radius: 0.125rem; /* 2px */

  --ui-bg: var(--color-mg-paper);
  --ui-bg-muted: var(--color-mg-paper-leaf);
  --ui-bg-elevated: var(--color-mg-paper-shade);
  --ui-bg-accented: #E3DED2;
  --ui-bg-inverted: var(--color-mg-ink);

  --ui-border: var(--color-mg-rule);
  --ui-border-muted: #E6E1D5;
  --ui-border-accented: var(--color-mg-rule-strong);
  --ui-border-inverted: var(--color-mg-ink);

  --ui-text-dimmed: #7D766A;
  --ui-text-muted: var(--color-mg-ink-muted);
  --ui-text-toned: var(--color-mg-ink-soft);
  --ui-text: #2A2622;
  --ui-text-highlighted: var(--color-mg-ink);
  --ui-text-inverted: var(--color-mg-paper);
}

.dark {
  --ui-bg: var(--color-mg-dark);
  --ui-bg-muted: var(--color-mg-dark-leaf);
  --ui-bg-elevated: var(--color-mg-dark-shade);
  --ui-bg-accented: #322D26;
  --ui-bg-inverted: #F2EDE3;

  --ui-border: var(--color-mg-dark-rule);
  --ui-border-muted: #242019;
  --ui-border-accented: #464036;
  --ui-border-inverted: #F2EDE3;

  --ui-text-dimmed: #867E70;
  --ui-text-muted: #A39B8C;
  --ui-text-toned: #C3BAA9;
  --ui-text: var(--color-mg-dark-ink);
  --ui-text-highlighted: #F5F0E6;
  --ui-text-inverted: var(--color-mg-dark);
}

@layer base {
  /* Serif prose, oldstyle figures. A number inside a sentence sits on the
     baseline like a word, not like a heading. */
  body {
    font-family: var(--font-serif);
    font-variant-numeric: oldstyle-nums;
  }

  /* Headings commit to the same serif as the body. This theme has no
     "serif heading over a generic sans body". */
  h1, h2, h3, h4, h5, h6 {
    font-family: var(--font-serif);
    font-weight: 600;
    letter-spacing: -0.005em;
  }

  /* Anything columnar lines up. Coordinates with 2 to 8 decimals must align
     down a column or the column stops being readable. */
  table, .mg-datum, .mg-column, [data-tabular] {
    font-variant-numeric: tabular-nums slashed-zero;
  }
}

@layer components {
  /* Theme signature: the hairline rule. 1px in warm grey does every piece of
     structural work in this theme. Never dashed, never 2px, never black. */
  .mg-rule {
    @apply border-0 border-t border-solid;
    border-color: var(--ui-border);
  }

  /* Theme signature: the specimen field label. A herbarium sheet prints its
     field names small, letterspaced and quiet, above the value. */
  .mg-field {
    @apply font-sans font-semibold uppercase;
    font-size: 0.75rem;
    letter-spacing: 0.08em;
    color: var(--ui-text-muted);
    font-variant-numeric: lining-nums;
  }

  /* True small caps where the family supplies them; the letterspaced
     uppercase above is the fallback voice for short labels. */
  .mg-smallcaps {
    font-variant-caps: all-small-caps;
    letter-spacing: 0.06em;
  }

  /* Theme signature: the datum. Every measured value wears this. */
  .mg-datum {
    @apply font-mono;
    font-variant-numeric: tabular-nums slashed-zero;
  }

  /* Elevation, the only kind this theme has: a rule plus the faintest
     possible shadow. Popovers and drawers, nothing else. */
  .mg-sheet {
    border: 1px solid var(--ui-border);
    box-shadow: var(--shadow-mg-sheet);
    background: var(--ui-bg);
  }

  /* Plate caption. Sits under a figure, map or table. */
  .mg-caption {
    @apply font-serif italic;
    font-size: 0.9375rem;
    color: var(--ui-text-muted);
  }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

## App Config

```ts
// app.config.ts
export default defineAppConfig({
  ui: {
    colors: { primary: 'blue', secondary: 'red', neutral: 'stone' },

    button: {
      slots: {
        base: 'font-sans font-semibold rounded-mg transition-colors duration-150 ease-out',
      },
      variants: {
        size: {
          md: { base: 'h-11 sm:h-10 px-4 text-sm' },
          lg: { base: 'h-11 px-5 text-base' },
        },
      },
      compoundVariants: [
        { color: 'primary', variant: 'solid', class: 'bg-mg-accent text-mg-paper hover:bg-[#243C64]' },
        { color: 'primary', variant: 'outline', class: 'border-mg-rule-strong text-mg-ink hover:bg-mg-paper-leaf hover:border-mg-ink-soft' },
        { color: 'secondary', variant: 'outline', class: 'border-mg-strike/50 text-mg-strike hover:bg-mg-strike/8' },
      ],
      defaultVariants: { color: 'primary', variant: 'solid', size: 'md' },
    },

    card: {
      slots: {
        root: 'rounded-mg bg-default border border-default shadow-none divide-y divide-default',
        header: 'px-4 py-3',
        title: 'font-serif font-semibold text-highlighted',
        description: 'font-serif text-muted',
        body: 'p-4',
        footer: 'px-4 py-3',
      },
      variants: {
        variant: {
          outline: { root: 'bg-default' },
          soft: { root: 'bg-muted border-transparent' },
          subtle: { root: 'bg-muted border-default' },
        },
      },
      defaultVariants: { variant: 'outline' },
    },

    badge: {
      slots: {
        base: 'font-sans font-semibold uppercase tracking-[0.08em] rounded-mg inline-flex items-center',
      },
      variants: {
        variant: {
          subtle: 'bg-elevated text-toned',
          outline: 'bg-transparent border border-default text-muted',
        },
      },
      defaultVariants: { color: 'neutral', variant: 'subtle' },
    },

    input: {
      slots: {
        base: 'font-sans rounded-mg bg-default border border-accented focus:border-mg-accent focus:ring-0 transition-colors duration-150 ease-out',
      },
      defaultVariants: { color: 'primary', variant: 'outline', size: 'md' },
    },

    separator: {
      slots: { border: 'border-default' },
      defaultVariants: { type: 'solid', size: 'xs' },
    },

    table: {
      slots: {
        th: 'font-sans font-semibold uppercase tracking-[0.08em] text-xs text-muted border-b border-default',
        td: 'font-mono tabular-nums border-b border-muted',
      },
    },

    tabs: {
      slots: {
        list: 'border-b border-default',
        trigger: 'font-sans text-sm text-muted data-[state=active]:text-highlighted data-[state=active]:border-b data-[state=active]:border-mg-accent transition-colors duration-150 ease-out',
      },
    },

    modal: {
      slots: { content: 'rounded-mg border border-default shadow-mg-sheet' },
    },
  },
})
```

## Key Patterns

1. **Hairline rules, not borders**: 1px solid in `--ui-border`, a warm grey. Never dashed (that is devtool's voice), never a heavy black frame (that is blueprint's).
2. **Committed serif**: Source Serif 4 carries body prose *and* headings. The serif is the reading voice, not a decoration on a heading.
3. **Specimen field labels**: `.mg-field` or `.mg-smallcaps` — letterspaced uppercase or true small caps, above the value, the way a herbarium sheet prints a field name.
4. **Tabular figures on columns, oldstyle in prose**: `tabular-nums slashed-zero` on anything columnar; `oldstyle-nums` on running text.
5. **Paper and ink**: `#FBF9F5` warm off-white and `#211E1A` warm near-black. Never `#ffffff`, never `#000000`.
6. **2px radius everywhere**: a crisp cut edge, not a rounded card.
7. **Near-zero shadow**: paper is flat. Elevation for popovers and drawers is `.mg-sheet`, a rule plus the faintest possible shadow.
8. **One accent, one strike**: `--color-mg-accent` for interactive and selected state; `--color-mg-strike` only for destructive or removal actions. Both used sparingly.
