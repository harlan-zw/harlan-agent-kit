<script setup lang="ts">
/** Terms in the field label style, values beside them. Mono for identifiers. */
export interface DetailItem {
  term: string
  value: string | number
  mono?: boolean
  href?: string
}

const { items, columns = 1 } = defineProps<{
  items: DetailItem[]
  columns?: 1 | 2
}>()
</script>

<template>
  <dl class="grid gap-x-6 gap-y-2" :class="columns === 2 ? 'grid-cols-[auto_1fr_auto_1fr]' : 'grid-cols-[auto_1fr]'">
    <template v-for="item in items" :key="item.term">
      <dt class="field-label self-center">
        {{ item.term }}
      </dt>
      <dd class="min-w-0 truncate text-sm" :class="item.mono ? 'font-mono' : undefined">
        <a v-if="item.href" :href="item.href" target="_blank" rel="noreferrer" class="entity-link">{{ item.value }}</a>
        <template v-else>
          {{ item.value }}
        </template>
      </dd>
    </template>
  </dl>
</template>
