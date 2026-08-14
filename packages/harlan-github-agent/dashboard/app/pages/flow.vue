<script setup lang="ts">
const colorMode = useColorMode()

function toggleColorMode(): void {
  colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
}

useHead({
  htmlAttrs: { lang: 'en' },
  title: 'Workflow map | Harlan GitHub Agent',
  meta: [
    { name: 'description', content: 'How Harlan GitHub Agent handles pull requests, issues, recovery, and GitHub writes.' },
  ],
})
</script>

<template>
  <div class="min-h-screen">
    <a href="#flow-content" class="skip-link">
      Skip to workflow map
    </a>

    <header class="sticky top-0 z-50 border-b border-default bg-default/85 backdrop-blur">
      <div class="mx-auto flex max-w-[90rem] flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3 sm:px-6 lg:px-8">
        <NuxtLink to="/" class="entity-link flex min-w-0 items-center gap-2.5 no-underline">
          <span class="grid size-8 shrink-0 place-items-center rounded-md bg-inverted text-inverted">
            <UIcon name="i-lucide-bot" class="size-4.5" aria-hidden="true" />
          </span>
          <span class="truncate text-base font-semibold tracking-tight">Harlan GitHub Agent</span>
        </NuxtLink>

        <nav aria-label="Dashboard pages" class="flex items-center gap-2">
          <UButton to="/" icon="i-lucide-activity" color="neutral" variant="ghost">
            Dashboard
          </UButton>
          <UButton to="/flow" icon="i-lucide-git-branch" color="primary" variant="soft" aria-current="page">
            Flow
          </UButton>
          <UButton
            :icon="colorMode.value === 'dark' ? 'i-lucide-moon' : 'i-lucide-sun'"
            color="neutral"
            variant="ghost"
            square
            aria-label="Toggle color mode"
            @click="toggleColorMode"
          />
        </nav>
      </div>
    </header>

    <main id="flow-content" tabindex="-1" class="mx-auto max-w-[90rem] px-4 py-8 sm:px-6 lg:px-8">
      <div class="mb-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(19rem,0.4fr)] lg:items-end">
        <div>
          <h1 class="max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl">
            How GitHub work moves through the agent
          </h1>
          <p class="mt-4 max-w-2xl text-base text-muted">
            This map shows what the service runs today, where it stops for your decision, and which paths are documented but not connected.
          </p>
        </div>

        <ul class="grid overflow-hidden rounded-md border border-default bg-elevated sm:grid-cols-3 lg:grid-cols-1" role="list">
          <li class="flex items-start gap-3 border-b border-default p-3 sm:border-b-0 sm:border-r sm:last:border-r-0 lg:border-b lg:border-r-0 lg:last:border-b-0">
            <span class="mt-1.5 size-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
            <span><strong class="font-medium">Implemented</strong><span class="block text-sm text-muted">Runs in the service</span></span>
          </li>
          <li class="flex items-start gap-3 border-b border-default p-3 sm:border-b-0 sm:border-r sm:last:border-r-0 lg:border-b lg:border-r-0 lg:last:border-b-0">
            <span class="mt-1.5 size-2 shrink-0 rounded-full bg-warning" aria-hidden="true" />
            <span><strong class="font-medium">Harlan decision</strong><span class="block text-sm text-muted">Exact approval required</span></span>
          </li>
          <li class="flex items-start gap-3 p-3">
            <span class="mt-1 size-2.5 shrink-0 rounded-full border border-dashed border-error" aria-hidden="true" />
            <span><strong class="font-medium">Not connected</strong><span class="block text-sm text-muted">A known missing path</span></span>
          </li>
        </ul>
      </div>

      <section aria-labelledby="intake-heading" class="mb-12">
        <div class="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 id="intake-heading" class="text-lg font-semibold">
            GitHub intake
          </h2>
          <p class="text-sm text-muted">
            One poll produces exact issue and pull request state.
          </p>
        </div>

        <ol class="entry-flow" aria-label="GitHub intake steps">
          <li class="flow-node">
            <UIcon name="i-lucide-github" class="size-5 shrink-0 text-dimmed" aria-hidden="true" />
            <span><strong>GitHub App</strong><span>Only installed <code>harlan-zw/*</code> repositories enter the service.</span></span>
          </li>
          <li class="flow-connector" aria-hidden="true">
            <UIcon name="i-lucide-arrow-right" />
          </li>
          <li class="flow-node">
            <UIcon name="i-lucide-folder-git-2" class="size-5 shrink-0 text-dimmed" aria-hidden="true" />
            <span><strong>Repository checks</strong><span>Match App access, Git origin, and a trusted checkout.</span></span>
          </li>
          <li class="flow-connector" aria-hidden="true">
            <UIcon name="i-lucide-arrow-right" />
          </li>
          <li class="flow-node">
            <UIcon name="i-lucide-refresh-cw" class="size-5 shrink-0 text-dimmed" aria-hidden="true" />
            <span><strong>Poll GitHub</strong><span>Read open human issues and pull requests.</span></span>
          </li>
          <li class="flow-connector" aria-hidden="true">
            <UIcon name="i-lucide-arrow-right" />
          </li>
          <li class="flow-node">
            <UIcon name="i-lucide-fingerprint" class="size-5 shrink-0 text-dimmed" aria-hidden="true" />
            <span><strong>Exact state</strong><span>Deduplicate each issue state and pull request head commit.</span></span>
          </li>
        </ol>
      </section>

      <div class="mb-12 grid items-start gap-6 md:grid-cols-2">
        <section aria-labelledby="pull-request-heading" class="overflow-hidden rounded-md border border-default bg-elevated">
          <header class="border-b border-default p-5">
            <h2 id="pull-request-heading" class="flex items-center gap-2.5 text-lg font-semibold">
              <UIcon name="i-lucide-git-pull-request" class="size-5 text-dimmed" aria-hidden="true" />
              Pull request
            </h2>
          </header>

          <ol class="lane-flow">
            <li>
              <span class="step-number">01</span>
              <div>
                <h3>Author gate</h3>
                <p>Skip GitHub Apps and automated accounts before creating Queue work or comments.</p>
                <div class="branch-grid">
                  <span><strong>@harlan-zw</strong>Review starts automatically.</span>
                  <span class="decision"><strong>Outside contributor</strong>Wait for Review and repair approval on the exact head commit.</span>
                </div>
              </div>
            </li>
            <li>
              <span class="step-number">02</span>
              <div>
                <h3>Merge state</h3>
                <p>GitHub decides which path can run.</p>
                <div class="branch-grid">
                  <span><strong>Clean</strong>Continue to review.</span>
                  <span><strong>Conflicting and writable</strong>Start conflict repair in a Git worktree.</span>
                  <span><strong>Unknown</strong>Wait for GitHub.</span>
                  <span class="decision"><strong>Not writable</strong>Show the exact GitHub boundary.</span>
                </div>
              </div>
            </li>
            <li>
              <span class="step-number">03</span>
              <div>
                <h3>Conflict repair</h3>
                <p>Fetch the current base, merge it into the pull request branch, resolve conflicts, and verify the edit.</p>
                <p>The controller pushes one fix commit. The new head commit returns to the start.</p>
              </div>
            </li>
            <li>
              <span class="step-number">04</span>
              <div>
                <h3>Adversarial review</h3>
                <p>Codex reviews the full diff and surrounding code with <code>gpt-5.6-sol</code> at high reasoning.</p>
                <p>Green CI supplies broad test, lint, typecheck, and build evidence. The agent runs focused checks only for a finding or uncovered behavior.</p>
              </div>
            </li>
            <li>
              <span class="step-number">05</span>
              <div>
                <h3>One automated comment</h3>
                <p>The controller creates one self-identified comment, updates progress in place, then posts READY, WAITING, or BLOCKED.</p>
              </div>
            </li>
            <li>
              <span class="step-number">06</span>
              <div>
                <h3>Rerun review</h3>
                <p>Harlan can use the dashboard or comment <code>/harlan-agent rerun</code>. The service queues the current head commit once.</p>
              </div>
            </li>
            <li>
              <span class="step-number">07</span>
              <div>
                <h3>GitHub status</h3>
                <p>Open pull requests stay live. Completed reviews fetch closed or merged status once, then cache the terminal result.</p>
              </div>
            </li>
          </ol>
        </section>

        <section aria-labelledby="issue-heading" class="overflow-hidden rounded-md border border-default bg-elevated">
          <header class="border-b border-default p-5">
            <h2 id="issue-heading" class="flex items-center gap-2.5 text-lg font-semibold">
              <UIcon name="i-lucide-circle-dot" class="size-5 text-dimmed" aria-hidden="true" />
              Issue
            </h2>
          </header>

          <ol class="lane-flow">
            <li>
              <span class="step-number">01</span>
              <div>
                <h3>Eligibility</h3>
                <p>Ignore issues before the fixed legacy cutoff. Owned repositories enable Issue triage by default.</p>
              </div>
            </li>
            <li>
              <span class="step-number">02</span>
              <div>
                <h3>Issue triage</h3>
                <p>Codex checks the default branch, reproduction, comments, hidden scope, difficulty, and impact in a Git worktree.</p>
              </div>
            </li>
            <li>
              <span class="step-number">03</span>
              <div>
                <h3>Triage result</h3>
                <div class="branch-grid">
                  <span><strong>Invalid</strong>Record why.</span>
                  <span><strong>Needs information</strong>Record the missing evidence.</span>
                  <span><strong>Valid</strong>Record the next action.</span>
                </div>
              </div>
            </li>
            <li>
              <span class="step-number">04</span>
              <div>
                <h3>Approval</h3>
                <p>Harlan's valid issues continue automatically. An outside contributor's issue waits for approval of that exact issue state.</p>
              </div>
            </li>
            <li>
              <span class="step-number">05</span>
              <div>
                <h3>Issue work</h3>
                <p>The triage agent resumes its Codex session, makes the change, and runs focused checks. The controller verifies and commits the result.</p>
              </div>
            </li>
            <li>
              <span class="step-number">06</span>
              <div>
                <h3>Draft pull request</h3>
                <p>The controller pushes the pinned commit to an allowed branch, then opens one pull request ready for review.</p>
              </div>
            </li>
          </ol>
        </section>
      </div>

      <section aria-labelledby="recovery-heading" class="mb-12">
        <h2 id="recovery-heading" class="mb-4 text-lg font-semibold">
          Automatic recovery
        </h2>
        <div class="overflow-hidden rounded-md border border-default bg-elevated">
          <ul class="divide-y divide-default" role="list">
            <li class="recovery-row">
              <UIcon name="i-lucide-git-commit-horizontal" class="text-dimmed" aria-hidden="true" />
              <span><strong>Base branch moved</strong><span>Refresh the current base and continue conflict repair.</span></span>
              <UBadge color="success" variant="subtle" class="status-success">
                Requeue
              </UBadge>
            </li>
            <li class="recovery-row">
              <UIcon name="i-lucide-braces" class="text-dimmed" aria-hidden="true" />
              <span><strong>Invalid Codex result</strong><span>Use the strict response schema, then retry on the next GitHub poll.</span></span>
              <UBadge color="success" variant="subtle" class="status-success">
                Requeue
              </UBadge>
            </li>
            <li class="recovery-row">
              <UIcon name="i-lucide-git-merge" class="text-dimmed" aria-hidden="true" />
              <span><strong>Conflicts return</strong><span>Restore the conflict repair task for that pull request state.</span></span>
              <UBadge color="success" variant="subtle" class="status-success">
                Requeue
              </UBadge>
            </li>
            <li class="recovery-row">
              <UIcon name="i-lucide-git-pull-request-closed" class="text-dimmed" aria-hidden="true" />
              <span><strong>Head changed, closed, or merged</strong><span>Stop old work within five seconds and follow the current GitHub state.</span></span>
              <UBadge color="neutral" variant="subtle">
                Stop old agent
              </UBadge>
            </li>
            <li class="recovery-row">
              <UIcon name="i-lucide-circle-x" class="text-dimmed" aria-hidden="true" />
              <span><strong>Task cancelled</strong><span>Stop the agent and keep that task cancelled for the current commit.</span></span>
              <UBadge color="neutral" variant="subtle">
                Cancel
              </UBadge>
            </li>
          </ul>
        </div>
      </section>

      <section aria-labelledby="gaps-heading" class="mb-12">
        <h2 id="gaps-heading" class="mb-4 text-lg font-semibold">
          Known gaps
        </h2>
        <div class="grid gap-3 md:grid-cols-2">
          <details class="gap-disclosure">
            <summary>
              Claude review is not running
              <UBadge color="error" variant="subtle" class="status-error">
                Not connected
              </UBadge>
            </summary>
            <p>The data model permits Claude evidence, but the service starts Codex agents only. No Claude CLI review is dispatched.</p>
          </details>
          <details class="gap-disclosure">
            <summary>
              Deployment ownership is not running
              <UBadge color="error" variant="subtle" class="status-error">
                Not connected
              </UBadge>
            </summary>
            <p>Site deployment and smoke rules exist in configuration and skills. The service does not watch merge deployment or run production smoke checks.</p>
          </details>
        </div>
      </section>

      <section aria-labelledby="boundary-heading">
        <h2 id="boundary-heading" class="mb-4 text-lg font-semibold">
          Who can do what
        </h2>
        <div class="grid divide-y divide-default overflow-hidden rounded-md border border-default bg-elevated md:grid-cols-3 md:divide-x md:divide-y-0">
          <div class="p-5">
            <UIcon name="i-lucide-bot" class="mb-3 size-5 text-dimmed" aria-hidden="true" />
            <h3 class="font-medium">
              Agents
            </h3>
            <p class="mt-2 text-sm text-muted">
              Run with the global Codex context in one Git worktree. They can use authenticated GitHub reads for project history.
            </p>
          </div>
          <div class="p-5">
            <UIcon name="i-lucide-shield-check" class="mb-3 size-5 text-dimmed" aria-hidden="true" />
            <h3 class="font-medium">
              Controller
            </h3>
            <p class="mt-2 text-sm text-muted">
              Checks the current head, repository policy, artifact, and App access before every GitHub write.
            </p>
          </div>
          <div class="p-5">
            <UIcon name="i-lucide-user-check" class="mb-3 size-5 text-dimmed" aria-hidden="true" />
            <h3 class="font-medium">
              Harlan
            </h3>
            <p class="mt-2 text-sm text-muted">
              Approves one review and repair workflow. Controller-published repair commits continue that approval.
            </p>
          </div>
        </div>
      </section>
    </main>

    <footer class="mx-auto flex max-w-[90rem] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 pb-10 pt-12 font-mono text-sm text-dimmed sm:px-6 lg:px-8">
      <span>Loopback only · <code>harlan-zw/*</code> only · Three active agents maximum</span>
      <NuxtLink to="/" class="entity-link">
        Open live dashboard
      </NuxtLink>
    </footer>
  </div>
</template>

<style scoped>
.entry-flow {
  display: grid;
  align-items: stretch;
  gap: 0.5rem;
}

.flow-node {
  display: flex;
  min-height: 6rem;
  align-items: flex-start;
  gap: 0.75rem;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  background: var(--ui-bg-elevated);
  padding: 1rem;
}

.flow-node strong {
  font-weight: 500;
}

.flow-node span span {
  display: block;
  margin-top: 0.25rem;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
}

.flow-connector {
  display: grid;
  min-height: 2rem;
  place-items: center;
  color: var(--ui-text-dimmed);
  rotate: 90deg;
}

.lane-flow > li {
  display: grid;
  grid-template-columns: 1.75rem minmax(0, 1fr);
  gap: 1rem;
  padding: 1.25rem;
}

.lane-flow > li:not(:last-child) {
  border-bottom: 1px solid var(--ui-border);
}

.lane-flow h3 {
  font-weight: 500;
}

.lane-flow p {
  margin-top: 0.375rem;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
}

.step-number {
  padding-top: 0.15rem;
  color: var(--ui-text-dimmed);
  font-family: var(--font-mono);
  font-size: 0.875rem;
}

.branch-grid {
  display: grid;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

/* Branches carry the legend dot, so they read the same here as in the key. */
.branch-grid > span {
  position: relative;
  border-radius: var(--ui-radius);
  background: var(--ui-bg-muted);
  padding: 0.65rem 0.75rem 0.65rem 1.5rem;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
}

.branch-grid > span::before {
  position: absolute;
  top: 1.05rem;
  left: 0.7rem;
  border-radius: 999px;
  background: var(--ui-success);
  block-size: 0.375rem;
  content: '';
  inline-size: 0.375rem;
}

.branch-grid > .decision::before {
  background: var(--ui-warning);
}

.branch-grid strong {
  display: block;
  color: var(--ui-text);
  font-weight: 500;
}

.recovery-row {
  display: grid;
  grid-template-columns: 1.25rem minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.875rem;
  padding: 1rem;
}

.recovery-row strong {
  font-weight: 500;
}

.recovery-row span span {
  display: block;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
}

/* Dashed is reserved for documented but unconnected service paths. */
.gap-disclosure {
  border: 1px dashed color-mix(in oklab, var(--ui-error) 45%, var(--ui-border));
  border-radius: var(--ui-radius);
  background: var(--ui-bg-elevated);
}

.gap-disclosure summary {
  display: flex;
  cursor: pointer;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.9rem 1rem;
  font-weight: 500;
}

.gap-disclosure p {
  border-top: 1px dashed var(--ui-border);
  padding: 1rem;
  color: var(--ui-text-muted);
  font-size: 0.875rem;
}

@media (min-width: 48rem) {
  .entry-flow {
    grid-template-columns: minmax(0, 1fr) 2rem minmax(0, 1fr) 2rem minmax(0, 1fr) 2rem minmax(0, 1fr);
  }

  .flow-connector {
    rotate: 0deg;
  }

  .branch-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 47.999rem) {
  .recovery-row {
    grid-template-columns: 1.25rem minmax(0, 1fr);
  }

  .recovery-row > :last-child {
    grid-column: 2;
    justify-self: start;
  }
}
</style>
