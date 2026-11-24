import type { HeapProfiler } from 'node:inspector'
import assert from 'node:assert/strict'
import { Session } from 'node:inspector/promises'
import { isPublishedForm, redactPrivateDetails, REMOVED_LINE } from '../../src/public-text.ts'

const details = { paths: ['/private-root'], hosts: [] }
const withheld = '_This text was withheld: it named a private path or host across lines._'
const [mode, first, second] = process.argv.slice(2)

if (mode === 'allocation') {
  const matches = Number(first)
  const lines = Number(second)
  // A blank line would end the paragraph and leave the opener as text, so the comment wraps text lines.
  const source = `${'/private-root '.repeat(matches)}<!--${'x\n'.repeat(lines)}-->tail`
  const session = new Session()
  session.connect()
  await session.post('HeapProfiler.startSampling', {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  })
  const result = redactPrivateDetails(source, details)
  const { profile } = await session.post('HeapProfiler.stopSampling')
  session.disconnect()
  assert.equal(result.text, Array.from({ length: lines + 1 }).fill(REMOVED_LINE).join('\n'))
  assert.deepEqual(result.hits, [{ _tag: 'Path', entry: '/private-root' }])
  const allocated = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0)
  process.stdout.write(JSON.stringify({ allocated: allocated(profile.head), peakKiB: process.resourceUsage().maxRSS }))
}
else {
  const markers = '<!-- marker -->'.repeat(Number(first))
  const mixed = `${markers}ordinary text`
  const source = `${markers}\n${mixed}\n/private-\nroot`
  if (mode === 'withhold') {
    assert.equal(redactPrivateDetails(source, details).text, `${markers}\n${withheld}`)
  }
  else {
    assert.equal(isPublishedForm(`${markers}\n${withheld}`, source), true)
    assert.equal(isPublishedForm(`${mixed}\n${withheld}`, source), false)
  }
  process.stdout.write('ok')
}
