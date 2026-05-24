# Table Patterns

Nuxt UI table component for data display.

---

## Basic Table

```vue
<script setup lang="ts">
interface Project {
  id: string
  name: string
  status: 'active' | 'archived' | 'draft'
  updated: string
}

const columns = [
  { key: 'name', label: 'Project' },
  { key: 'status', label: 'Status' },
  { key: 'updated', label: 'Last Updated' },
  { key: 'actions', label: '' }
]

const projects = ref<Project[]>([...])
</script>

<template>
  <UTable :columns="columns" :rows="projects">
    <template #status-data="{ row }">
      <UBadge
        :color="row.status === 'active' ? 'success' : 'neutral'"
        variant="subtle"
      >
        {{ row.status }}
      </UBadge>
    </template>

    <template #actions-data="{ row }">
      <UDropdownMenu :items="[
        [{ label: 'Edit', icon: 'i-lucide-pencil' }],
        [{ label: 'Delete', icon: 'i-lucide-trash-2', color: 'error' }]
      ]">
        <UButton icon="i-lucide-ellipsis" variant="ghost" size="sm" />
      </UDropdownMenu>
    </template>
  </UTable>
</template>
```

---

## Empty State

Never show an empty table. Use `UEmpty`:

```vue
<template>
  <UTable v-if="projects.length" :columns="columns" :rows="projects" />

  <UEmpty
    v-else
    icon="i-lucide-folder-open"
    title="No projects yet"
    description="Create your first project to get started."
    :actions="[{ label: 'New Project', click: createProject }]"
  />
</template>
```

For filtered / searched tables where "reset filters" is the useful action, prefer [`UiNoData`](../../templates/components/UiNoData.vue) with an action preset — see [library.md](../library.md).

---

## Sortable Columns

```vue
const columns = [
  { key: 'name', label: 'Project', sortable: true },
  { key: 'updated', label: 'Last Updated', sortable: true },
]
```

---

## Row Actions

- Use `UDropdownMenu` with icon button for row actions
- Group destructive actions in separate section
- Use `color="error"` for delete actions

---

## Loading State

```vue
<UTable :columns="columns" :rows="projects" :loading="pending" />
```

For row-level skeleton placeholders (e.g. inside a custom cell renderer or a non-table list) use [`UiSkeleton`](../../templates/components/UiSkeleton.vue) — deterministic widths via seeded pseudo-random, so SSR + client render identically. See [library.md](../library.md).

---

## Typography in Tables

Use `font-variant-numeric: tabular-nums` (Tailwind: `tabular-nums`) on any column with numbers — digits align in columns. Apply to price, count, date, and ID columns.

---

## Dashboard Table Principles

From Linear's approach:
- **Data tables over cards** — cards waste space for data-heavy views
- **Status indicators > progress bars** — "Done" badge beats 100% bar
- **Batch operations** — checkbox column + bulk action bar on select
- **Inline editing** — click to edit, don't navigate away
- **Relative timestamps** — "2h ago" not "2024-01-05 14:32"
- **Responsive**: Tables transform to stacked cards on mobile — use `UTable`'s responsive handling or hide low-priority columns
