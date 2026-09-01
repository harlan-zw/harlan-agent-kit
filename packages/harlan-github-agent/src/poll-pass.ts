export interface PassStepOptions {
  /** Reports a defect for the System pane. Never called for an aborted pass. */
  onDefect: (step: string, reason: string) => void
  signal: AbortSignal
}

/**
 * Runs one step of a poll pass, and keeps a defect inside that step.
 *
 * Every step of the pass answers with Results, so a throw out of one is a
 * controller defect and not an outage. The poller cannot tell the two apart: it
 * reads any rejected pass as an outage and doubles its interval, up to a 15
 * minute ceiling that then holds every healthy repository with it.
 *
 * One defect escaped `stageReviewGateStatus` on every pass for a day. The
 * configured 60 second observation loop ran every 18 minutes for as long as it
 * lasted, and nothing in the log said why.
 *
 * A step that throws answers with `fallback`, so the pass reads it as an empty
 * result and carries on to the steps behind it.
 */
export async function runPassStep<T>(
  step: string,
  run: () => T | Promise<T>,
  fallback: T,
  options: PassStepOptions,
): Promise<T> {
  try {
    return await run()
  }
  catch (error) {
    // Stopping the service aborts every request in flight, and each one rejects
    // with an abort. That is the shutdown, not a defect.
    if (options.signal.aborted)
      return fallback
    options.onDefect(step, error instanceof Error ? error.message : String(error))
    return fallback
  }
}
