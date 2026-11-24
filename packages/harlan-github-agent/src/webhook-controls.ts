/** How long a stored comment delivery still proves that a repository reaches this listener. */
export const COMMENT_DELIVERY_PROOF_DAYS = 7

/** Repository coverage is separate from the listener being ready. */
export function createWebhookControls(options: {
  ready: () => boolean
  /**
   * Repositories whose signed comment deliveries the Journal kept from before
   * this process started. Without them, every restart hides each checkbox
   * until the repository's next comment event.
   */
  covered?: Iterable<string>
}) {
  // An App installation does not prove that Issue comments are subscribed.
  // Fresh signed deliveries prove the repository reaches this listener and secret.
  const covered = new Set<string>([...options.covered ?? []].map(repository => repository.toLowerCase()))
  return {
    available: (repository: string): boolean => options.ready() && covered.has(repository.toLowerCase()),
    /** Call only after signature and allowed-owner checks succeed. */
    observe(repository: string, event: string): void {
      if (event === 'issue_comment')
        covered.add(repository.toLowerCase())
    },
  }
}
