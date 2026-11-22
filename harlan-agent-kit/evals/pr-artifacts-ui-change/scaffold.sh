#!/usr/bin/env bash
set -e
mkdir -p app/components/layout app/components/bing
cat > package.json <<'JSON'
{
  "name": "eval-dashboard",
  "private": true,
  "scripts": { "dev": "nuxt dev" },
  "dependencies": { "nuxt": "^4.2.0", "@nuxt/ui": "^4.1.0" }
}
JSON
cat > app/components/layout/PageHeader.vue <<'VUE'
<script setup lang="ts">
const { groups, selected } = useSiteGroups()
</script>

<template>
  <header class="flex items-center justify-between">
    <h1>Sites</h1>
    <USelect v-model="selected" :items="groups" placeholder="All sites" />
  </header>
</template>
VUE
cat > app/components/layout/AppSidebar.vue <<'VUE'
<template>
  <aside class="w-60">
    <SidebarNav />
  </aside>
</template>
VUE
cat > app/components/bing/BingOffersCard.vue <<'VUE'
<script setup lang="ts">
const { data: offers } = await useFetch('/api/bing/offers')
</script>

<template>
  <UCard>
    <p>{{ offers?.length ?? 0 }} Bing offers</p>
    <BingOffersModal :offers="offers ?? []" />
  </UCard>
</template>
VUE
cat > app/components/bing/BingOffersModal.vue <<'VUE'
<script setup lang="ts">
const { offers } = defineProps<{ offers: { id: string, site: string }[] }>()
</script>

<template>
  <UModal title="Bing offers">
    <ul>
      <li v-for="offer in offers" :key="offer.id">{{ offer.site }}</li>
    </ul>
  </UModal>
</template>
VUE
git init -q -b main
git config user.email eval@example.com
git config user.name Eval
git add -A
git commit -qm "chore: add the dashboard shell"

cat > app/components/layout/PageHeader.vue <<'VUE'
<template>
  <header class="flex items-center justify-between">
    <h1>Sites</h1>
  </header>
</template>
VUE
cat > app/components/layout/AppSidebar.vue <<'VUE'
<script setup lang="ts">
const { groups, selected } = useSiteGroups()
</script>

<template>
  <aside class="w-60">
    <USelect v-model="selected" :items="groups" placeholder="All sites" class="mb-4" />
    <SidebarNav />
  </aside>
</template>
VUE
cat > app/components/bing/BingOffersCard.vue <<'VUE'
<script setup lang="ts">
const { selected } = useSiteGroups()
const { data: offers } = await useFetch('/api/bing/offers', { query: { group: selected } })
</script>

<template>
  <UCard>
    <p>{{ offers?.length ?? 0 }} Bing offers in {{ selected ?? 'all sites' }}</p>
    <BingOffersModal :offers="offers ?? []" :group="selected" />
  </UCard>
</template>
VUE
cat > app/components/bing/BingOffersModal.vue <<'VUE'
<script setup lang="ts">
const { offers, group } = defineProps<{ offers: { id: string, site: string }[], group?: string }>()
</script>

<template>
  <UModal :title="group ? `Bing offers in ${group}` : 'Bing offers'">
    <ul>
      <li v-for="offer in offers" :key="offer.id">{{ offer.site }}</li>
    </ul>
  </UModal>
</template>
VUE
