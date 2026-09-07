<script setup lang="ts">
import type { UiIcon } from '../../utils/ui-icons.ts'
import { resolveUiIcon } from '../../utils/ui-icons.ts'

/**
 * UiIcon — the icon primitive. A thin, typed wrapper over Nuxt UI's `<UIcon>`.
 *
 * The `name` is a curated semantic role (`refresh`, `next`, `delete`, …) or an
 * explicitly sourced `i-*` id. nuxtseo resolves roles through build-time icon
 * aliases; this dashboard has one icon set, so a small runtime map resolves the
 * role to its Octicon and an unknown name passes straight through.
 */
const { name } = defineProps<{ name?: UiIcon }>()

const resolved = computed(() => name === undefined ? undefined : resolveUiIcon(name))
</script>

<template>
  <UIcon v-if="resolved" :name="resolved" />
</template>
