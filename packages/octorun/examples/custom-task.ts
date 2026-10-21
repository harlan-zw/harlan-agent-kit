import type { EventEnvelope, TaskType } from '@harlan-zw/octorun'
import { createRunner, digest, openStore, parseJsonValue, parseWorkflow } from '@harlan-zw/octorun'

const describeTarget: TaskType = {
  id: 'example.describe-target',
  version: '1',
  capabilities: ['repository:read'],
  input: parseJsonValue,
  output: parseJsonValue,
  execute: async context => ({
    _tag: 'Succeeded',
    output: { repository: context.event.repository.fullName, target: context.event.target },
  }),
}

const parsed = parseWorkflow({
  version: 1,
  id: 'example',
  name: 'Describe a target',
  on: [{ event: 'pull_request' }],
  tasks: [{ id: 'describe', uses: describeTarget.id, with: {} }],
})
if (parsed._tag === 'Err')
  throw new Error(parsed.error.message)
const workflow = parsed.value

const timestamp = new Date().toISOString()
const event: EventEnvelope = {
  id: 'example-event',
  source: 'manual',
  name: 'pull_request',
  action: 'opened',
  repository: { id: 1, fullName: 'example/project', installationId: 2 },
  actor: null,
  target: { _tag: 'PullRequest', number: 7, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
  occurredAt: timestamp,
  receivedAt: timestamp,
  semanticKey: 'example-request',
  data: {},
}

async function main(): Promise<void> {
  const store = openStore({ path: ':memory:' })
  const runner = createRunner({ store, taskTypes: [describeTarget] })
  try {
    const accepted = runner.start({
      event,
      workflow,
      policy: { enabled: true, capabilities: ['repository:read'], maxConcurrency: 1 },
      configuration: { source: 'operator-example', sha: 'example-v1', digest: digest(workflow) },
      requestId: 'example-request',
    })
    if (accepted._tag === 'Err')
      throw new Error(accepted.error.message)
    await runner.drain()
    const run = runner.inspect(accepted.value.id)
    process.stdout.write(`${JSON.stringify({ state: run?.state, output: run?.tasks[0]?.output }, null, 2)}\n`)
  }
  finally {
    await runner.close()
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'The example task failed.'}\n`)
  process.exitCode = 1
})
