<script setup lang="ts">
import type { RepositoryStats } from '../../../src/stats.ts'

defineProps<{ repositories: RepositoryStats[] }>()
</script>

<template>
  <section class="min-w-0" aria-labelledby="stats-repositories-heading">
    <UiSectionHeader id="stats-repositories-heading" title="Repositories" />
    <UiTableShell label="Runs and results per repository" size="sm" row-hover>
      <template #head>
        <UiTableTh>Repository</UiTableTh>
        <UiTableTh numeric>
          Runs
        </UiTableTh>
        <UiTableTh numeric>
          Pull requests changed
        </UiTableTh>
        <UiTableTh numeric>
          Repair commits
        </UiTableTh>
        <UiTableTh numeric>
          Conflicts resolved
        </UiTableTh>
        <UiTableTh numeric>
          Pull requests opened
        </UiTableTh>
        <UiTableTh numeric>
          Review issues found
        </UiTableTh>
      </template>
      <tr v-for="entry in repositories" :key="entry.repository">
        <UiTableTd row-header size="sm">
          <a :href="`https://github.com/${entry.repository}`" target="_blank" rel="noreferrer" class="entity-link text-sm">
            <RepositoryIdentity :repository="entry.repository" />
          </a>
        </UiTableTd>
        <UiTableTd v-for="(metric, index) in [entry.runs, entry.changedPullRequests, entry.fixCommits, entry.conflictResolutions, entry.openedPullRequests, entry.reviewFindings]" :key="index" numeric size="sm">
          <UiTableMetricCell :value="metric" />
        </UiTableTd>
      </tr>
    </UiTableShell>
  </section>
</template>
