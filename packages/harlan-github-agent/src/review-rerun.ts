export function isReviewRerunCommand(body: string): boolean {
  const command = body.trim()
  return /^\/harlan-agent\s+rerun$/i.test(command)
    || /^@harlan-github-agent(?:\[bot\])?\s+rerun$/i.test(command)
}
