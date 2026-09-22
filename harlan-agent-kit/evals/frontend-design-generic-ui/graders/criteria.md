---
type: llm
weight: 1
---

Read the whole transcript, not only the last message.

The response applies the `nuxt-frontend-design` skill. A passing response:

- Names concrete design moves: type scale, spacing rhythm, hierarchy, tokens, motion.
- Uses Nuxt UI v4 components and design tokens rather than raw ad-hoc classes.
- Proposes or writes real component changes.

It fails if it only restates the complaint, or gives generic advice with no
reference to Nuxt UI tokens or components.
