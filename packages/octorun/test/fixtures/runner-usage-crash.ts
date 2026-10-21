import type { EventEnvelope, TaskOutcome, TaskType } from '../../src/index.ts'
import { createRunner, openStore, parseJsonValue, parseWorkflow } from '../../src/index.ts'

async function main() {
  const path = process.argv[2]
  if (!path || !process.send)
    throw new Error('The crash fixture requires a database path and an IPC channel.')

  const event: EventEnvelope = {
    id: 'crash-event',
    semanticKey: 'crash-event',
    source: 'manual',
    name: 'pull_request',
    action: 'opened',
    repository: { id: 1, fullName: 'acme/project', installationId: 2 },
    actor: null,
    target: { _tag: 'PullRequest', number: 4, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
    occurredAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    data: {},
  }
  const definition = parseWorkflow({ version: 1, id: 'reserved', name: 'Reserved usage', on: [], tasks: [{ id: 'turn', uses: 'turn', with: {} }], limits: { maxTokens: 80, maxAttempts: 1 } })
  if (definition._tag === 'Err')
    throw new Error(definition.error.message)

  const turn: TaskType = {
    id: 'turn',
    version: '1',
    capabilities: ['agent:invoke'],
    input: parseJsonValue,
    output: parseJsonValue,
    async execute(context): Promise<TaskOutcome> {
      const reserved = await context.reserveUsage({ inputTokens: 20, outputTokens: 30, costUsd: null })
      if (reserved._tag === 'Err')
        throw new Error(reserved.error.message)
      process.send!({ _tag: 'Reserved', runId: context.run.id })
      return new Promise<TaskOutcome>(() => {})
    },
  }
  const runner = createRunner({ store: openStore({ path }), taskTypes: [turn] })
  const run = runner.start({ event, workflow: definition.value, policy: { enabled: true, capabilities: ['agent:invoke'], maxConcurrency: 1 }, configuration: { source: 'fixture', sha: 'trusted', digest: 'fixture' } })
  if (run._tag === 'Err')
    throw new Error(run.error.message)
  // Keep the owned child alive until the test sends SIGKILL.
  process.on('message', () => {})
  await runner.tick()
}

void main()
