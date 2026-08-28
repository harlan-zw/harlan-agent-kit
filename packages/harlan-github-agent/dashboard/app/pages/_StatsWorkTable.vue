<script setup lang="ts">
import type { StatsWork } from '../../../src/stats.ts'

const props = defineProps<{
  work: StatsWork[]
  from: string
  to: string
}>()

const taskLabels = {
  review_fix: 'Repair',
  conflict_resolution: 'Conflict resolution',
  baseline_repair: 'Baseline repair',
  issue_triage: 'Issue triage',
  issue_work: 'Issue work',
} as const
const maximumRuns = computed(() => Math.max(1, ...props.work.map(entry => entry.runs)))

function runWidth(runs: number): string {
  return `${runs === 0 ? 0 : Math.max(3, runs / maximumRuns.value * 100)}%`
}

function label(entry: StatsWork): string {
  if (entry._tag === 'PullRequestTriage')
    return 'Pull request triage'
  if (entry._tag === 'Review')
    return 'Review'
  if (entry._tag === 'Routine')
    return 'Routine'
  return taskLabels[entry.work]
}

function result(entry: StatsWork): string {
  if (entry._tag === 'PullRequestTriage')
    return `${entry.reviewRequired} sent to Review, ${entry.reviewSkipped} skipped, ${entry.reviewRequiredAfterFailure} could not decide`
  if (entry._tag === 'Review')
    return `${entry.ready} ready, ${entry.pending} pending, ${entry.blocked} blocked, ${entry.findings} issues found`
  if (entry._tag === 'Routine')
    return `${entry.completed} completed, ${entry.actionRequired} action required, ${entry.failed} failed, ${entry.skipped} skipped`
  return `${entry.completed} completed, ${entry.actionRequired} action required, ${entry.failed} failed, ${entry.publishedCommits} commits published`
}

function duration(milliseconds: number | null): string {
  if (milliseconds === null)
    return 'No duration yet'
  if (milliseconds < 60_000)
    return `${Math.max(1, Math.round(milliseconds / 1_000))}s median`
  return `${Math.round(milliseconds / 60_000)}m median`
}

function historyWork(entry: StatsWork): string {
  if (entry._tag === 'PullRequestTriage')
    return 'pull_request_triage'
  if (entry._tag === 'Review')
    return 'adversarial_review'
  if (entry._tag === 'Routine')
    return 'routine_scan'
  return entry.work
}

function historyLink(entry: StatsWork): { path: string, query: Record<string, string> } {
  return { path: '/history', query: { from: props.from, to: props.to, work: historyWork(entry) } }
}
</script>

<template>
  <section class="min-w-0" aria-labelledby="stats-work-heading">
    <div class="zone-header">
      <h2 id="stats-work-heading" class="text-sm font-medium uppercase tracking-wide text-dimmed sm:text-xs">
        Work results
      </h2>
      <hr class="zone-rule">
    </div>
    <div class="mt-4 max-w-full overflow-x-auto">
      <table class="w-full min-w-[46rem] text-left text-sm">
        <thead class="border-b border-default text-sm text-dimmed sm:text-xs">
          <tr>
            <th scope="col" class="pb-2 pr-4 font-medium">
              Work
            </th>
            <th scope="col" class="pb-2 pr-4 text-right font-medium">
              Runs
            </th>
            <th scope="col" class="pb-2 px-4 font-medium">
              Results
            </th>
            <th scope="col" class="pb-2 px-4 text-right font-medium">
              Time
            </th>
            <th scope="col" class="pb-2 pl-4 text-right font-medium">
              Evidence
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr v-for="entry in work" :key="entry._tag === 'Task' ? entry.work : entry._tag">
            <th scope="row" class="py-3 pr-4 font-medium">
              {{ label(entry) }}
            </th>
            <td class="px-4 py-3 text-right font-mono tabular-nums">
              {{ entry.runs }}
              <div class="ml-auto mt-1 h-1 w-16 bg-muted" aria-hidden="true">
                <div class="h-full bg-primary/75" :style="{ width: runWidth(entry.runs) }" />
              </div>
            </td>
            <td class="px-4 py-3 text-muted">
              {{ result(entry) }}
            </td>
            <td class="px-4 py-3 text-right font-mono text-sm text-dimmed sm:text-xs">
              {{ duration(entry.medianDurationMs) }}
            </td>
            <td class="py-3 pl-4 text-right">
              <NuxtLink :to="historyLink(entry)" class="entity-link">
                History
              </NuxtLink>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
