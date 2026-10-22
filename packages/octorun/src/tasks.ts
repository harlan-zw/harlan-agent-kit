import type { Result, TaskType } from '@harlan-zw/octorun'
import { err, ok, parseJsonValue } from '@harlan-zw/octorun'

function summaryInput(input: unknown): Result<{ summary: { text: string, headSha: string } }> {
  if (typeof input !== 'object' || input === null || !('summary' in input))
    return err({ _tag: 'Configuration', message: 'The summary task requires a pinned change summary.' })
  const summary = input.summary
  if (typeof summary !== 'object' || summary === null || !('text' in summary) || !('headSha' in summary)
    || typeof summary.text !== 'string' || !summary.text.trim() || summary.text.length > 50000
    || typeof summary.headSha !== 'string' || !/^[a-f0-9]{40}$/.test(summary.headSha)) {
    return err({ _tag: 'Configuration', message: 'The summary task requires bounded text and a full head commit.' })
  }
  return ok({ summary: { text: summary.text, headSha: summary.headSha } })
}

export function createKitTaskTypes(): TaskType[] {
  return [{
    id: 'kit.summary.publish',
    version: '1',
    capabilities: ['github:comment'],
    input: summaryInput,
    output: parseJsonValue,
    async execute(context, input) {
      const parsed = summaryInput(input)
      if (parsed._tag === 'Err')
        return { _tag: 'Failed', error: parsed.error }
      const { summary } = parsed.value
      if (context.event.target._tag !== 'PullRequest' || context.event.target.headSha !== summary.headSha)
        return { _tag: 'Failed', error: { _tag: 'Authorization', message: 'The change summary must match its pull request head.' } }
      const result = await context.publish('summary', { _tag: 'Comment', repository: context.event.repository.fullName, number: context.event.target.number, namespace: 'change-summary', body: `🤖 Octorun change summary written by an agent.\n\n${summary.text}` })
      return result._tag === 'Err' ? { _tag: 'Failed', error: result.error } : { _tag: 'Succeeded', output: { publications: 1 } }
    },
  }]
}
