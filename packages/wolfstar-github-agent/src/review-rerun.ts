/**
 * The exact comment that queues one Review of the current head commit.
 *
 * `@wolfstar-agent` is the summon handle: an Organization that authenticates
 * nothing, because GitHub's mention picker does not offer regular GitHub App
 * bots the way it offers `@claude` or `@coderabbitai`. The GitHub App still
 * receives the comment and scans its text, so the handle only buys a short,
 * link-rendering mention. The App bot's own logins and the slash form stay,
 * so nothing that works today stops working.
 */
export function isReviewRerunCommand(body: string): boolean {
  const command = body.trim()
  return (
    /^\/wolfstar-agent\s+rerun$/i.test(command) ||
    /^@wolfstar-agent\s+rerun$/i.test(command) ||
    /^@wolfstar-github-agent(?:\[bot\])?\s+rerun$/i.test(command)
  )
}

/** Only a leading, exact Agent handle addresses a command to this Service. */
export function parsePullRequestCommand(
  body: string,
): { _tag: 'Rerun' } | { _tag: 'Change'; instruction: string } | null {
  if (isReviewRerunCommand(body)) return { _tag: 'Rerun' }
  const text = body.trim()
  const match = /^(?:\/wolfstar-agent|@wolfstar-agent|@wolfstar-github-agent(?:\[bot\])?)(?=\s)/i.exec(text)
  const instruction = match === null ? undefined : text.slice(match[0].length).trim()
  return instruction === undefined || instruction === '' ? null : { _tag: 'Change', instruction }
}
