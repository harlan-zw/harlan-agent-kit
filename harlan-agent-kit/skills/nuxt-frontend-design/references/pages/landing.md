# Landing Page Patterns

Reference: **Stripe**

---

## File Structure

```
index.vue MAX 200 lines
IF section > 50 lines → extract to components/landing/{Section}.vue
```

Components:
- `HeroSection.vue` — title, CTAs, visual
- `FeaturesSection.vue` — bento/grid
- `PricingSection.vue` — tiers
- `CTASection.vue` — final CTA
- `TrustBar.vue` — logos, stats

---

## Nuxt UI Pro Components

| Pattern | Component |
|---------|-----------|
| Hero | `UPageHero` |
| Sections | `UPageSection` |
| Feature grids | `UPageGrid` + `UPageFeature` |
| Pricing | `UPricingPlans` + `UPricingPlan` |
| CTA | `UPageCTA` |
| Logos | `UPageLogos` |

**PROHIBITED**: Reimplementing these patterns manually.

---

## Page Template

```vue
<template>
  <div>
    <LandingHero>
      <template #visual><HeroVisual /></template>
    </LandingHero>
    <TrustBar :logos="logos" />
    <FeaturesGrid :features="features" />
    <PricingSection :plans="plans" />
    <CtaSection title="Ready?" :links="ctaLinks" />
  </div>
</template>
```

---

## Best Practices

**Show, Don't Tell:**
- Hero animates product working (silent demo)
- Features show UI screenshots, not icons
- Logos: Figma, Linear, Notion (not IBM, Oracle)

**Psychology:**
- Enterprise tier anchors Pro ($999 makes $49 feel cheap)
- Specific stats: "$640B+ processed" not "trusted by thousands"
- Verb-first CTAs: "Start building" not "Get started"

**Social Proof:**
- B2B: Logo bar
- Consumer: Avatar stack + count
- High-trust: Named testimonials with photos

**Dev Products:**
- Code that actually runs
- Language tabs (Python, Node, Ruby)
- Styled terminal output
