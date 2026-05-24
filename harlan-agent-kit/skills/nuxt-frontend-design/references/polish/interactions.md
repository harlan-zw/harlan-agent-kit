# Micro Interactions

Small UI details that make a design feel polished and alive.

---

## The Eight Interactive States

Every interactive element needs these states designed:

| State | When | Visual Treatment |
|-------|------|------------------|
| Default | At rest | Base styling |
| Hover | Pointer over (not touch) | Subtle lift, color shift |
| Focus | Keyboard/programmatic focus | Visible ring (see below) |
| Active | Being pressed | Pressed in, darker |
| Disabled | Not interactive | Reduced opacity, no pointer |
| Loading | Processing | Spinner, skeleton |
| Error | Invalid state | Red border, icon, message |
| Success | Completed | Green check, confirmation |

**Common miss**: Designing hover without focus, or vice versa. Keyboard users never see hover states.

---

## Hover States

Every interactive element needs a visible hover response. CSS transitions are fine here — no motion library needed.

```css
/* Card lift */
.card-hover {
  transition: transform 200ms ease, box-shadow 200ms ease;
}
.card-hover:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 24px rgba(0, 0, 0, 0.08);
}

/* Subtle scale */
.scale-hover {
  transition: transform 200ms ease;
}
.scale-hover:hover {
  transform: scale(1.02);
}

/* Border glow */
.glow-hover {
  transition: border-color 200ms ease, box-shadow 200ms ease;
}
.glow-hover:hover {
  border-color: rgba(var(--color-primary-500), 0.5);
  box-shadow: 0 0 20px rgba(var(--color-primary-500), 0.15);
}
```

### Spring Hovers (CSS)

Use `mcp__motion__generate-css-spring` to generate spring easing for more physical feel:

```css
/* Snappy card spring — bounce: 0.2, duration: 0.35s */
.spring-card {
  transition: transform 350ms linear(0, 0.3566, 0.7963, 1.0045, 1.0459, 1.0287, 1.0088, 0.9996, 1);
}
.spring-card:hover {
  transform: translateY(-4px) scale(1.01);
}

/* Bouncy button spring — bounce: 0.3, duration: 0.55s */
.spring-button {
  transition: transform 550ms linear(0, 0.1719, 0.4986, 0.7952, 0.9887, 1.0779, 1.0939, 1.0726, 1.0412, 1.0148, 0.9986, 1);
}
.spring-button:hover {
  transform: scale(1.05);
}
```

---

## Focus States

Every focusable element must have a visible focus indicator:

```vue
<UButton class="focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2" />
```

Use `focus-visible` not `focus` — prevents showing ring on click, only on keyboard navigation.

---

## Button Feedback

Every pressable surface must respond to press within one frame. Missing press feedback is the single biggest "feels cheap" signal in a UI.

Two valid press shapes — pick one per project and apply consistently. The theme file's `Motion` or `Key Patterns` line dictates which:

- **Scale** (0.95–0.98) — feels like the surface compresses. Default for flat / glass / digital themes (frost, zen, neon, devtool). Anything larger than 0.95 reads as a bug.
- **TranslateY 1px** — feels like the surface depresses into the page. Mandatory for tactile themes where scale would look wrong (clay, kinetic-paper, teenage-engineering, blueprint).

Never mix both on the same element.

### Scale Press
```css
.press {
  transition: transform 100ms ease;
}
.press:active {
  transform: scale(0.97);
}
```

### Translate Press (tactile themes)
```css
.haptic:active {
  transform: translateY(1px);
}
```

### Asymmetric Press/Release

When the press represents a deliberate commitment (hold-to-delete, long-press menu, scrub), make the press slow and linear so the user has time to decide, and the release fast and eased so the system responds immediately. Slow where the user is deciding; fast where the system is responding.

```css
.hold-button:active .fill {
  transition: clip-path 2s linear;          /* deliberate, user is deciding */
  clip-path: inset(0 0 0 0);
}
.hold-button .fill {
  transition: clip-path 200ms ease-out;     /* snap back on release */
  clip-path: inset(0 100% 0 0);
}
```

---

## Origin-Aware Popovers

Popovers, dropdowns, tooltips, menus — any overlay anchored to a trigger — must scale in *from that trigger*, not from the centre of the overlay. The default `transform-origin: center` is almost always wrong here. Whether a single user notices is irrelevant; across a session the aggregate effect is the difference between "feels designed" and "feels assembled".

**Modals are the exception.** Modals are not anchored to a trigger — they appear centred in the viewport — so they keep `transform-origin: center`.

Reka UI exposes the trigger origin as a CSS variable. Use it:

```css
[data-reka-popper-content-wrapper] > * {
  transform-origin: var(--reka-popper-transform-origin);
}
```

For Nuxt UI's `UPopover`, `UTooltip`, `UDropdownMenu` — the underlying Reka primitive sets this variable; extend the existing `app.config.ts` slot styles rather than writing one-off classes.

---

## Tooltip Skip-Delay After First

Tooltips should delay ~400ms before appearing so mousing across a toolbar doesn't light up every icon. But once one tooltip is open, the next one hovered should appear instantly with no animation. This is how real toolbars feel responsive without forcing the user to stop and wait between adjacent elements.

Reka's `TooltipProvider` (and therefore `UTooltip`) handles this via `skip-delay-duration`:

```vue
<UApp :tooltip="{ delayDuration: 400, skipDelayDuration: 300 }">
  <!-- skipDelay: within 300ms of closing one tooltip, the next opens instantly -->
</UApp>
```

Set `skip-delay-duration` to around `delay-duration - 100ms`. Leaving it at the default (0) defeats the pattern.

---

## Loading States

### Skeleton Screens
Use `USkeleton` for content placeholders. Match the shape of the content they replace:

```vue
<template>
  <div v-if="pending" class="space-y-4">
    <USkeleton class="h-8 w-48" />
    <USkeleton class="h-4 w-full" />
    <USkeleton class="h-4 w-3/4" />
  </div>
  <div v-else>
    <!-- actual content -->
  </div>
</template>
```

### Button Loading
```vue
<UButton :loading="submitting" loading-icon="i-lucide-loader-2">
  Save Changes
</UButton>
```

### Optimistic Updates
Update UI immediately, revert on error:
```ts
const items = ref([...])
function removeItem(id: string) {
  const backup = [...items.value]
  items.value = items.value.filter(i => i.id !== id)
  try { await api.delete(id) }
  catch { items.value = backup }
}
```

---

## State Transitions

### Empty States
Never show a blank page. Empty states are onboarding moments:

```vue
<div v-if="!items.length" class="flex flex-col items-center py-16 text-center">
  <UIcon name="i-lucide-inbox" class="text-4xl text-dimmed mb-4" />
  <h3 class="text-lg font-semibold text-default">No items yet</h3>
  <p class="text-muted mt-1 max-w-sm">Create your first item to get started.</p>
  <UButton class="mt-6" @click="create">Create Item</UButton>
</div>
```

### Success Feedback
Brief, non-blocking confirmation:
```ts
const toast = useToast()
toast.add({ title: 'Saved', icon: 'i-lucide-check', color: 'success' })
```

---

## Sticky Headers with Blur

```vue
<header class="sticky top-0 z-50 backdrop-blur-lg bg-default/80 border-b border-default">
```

---

## Form Design

- **Placeholders aren't labels** — they disappear on input. Always use visible `<label>` elements
- **Validate on blur**, not every keystroke (exception: password strength)
- Place errors **below** fields with `aria-describedby` connecting them
- Use Nuxt UI's `UForm` + Zod — handles validation UX correctly out of the box

---

## Destructive Actions: Undo > Confirm

Undo is better than confirmation dialogs — users click through confirmations mindlessly:

1. Remove from UI immediately
2. Show undo toast (`toast.add({ title: 'Deleted', actions: [{ label: 'Undo', click: restore }] })`)
3. Actually delete after toast expires

Use confirmation only for truly irreversible (account deletion), high-cost, or batch operations.

---

## Keyboard Navigation

### Roving Tabindex

For component groups (tabs, menus, radio groups): one item is tabbable, arrow keys move within. Nuxt UI handles this in `UTabs`, `URadioGroup`, etc. — but if building custom components with Reka UI, implement this pattern.

### Skip Links

Provide `<a href="#main-content">Skip to main content</a>` for keyboard users. Hide off-screen, show on focus.

---

## Gesture Discoverability

Swipe-to-delete and similar gestures are invisible. Always:
- Partially reveal the action (peek from edge)
- Provide a visible fallback (menu with "Delete")

Never rely on gestures as the only way to perform an action.

---

## Anti-Patterns

- Removing focus indicators without replacement (`outline: none` alone)
- Using placeholder text as labels
- Touch targets < 44x44px
- Generic error messages ("Something went wrong")
- Custom controls without ARIA/keyboard support
- Hover-only functionality (touch users can't hover)
