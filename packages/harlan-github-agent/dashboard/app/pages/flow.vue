<script setup lang="ts">
/**
 * How work moves through the service. Static documentation, reached from the
 * overflow menu. Three marker styles, shown once in the heading row: a solid
 * hairline is implemented, a warning hairline waits for Harlan, a dashed error
 * hairline is a known gap.
 */
usePageTitle('How it works')
useHead({
  meta: [{ name: 'description', content: 'How Harlan GitHub Agent handles pull requests, issues, recovery, and GitHub writes.' }],
})

type Marker = 'implemented' | 'decision'

interface Branch {
  title: string
  text: string
  marker: Marker
}

interface Step {
  title: string
  text?: string
  branches?: Branch[]
}

const intake = [
  { icon: 'i-octicon-mark-github-16', title: 'GitHub App', text: 'Only installed harlan-zw repositories enter the service.' },
  { icon: 'i-octicon-repo-16', title: 'Repository checks', text: 'Match App access, Git origin, and a trusted checkout.' },
  { icon: 'i-octicon-sync-16', title: 'Poll GitHub', text: 'Read open human issues and pull requests.' },
  { icon: 'i-octicon-key-16', title: 'Exact state', text: 'Deduplicate each issue state and pull request head commit.' },
]

const pullRequestSteps: Step[] = [
  {
    title: 'Author gate',
    text: 'Skip GitHub Apps and automated accounts before any Queue work or comment.',
    branches: [
      { title: 'harlan-zw', text: 'Review starts automatically.', marker: 'implemented' },
      { title: 'Outside contributor', text: 'Wait for Review and repair Approval on the exact head commit.', marker: 'decision' },
    ],
  },
  {
    title: 'Merge state',
    text: 'GitHub decides which path can run.',
    branches: [
      { title: 'Clean', text: 'Continue to Review.', marker: 'implemented' },
      { title: 'Merge conflict, writable', text: 'Start Conflict resolution in a Git worktree.', marker: 'implemented' },
      { title: 'Unknown', text: 'Wait for GitHub.', marker: 'implemented' },
      { title: 'Not writable', text: 'Show the exact GitHub boundary.', marker: 'decision' },
    ],
  },
  { title: 'Conflict resolution', text: 'Merge the current base into the pull request branch, resolve the conflicts, and push one fix commit.' },
  { title: 'Adversarial review', text: 'The Review Agent reads the full diff and the surrounding code at high Reasoning effort.' },
  { title: 'One automated comment', text: 'The controller keeps one self-identified comment and posts READY, PENDING, or BLOCKED.' },
  { title: 'Rerun review', text: 'Harlan uses the dashboard or comments /harlan-agent rerun to queue the current head commit once.' },
  { title: 'GitHub status', text: 'Open pull requests stay live, and a completed Review caches the closed or merged state once.' },
]

const issueSteps: Step[] = [
  { title: 'Eligibility', text: 'Owned repositories enable Issue triage by default and ignore issues before the legacy cutoff.' },
  { title: 'Issue triage', text: 'The triage Agent checks the default branch, reproduction, comments, scope, difficulty, and impact in a Git worktree.' },
  {
    title: 'Triage result',
    branches: [
      { title: 'Invalid', text: 'Record why.', marker: 'implemented' },
      { title: 'Needs info', text: 'Record the missing evidence.', marker: 'implemented' },
      { title: 'Valid', text: 'Record the next action.', marker: 'implemented' },
    ],
  },
  {
    title: 'Approval',
    branches: [
      { title: 'harlan-zw', text: 'Issue work continues automatically.', marker: 'implemented' },
      { title: 'Outside contributor', text: 'Wait for Approval of that exact issue state.', marker: 'decision' },
    ],
  },
  { title: 'Issue work', text: 'The triage Agent resumes its own session, makes the change, and runs focused checks.' },
  { title: 'Draft pull request', text: 'The controller pushes the pinned commit to an allowed branch and opens one pull request.' },
]

const recovery = [
  { icon: 'i-octicon-git-commit-16', title: 'Base branch moved', text: 'Refresh the current base and continue Conflict resolution.', result: 'Requeue' },
  { icon: 'i-octicon-code-16', title: 'Invalid agent result', text: 'Use the strict response schema, then retry on the next GitHub poll.', result: 'Requeue' },
  { icon: 'i-octicon-git-merge-16', title: 'Conflicts return', text: 'Restore the Conflict resolution Task for that pull request state.', result: 'Requeue' },
  { icon: 'i-octicon-git-pull-request-closed-16', title: 'Head changed, closed, or merged', text: 'Stop old work within five seconds and follow the current GitHub state.', result: 'Stop old agent' },
  { icon: 'i-octicon-x-circle-16', title: 'Task cancelled', text: 'Stop the Agent and keep that Task cancelled for the current commit.', result: 'Cancel' },
]

const gaps = [
  { title: 'Claude review', text: 'The service starts Codex or opencode Agents only, so no Claude review runs.' },
  { title: 'Take Ownership', text: 'The service does not watch a merge deployment or run production smoke checks.' },
]

const roles = [
  { icon: 'i-octicon-hubot-16', title: 'Agents', text: 'Run in one Git worktree with the global agent context and authenticated GitHub reads.' },
  { icon: 'i-octicon-shield-check-16', title: 'Controller', text: 'Checks the current head, repository policy, artifact, and App access before every GitHub write.' },
  { icon: 'i-octicon-person-16', title: 'Harlan', text: 'Approves one Review and repair workflow, and controller-published repair commits continue that Approval.' },
]

const markerClass: Record<Marker | 'gap', string> = {
  implemented: 'border-accented',
  decision: 'border-warning',
  gap: 'border-dashed border-error',
}

const stepNumber = (index: number): string => String(index + 1).padStart(2, '0')
</script>

<template>
  <div class="flex flex-col gap-10">
    <div class="flex min-h-6 flex-wrap items-center gap-2">
      <h1 class="field-label">
        How it works
      </h1>
      <span class="h-px min-w-8 flex-1 bg-border" aria-hidden="true" />
      <ul class="flex flex-wrap items-center gap-1.5" aria-label="Markers">
        <li class="rounded-sm border px-1.5 py-0.5 text-sm text-toned" :class="markerClass.implemented">
          Implemented
        </li>
        <li class="rounded-sm border px-1.5 py-0.5 text-sm status-warning" :class="markerClass.decision">
          Harlan decision
        </li>
        <li class="rounded-sm border px-1.5 py-0.5 text-sm status-error" :class="markerClass.gap">
          Not connected
        </li>
      </ul>
    </div>

    <section aria-labelledby="flow-intake" class="flex flex-col gap-3">
      <ColumnHeading id="flow-intake" label="GitHub intake" />
      <ol class="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] md:items-stretch">
        <template v-for="(node, index) in intake" :key="node.title">
          <li v-if="index > 0" class="grid place-items-center text-dimmed" aria-hidden="true">
            <UIcon name="i-octicon-arrow-right-16" class="size-4 rotate-90 md:rotate-0" />
          </li>
          <li class="flex items-start gap-3 rounded-md border border-default bg-elevated p-3">
            <UIcon :name="node.icon" class="mt-0.5 size-4 shrink-0 text-dimmed" aria-hidden="true" />
            <span class="min-w-0">
              <span class="block font-medium">{{ node.title }}</span>
              <span class="mt-0.5 block text-sm text-muted">{{ node.text }}</span>
            </span>
          </li>
        </template>
      </ol>
    </section>

    <div class="grid items-start gap-6 md:grid-cols-2">
      <section aria-labelledby="flow-pull-request" class="flex flex-col gap-3">
        <ColumnHeading id="flow-pull-request" label="Pull request" />
        <ol class="flex flex-col gap-2 rounded-lg bg-muted p-2">
          <li v-for="(step, index) in pullRequestSteps" :key="step.title" class="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-2 rounded-md border border-default bg-elevated p-3">
            <span class="font-mono text-sm text-dimmed">{{ stepNumber(index) }}</span>
            <div class="min-w-0">
              <h3 class="font-medium">
                {{ step.title }}
              </h3>
              <p v-if="step.text" class="mt-0.5 text-sm text-muted">
                {{ step.text }}
              </p>
              <ul v-if="step.branches" class="mt-2 grid gap-1.5 sm:grid-cols-2" role="list">
                <li v-for="branch in step.branches" :key="branch.title" class="rounded-sm border px-2 py-1.5 text-sm" :class="markerClass[branch.marker]">
                  <span class="block font-medium" :class="branch.marker === 'decision' ? 'status-warning' : undefined">{{ branch.title }}</span>
                  <span class="block text-muted">{{ branch.text }}</span>
                </li>
              </ul>
            </div>
          </li>
        </ol>
      </section>

      <section aria-labelledby="flow-issue" class="flex flex-col gap-3">
        <ColumnHeading id="flow-issue" label="Issue" />

        <ol class="flex flex-col gap-2 rounded-lg bg-muted p-2">
          <li v-for="(step, index) in issueSteps" :key="step.title" class="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-2 rounded-md border border-default bg-elevated p-3">
            <span class="font-mono text-sm text-dimmed">{{ stepNumber(index) }}</span>
            <div class="min-w-0">
              <h3 class="font-medium">
                {{ step.title }}
              </h3>
              <p v-if="step.text" class="mt-0.5 text-sm text-muted">
                {{ step.text }}
              </p>
              <ul v-if="step.branches" class="mt-2 grid gap-1.5 sm:grid-cols-2" role="list">
                <li v-for="branch in step.branches" :key="branch.title" class="rounded-sm border px-2 py-1.5 text-sm" :class="markerClass[branch.marker]">
                  <span class="block font-medium" :class="branch.marker === 'decision' ? 'status-warning' : undefined">{{ branch.title }}</span>
                  <span class="block text-muted">{{ branch.text }}</span>
                </li>
              </ul>
            </div>
          </li>
        </ol>
      </section>
    </div>

    <section aria-labelledby="flow-recovery" class="flex flex-col gap-3">
      <ColumnHeading id="flow-recovery" label="Automatic recovery" />
      <ul class="divide-y divide-default" role="list">
        <li v-for="row in recovery" :key="row.title" class="grid min-h-11 grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 py-2.5 sm:grid-cols-[1rem_minmax(0,1fr)_auto]">
          <UIcon :name="row.icon" class="size-4 text-dimmed" aria-hidden="true" />
          <span class="min-w-0">
            <span class="font-medium">{{ row.title }}</span>
            <span class="block text-sm text-muted">{{ row.text }}</span>
          </span>
          <UBadge color="neutral" variant="outline" class="col-start-2 justify-self-start sm:col-start-3">
            {{ row.result }}
          </UBadge>
        </li>
      </ul>
    </section>

    <section aria-labelledby="flow-gaps" class="flex flex-col gap-3">
      <ColumnHeading id="flow-gaps" label="Known gaps" :count="gaps.length" tone="error" />
      <ul class="grid gap-2 md:grid-cols-2" role="list">
        <li v-for="gap in gaps" :key="gap.title" class="rounded-md border p-3" :class="markerClass.gap">
          <span class="font-medium">{{ gap.title }}</span>
          <span class="block text-sm text-muted">{{ gap.text }}</span>
        </li>
      </ul>
    </section>

    <section aria-labelledby="flow-roles" class="flex flex-col gap-3">
      <ColumnHeading id="flow-roles" label="Who can do what" />
      <ul class="grid divide-y divide-default rounded-md border border-default bg-elevated md:grid-cols-3 md:divide-x md:divide-y-0" role="list">
        <li v-for="role in roles" :key="role.title" class="p-3">
          <span class="flex items-center gap-2 font-medium">
            <UIcon :name="role.icon" class="size-4 text-dimmed" aria-hidden="true" />
            {{ role.title }}
          </span>
          <span class="mt-1 block text-sm text-muted">{{ role.text }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
