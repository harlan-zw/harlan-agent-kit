import type { AgentProvider } from '../src/agent-provider.ts'
import type { PinnedAgentSelection } from '../src/types.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAgentRuntimeSource, parseAgentSelection } from '../src/agent-profile.ts'
import { openJournalStore } from '../src/store.ts'
import { repositoryMapping } from './fixtures.ts'

const selection: PinnedAgentSelection = { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium' }
const at = '2026-10-12T01:00:00.000Z'

describe('choosing an Agent for one Routine run', () => {
  it('accepts Codex 6.1 Sol with medium reasoning', () => {
    expect(parseAgentSelection({ _tag: 'Pinned', ...selection })).toEqual({
      _tag: 'Ok',
      value: { _tag: 'Pinned', ...selection },
    })
  })

  it('uses the chosen Agent without changing the next scheduled turn', () => {
    const provider = (name: AgentProvider['name']): AgentProvider => ({
      name,
      async *runTurn() {
        yield { _tag: 'TurnCompleted' }
      },
    })
    const runtime = createAgentRuntimeSource({
      configuredProvider: 'opencode',
      maximumActiveAgents: 1,
      providers: { claude: provider('claude'), codex: provider('codex'), opencode: provider('opencode') },
      selection: () => ({
        _tag: 'Pinned',
        provider: 'opencode',
        model: 'zai-coding-plan/glm-5.3',
        reasoningEffort: 'high',
      }),
    })

    expect(runtime('wolfstar-project/example', selection)).toMatchObject({
      provider: { name: 'codex' },
      profile: { roles: { routine_scan: { model: 'gpt-6.1-sol', reasoningEffort: 'medium' } } },
    })
    expect(runtime('wolfstar-project/example')).toMatchObject({
      provider: { name: 'opencode' },
      profile: { roles: { routine_scan: { model: 'zai-coding-plan/glm-5.3', reasoningEffort: 'high' } } },
    })
  })

  it('keeps a manual choice across restart and skips blocked scheduled runs without claiming them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'manual-routine-'))
    const path = join(directory, 'journal.sqlite')
    let store = openJournalStore(path)
    try {
      store.syncRepositories([repositoryMapping()], at)
      const [routine] = store.syncRoutines({
        repository: 'wolfstar-project/example',
        specSha: 'head',
        entries: [{ name: 'ci-review', crons: ['0 1 * * *'], timeZone: 'UTC', mode: 'report', enabled: true }],
        at,
      })
      if (routine === undefined) throw new Error('Expected a Routine.')
      const scheduled = store.openRoutineRun({ routineId: routine.id, scheduledFor: at, specSha: 'head', at })!
      const manual = store.openRoutineRun({
        routineId: routine.id,
        scheduledFor: '2026-10-12T01:01:00.000Z',
        specSha: 'head',
        agentSelection: selection,
        at,
      })!
      store.close()
      store = openJournalStore(path)

      expect(store.getRoutineRun(manual.id)?.agentSelection).toEqual(selection)
      const task = store.claimNextRoutineRun(
        'worker',
        '2026-10-12T01:02:00.000Z',
        60_000,
        (chosen) => chosen?.provider === 'codex',
      )
      expect(task).toMatchObject({ id: manual.id, agentSelection: selection })
      expect(store.getRoutineRun(scheduled.id)).toMatchObject({ state: { _tag: 'Queued' }, attempts: 0 })
      expect(
        store.claimNextRoutineRun(
          'other',
          '2026-10-12T01:02:01.000Z',
          60_000,
          (chosen) => chosen?.provider === 'codex',
        ),
      ).toBeNull()
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
