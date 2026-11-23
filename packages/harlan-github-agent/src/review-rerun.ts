/**
 * The exact comment that queues one Review of the current head commit.
 *
 * `@harlan-agent` is the summon handle: an Organization that authenticates
 * nothing, because GitHub's mention picker does not offer regular GitHub App
 * bots the way it offers `@claude` or `@coderabbitai`. The GitHub App still
 * receives the comment and scans its text, so the handle only buys a short,
 * link-rendering mention. The App bot's own logins and the slash form stay,
 * so nothing that works today stops working.
 */
export function isReviewRerunCommand(body: string): boolean {
  const command = body.trim()
  return /^\/harlan-agent\s+rerun$/i.test(command)
    || /^@harlan-agent\s+rerun$/i.test(command)
    || /^@harlan-github-agent(?:\[bot\])?\s+rerun$/i.test(command)
}

export type ParsedPullRequestCommand
  = | { _tag: 'Rerun' }
    | { _tag: 'Stop' }
    | { _tag: 'Change', instruction: string }

/**
 * Only a leading, exact Agent handle addresses a command to this Service.
 *
 * `stop` alone stops Review and follow-up Repair, as `@claude stop` does for
 * PR Steward. A longer instruction that starts with "stop" stays a change.
 */
export function parsePullRequestCommand(body: string): ParsedPullRequestCommand | null {
  if (isReviewRerunCommand(body))
    return { _tag: 'Rerun' }
  const text = body.trim()
  const match = /^(?:\/harlan-agent|@harlan-agent|@harlan-github-agent(?:\[bot\])?)(?=\s)/i.exec(text)
  const instruction = match === null ? undefined : text.slice(match[0].length).trim()
  if (instruction === undefined || instruction === '')
    return null
  return /^stop$/i.test(instruction)
    ? { _tag: 'Stop' }
    : { _tag: 'Change', instruction }
}
