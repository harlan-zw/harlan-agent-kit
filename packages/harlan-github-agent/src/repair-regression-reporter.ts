import process from 'node:process'

interface HookTask {
  result?: { hooks?: Partial<Record<string, string>> }
  tasks?: ReadonlyArray<HookTask>
}

interface ReporterContext {
  state: { getFiles: () => HookTask[] }
}

interface ReportedModule {
  errors: () => ReadonlyArray<unknown>
  children: {
    allSuites: () => Iterable<{ errors: () => ReadonlyArray<unknown> }>
    allTests: () => Iterable<{ result: () =>
      | { state: 'failed', errors: ReadonlyArray<{ name: string }> }
      | { state: 'passed' | 'pending' | 'skipped' } }>
  }
}

/** Emits only counts. Source paths, assertion values, and stack traces stay private. */
export default function repairRegressionReporter() {
  let context: ReporterContext | undefined
  const failedHook = (task: HookTask): boolean =>
    Object.values(task.result?.hooks ?? {}).some(state => state !== 'pass') || (task.tasks ?? []).some(failedHook)
  return {
    onInit: (vitest: ReporterContext) => { context = vitest },
    onTestRunEnd(modules: ReadonlyArray<ReportedModule>, unhandledErrors: ReadonlyArray<unknown>, reason: string) {
      let assertions = 0
      let otherFailures = unhandledErrors.length
      for (const module of modules) {
        otherFailures += module.errors().length
        for (const suite of module.children.allSuites())
          otherFailures += suite.errors().length
        for (const test of module.children.allTests()) {
          const result = test.result()
          if (result.state !== 'failed')
            continue
          if (result.errors.length > 0 && result.errors.every(error => error.name === 'AssertionError'))
            assertions += 1
          else
            otherFailures += 1
        }
      }
      const setupFailed = context === undefined || context.state.getFiles().some(failedHook)
      process.stdout.write(`${JSON.stringify({ _tag: 'RegressionEvidence', assertions, otherFailures, setupFailed, interrupted: reason === 'interrupted' })}\n`)
    },
  }
}
