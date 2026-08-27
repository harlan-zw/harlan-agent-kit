import { describe, expect, it } from 'vitest'
import { err, ok } from '../src/result.ts'
import { clearAbandonedRunningLabels } from '../src/running-label-sweep.ts'
import { repositoryMapping } from './fixtures.ts'

function sweep(options: {
  labelled: number[]
  running: Array<{ repository: string, itemNumber: number }>
  clear?: (itemNumber: number) => ReturnType<typeof ok<void>> | ReturnType<typeof err<string>>
}) {
  const cleared: number[] = []
  const run = async () => clearAbandonedRunningLabels({
    github: {
      listRunningLabelledItems: () => Promise.resolve(ok(options.labelled)),
      clearRunningLabel: (_repository, itemNumber) => {
        const result = options.clear?.(itemNumber) ?? ok(undefined)
        if (result._tag === 'Ok')
          cleared.push(itemNumber)
        return Promise.resolve(result)
      },
    },
    repositories: [repositoryMapping()],
    store: { listRunningTaskItems: () => options.running },
  }, new AbortController().signal)
  return { cleared, run }
}

describe('clearAbandonedRunningLabels', () => {
  it('takes the label off an item a dead process left it on', async () => {
    const { cleared, run } = sweep({ labelled: [24, 25], running: [] })

    const results = await run()

    expect(cleared).toEqual([24, 25])
    expect(results).toEqual([ok({ repository: 'harlan-zw/example', cleared: [24, 25] })])
  })

  it('leaves the label on an item an agent is still working', async () => {
    const { cleared, run } = sweep({
      labelled: [24, 25],
      running: [{ repository: 'harlan-zw/example', itemNumber: 25 }],
    })

    await run()

    expect(cleared).toEqual([24])
  })

  it('matches the repository however GitHub cases it', async () => {
    const { cleared, run } = sweep({
      labelled: [24],
      running: [{ repository: 'Harlan-ZW/Example', itemNumber: 24 }],
    })

    await run()

    expect(cleared).toEqual([])
  })

  it('reports the repository that refused the write', async () => {
    const { run } = sweep({
      labelled: [24],
      running: [],
      clear: () => err('GitHub returned 403.'),
    })

    expect(await run()).toEqual([err('harlan-zw/example#24: GitHub returned 403.')])
  })

  it('writes nothing when no item carries the label', async () => {
    const { cleared, run } = sweep({ labelled: [], running: [] })

    await run()

    expect(cleared).toEqual([])
  })
})
