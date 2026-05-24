# Feedback & Overlay Patterns

Toasts, modals, confirmations, and state communication.

---

## Toast Notifications

Use `useAppToast()` — a typed wrapper over `useToast()` with preset icons and colors per status. Copy [useAppToast.ts](../../templates/composables/useAppToast.ts) into `app/composables/` first. See [library.md](../library.md).

```ts
const toast = useAppToast()

// String shorthand — just a title
toast.success('Saved')

// Full form
toast.error({ title: 'Failed to save', description: error.message })
toast.warning({ title: 'Unsaved changes', description: 'Save before leaving.' })
toast.info({ title: 'New version available', actions: [{ label: 'Reload', click: reload }] })
```

Why the wrapper: direct `useToast().add({ color, icon, ... })` calls scatter status semantics across the codebase. A typed `.success / .info / .warning / .error` API keeps status meaning in one place, matches call-sites to intent, and makes find-all-errors-in-the-app a single grep.

### Undo Pattern (prefer over confirm dialogs)
```ts
const toast = useAppToast()

function deleteItem(id: string) {
  const backup = items.value.find(i => i.id === id)
  items.value = items.value.filter(i => i.id !== id)

  toast.info({
    title: 'Deleted',
    actions: [{
      label: 'Undo',
      click: () => { items.value.push(backup!) },
    }],
  })

  setTimeout(() => api.delete(id), 5000)
}
```

---

## Modal Dialogs

```vue
<script setup lang="ts">
const open = ref(false)
</script>

<template>
  <UButton @click="open = true">Open Settings</UButton>

  <UModal v-model:open="open">
    <template #header>
      <h3 class="text-lg font-semibold">Settings</h3>
    </template>

    <div class="p-6">
      <!-- Modal content -->
    </div>

    <template #footer>
      <div class="flex justify-end gap-3">
        <UButton variant="outline" @click="open = false">Cancel</UButton>
        <UButton @click="save">Save</UButton>
      </div>
    </template>
  </UModal>
</template>
```

---

## Confirmation (when undo isn't possible)

```vue
<UModal v-model:open="confirmOpen">
  <div class="p-6 text-center">
    <UIcon name="i-lucide-alert-triangle" class="text-4xl text-warning mb-4" />
    <h3 class="text-lg font-semibold">Delete "{{ project.name }}"?</h3>
    <p class="text-muted mt-2">All files and settings will be permanently removed.</p>
    <div class="flex justify-center gap-3 mt-6">
      <UButton variant="outline" @click="confirmOpen = false">Keep project</UButton>
      <UButton color="error" @click="confirmDelete">Delete project</UButton>
    </div>
  </div>
</UModal>
```

**Rules**:
- Prefer "Undo" toasts over confirmation dialogs — users click through confirmations mindlessly
- Only use confirmation for truly irreversible, high-cost, or batch operations
- Button labels must be verb-object pairs — "Delete project" not "OK", "Keep project" not "Cancel"
- Explain specific consequences — "All files and settings will be permanently removed" not "This action cannot be undone"

---

## Dropdown Menus

```vue
<UDropdownMenu :items="[
  [
    { label: 'Edit', icon: 'i-lucide-pencil' },
    { label: 'Duplicate', icon: 'i-lucide-copy' }
  ],
  [
    { label: 'Delete', icon: 'i-lucide-trash-2', color: 'error' }
  ]
]">
  <UButton icon="i-lucide-ellipsis-vertical" variant="ghost" />
</UDropdownMenu>
```

---

## Tooltips

```vue
<UTooltip text="Copy to clipboard">
  <UButton icon="i-lucide-copy" variant="ghost" />
</UTooltip>
```

---

## Alert Banners

```vue
<UAlert
  title="New version available"
  description="Update to v2.0 for new features."
  icon="i-lucide-info"
  color="info"
  :actions="[{ label: 'Update', click: update }]"
/>
```

---

## Empty States

Use `UEmpty` (v4+) for simple cases:

```vue
<UEmpty
  icon="i-lucide-inbox"
  title="No messages"
  description="When you receive messages, they'll appear here."
  :actions="[{ label: 'Compose', variant: 'outline', click: compose }]"
/>
```

For richer empty states with action presets (refresh / reset / clear / back) and custom footer, copy [UiNoData.vue](../../templates/components/UiNoData.vue) into `app/components/`. See [library.md](../library.md).

```vue
<UiNoData
  icon="i-lucide-search-x"
  title="No results"
  message="Try clearing filters or broadening your search."
  action="reset"
  @action="clearFilters"
/>
```
