/** Repository coverage is separate from the listener being ready. */
export function createWebhookControls(options: {
  ready: () => boolean
}) {
  // An App installation does not prove that Issue comments are subscribed.
  // Fresh signed deliveries prove the repository reaches this listener and secret.
  const covered = new Set<string>()
  return {
    available: (repository: string): boolean => options.ready() && covered.has(repository.toLowerCase()),
    /** Call only after signature and allowed-owner checks succeed. */
    observe(repository: string, event: string): void {
      if (event === 'issue_comment')
        covered.add(repository.toLowerCase())
    },
  }
}
