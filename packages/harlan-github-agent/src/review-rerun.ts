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
