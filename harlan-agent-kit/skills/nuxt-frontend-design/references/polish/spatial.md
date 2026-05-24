# Spatial Composition

Layout, whitespace, and visual rhythm that creates character.

---

## Spacing System

Use a 4pt base grid — 8pt is too coarse (you'll constantly need 12px between 8 and 16):

`4, 8, 12, 16, 24, 32, 48, 64, 96px`

Name tokens semantically (`--space-sm`, `--space-lg`), not by value (`--spacing-8`). Use `gap` instead of margins for sibling spacing — eliminates margin collapse and cleanup hacks.

---

## The Squint Test

Blur your eyes (or blur a screenshot). Can you still identify:
- The most important element?
- The second most important?
- Clear groupings?

If everything looks the same weight blurred, you have a hierarchy problem.

### Hierarchy Through Multiple Dimensions

Don't rely on size alone. Combine:

| Tool | Strong | Weak |
|------|--------|------|
| Size | 3:1+ ratio | <2:1 ratio |
| Weight | Bold vs Regular | Medium vs Regular |
| Color | High contrast | Similar tones |
| Position | Top/left (primary) | Bottom/right |
| Space | Surrounded by whitespace | Crowded |

The best hierarchy uses 2-3 dimensions at once: larger, bolder, AND more space above.

---

## Break the Grid

Predictable layouts feel generic. Introduce controlled asymmetry:

```vue
<!-- Offset grid — items don't align perfectly -->
<div class="grid grid-cols-3 gap-6">
  <div class="col-span-2 mt-8">Large feature</div>
  <div class="col-span-1 -mt-4">Small accent</div>
</div>

<!-- Overlapping elements -->
<div class="relative">
  <div class="absolute -top-6 -right-6 z-10">Floating badge</div>
  <UCard>Main content</UCard>
</div>

<!-- Diagonal flow -->
<div class="grid grid-cols-2 gap-8">
  <div class="justify-self-start">Left item</div>
  <div class="justify-self-end mt-16">Right item, offset down</div>
</div>
```

### Self-Adjusting Grid

Responsive grid without breakpoints — columns are at least 280px, as many as fit:

```css
.auto-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: var(--space-md);
}
```

---

## Cards: Use Sparingly

Cards are overused. Spacing and alignment create visual grouping naturally. Use cards only when:
- Content is truly distinct and actionable
- Items need visual comparison in a grid
- Content needs clear interaction boundaries

**Never nest cards inside cards** — use spacing, typography, and subtle dividers for hierarchy within a card.

---

## Whitespace (Negative Space)

Generous whitespace signals quality. Cramped layouts feel cheap.

```css
/* Section spacing — generous */
.section { @apply py-24 md:py-32; }
.section-tight { @apply py-16 md:py-20; }

/* Content max-width — don't stretch to full screen */
.content-narrow { @apply max-w-2xl mx-auto; }
.content-medium { @apply max-w-4xl mx-auto; }
```

### Density Levels

| Context | Approach |
|---------|----------|
| Landing page | Generous space, breathing room between sections |
| Dashboard | Controlled density, tight but organized |
| Documentation | Medium spacing, readable column width |
| Pricing page | Cards need room to be compared side-by-side |

---

## Bento Grid

Irregular grid cells create visual interest:

```css
.bento-grid {
  @apply grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 lg:gap-6;
}

/* Cell sizes */
.bento-featured { @apply col-span-1 row-span-1 lg:col-span-2 lg:row-span-2; }
.bento-wide { @apply col-span-1 lg:col-span-2; }
.bento-tall { @apply row-span-1 lg:row-span-2; }
```

---

## Container Queries

Viewport queries are for page layouts. Container queries are for components:

```css
.card-container {
  container-type: inline-size;
}

/* Card adapts to its container, not viewport */
@container (min-width: 400px) {
  .card { grid-template-columns: 120px 1fr; }
}
```

A card in a narrow sidebar stays compact; the same card in main content expands — automatically, without viewport hacks.

---

## Layering & Depth

Create depth through overlapping layers:

```vue
<div class="relative">
  <!-- Background layer -->
  <div class="absolute inset-0 bg-gradient-to-br from-primary-50 to-transparent rounded-3xl" />

  <!-- Decorative elements -->
  <div class="absolute -top-4 -right-4 w-24 h-24 bg-accent/10 rounded-full blur-2xl" />

  <!-- Content (foreground) -->
  <div class="relative z-10 p-8">
    <slot />
  </div>
</div>
```

### Z-Index Scale

Use semantic z-index instead of arbitrary numbers:

| Layer | Range |
|-------|-------|
| Dropdown | 10 |
| Sticky | 20 |
| Modal backdrop | 30 |
| Modal | 40 |
| Toast | 50 |
| Tooltip | 60 |

### Shadows

Create a consistent elevation scale (sm → md → lg → xl). Shadows should be subtle — if you can clearly see it, it's probably too strong.

---

## Optical Adjustments

- Text at `margin-left: 0` looks indented due to letterform whitespace — nudge with `-0.05em` to optically align
- Geometrically centered icons often look off-center: play icons shift right, arrows shift toward their direction
- Touch targets must be 44px+ minimum, even if the visual element is smaller — use padding or pseudo-elements to expand the hit area

---

## Backgrounds & Atmosphere

Create depth and character beyond flat colors:

```css
/* Gradient mesh */
.bg-mesh {
  background-image:
    radial-gradient(at 20% 30%, rgba(168, 85, 247, 0.15) 0%, transparent 50%),
    radial-gradient(at 80% 20%, rgba(59, 130, 246, 0.1) 0%, transparent 40%),
    radial-gradient(at 60% 80%, rgba(34, 211, 238, 0.08) 0%, transparent 45%);
}

/* Noise texture overlay */
.bg-noise {
  background-image: url("data:image/svg+xml,..."); /* tiny noise SVG */
  opacity: 0.03;
}

/* Dot grid pattern */
.bg-dots {
  background-image: radial-gradient(circle, rgba(0,0,0,0.1) 1px, transparent 1px);
  background-size: 20px 20px;
}
```

---

## Anti-Patterns

- Even spacing everywhere (no rhythm)
- Content stretching to full width
- All items perfectly aligned (too rigid)
- No layering/depth (flat)
- Identical spacing between all sections
- Wrapping everything in identical cards
- Nesting cards recursively
- Arbitrary spacing values outside your scale
- Creating hierarchy through size alone
