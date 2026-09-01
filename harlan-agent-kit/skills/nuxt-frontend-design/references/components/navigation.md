# Navigation Patterns

Sidebar, breadcrumbs, command palette, and header patterns for Nuxt UI.

---

## Header

```vue
<UHeader :links="[
  { label: 'Docs', to: '/docs' },
  { label: 'Pricing', to: '/pricing' },
  { label: 'Blog', to: '/blog' }
]">
  <template #logo>
    <span class="font-display text-xl font-bold">AppName</span>
  </template>

  <template #right>
    <UButton variant="ghost" to="/login">Sign In</UButton>
    <UButton to="/signup">Get Started</UButton>
  </template>
</UHeader>
```

### Sticky Blur Header
```vue
<UHeader :ui="{
  root: 'sticky top-0 z-50 backdrop-blur-lg bg-default/80 border-b border-default'
}" />
```

---

## Sidebar Navigation

```vue
<UDashboardSidebar>
  <UNavigationMenu :items="[
    { label: 'Dashboard', icon: 'i-lucide-layout-dashboard', to: '/' },
    { label: 'Projects', icon: 'i-lucide-folder', to: '/projects' },
    { label: 'Settings', icon: 'i-lucide-settings', to: '/settings' }
  ]" />
</UDashboardSidebar>
```

---

## Breadcrumbs

```vue
<UBreadcrumb :items="[
  { label: 'Home', to: '/' },
  { label: 'Projects', to: '/projects' },
  { label: 'My Project' }
]" />
```

---

## Command Palette (Cmd+K)

```vue
<UContentSearch />
```

For custom command palette:
```vue
<UCommandPalette
  :groups="[
    {
      key: 'pages',
      label: 'Pages',
      commands: [
        { id: 'home', label: 'Home', to: '/' },
        { id: 'settings', label: 'Settings', to: '/settings' }
      ]
    }
  ]"
/>
```

---

## Tabs Navigation

```vue
<UTabs :items="[
  { label: 'Overview', slot: 'overview', icon: 'i-lucide-layout-grid' },
  { label: 'Analytics', slot: 'analytics', icon: 'i-lucide-bar-chart-3' },
  { label: 'Settings', slot: 'settings', icon: 'i-lucide-settings' }
]">
  <template #overview>...</template>
  <template #analytics>...</template>
  <template #settings>...</template>
</UTabs>
```

---

## Dashboard Principles

- **Keyboard first**: j/k navigation, Cmd+K palette
- **Right-click context menus**: Power users expect them
- **Filters persist in URL**: Refresh doesn't reset, shareable
- **Filter pills**: Active filters as removable tags
