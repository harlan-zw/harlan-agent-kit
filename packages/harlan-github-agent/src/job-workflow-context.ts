import type { Result } from './result.ts'
import { posix } from 'node:path'
import { parseDocument } from 'yaml'
import { redactSecrets } from './agent-activity.ts'

type Invocation = { _tag: 'Declared', argvTemplate: string[], script: string } | { _tag: 'Unavailable', reason: string }
type Step = {
  name: string | null
  condition: string | null
  environment: Record<string, string>
} & ({ _tag: 'Run', run: string, shell: string | null, workingDirectory: string | null, invocation: Invocation }
  | { _tag: 'Action', uses: string, with: Record<string, string>, steps: Step[], limitation: string | null })
export type JobWorkflowContext = { _tag: 'Unavailable', reason: string }
  | { _tag: 'Available', path: string, ref: string, job: string, steps: Step[], limitations: string[] }

type ReadFile = (path: string, ref: string) => Promise<Result<string, string>>
const object = (input: unknown): Record<string, unknown> => typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {}
const text = (input: unknown): string | null => typeof input === 'string' ? redactSecrets(input).slice(0, 2_000) : null
function strings(input: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(input)).slice(0, 30).flatMap(([key, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? [[redactSecrets(key).slice(0, 100), /token|secret|password|credential|authorization|cookie|(?:^|_)key$/i.test(key) ? '[redacted]' : redactSecrets(String(value)).slice(0, 500)]] : []))
}
function document(source: string): Record<string, unknown> | null {
  if (Buffer.byteLength(source) > 64_000)
    return null
  const parsed = parseDocument(source)
  if (parsed.errors.length > 0)
    return null
  // YAML alias expansion errors are expected input failures.
  try {
    return object(parsed.toJS({ maxAliasCount: 20 }))
  }
  catch {
    return null
  }
}
function localPath(value: string): string | null {
  const path = posix.normalize(value)
  return path.startsWith('/') || path === '..' || path.startsWith('../') || path.includes('${{') || path.includes('\\') ? null : path
}
function invocation(run: string, shell: string | null): Invocation {
  if (run.includes('${{'))
    return { _tag: 'Unavailable', reason: 'The run command contains unresolved expressions.' }
  if (shell === 'bash')
    return { _tag: 'Declared', argvTemplate: ['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', '{script}'], script: run }
  if (shell === 'sh')
    return { _tag: 'Declared', argvTemplate: ['sh', '-e', '{script}'], script: run }
  return { _tag: 'Unavailable', reason: 'The runner default or custom shell needs resolution.' }
}

/** Workflow declarations at run.head_sha are evidence, never authority to execute a command. */
export async function collectJobWorkflowContext(input: { path: string, ref: string, jobName: string, readFile: ReadFile }): Promise<JobWorkflowContext> {
  if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(input.path) || !/^[a-f0-9]{40}$/i.test(input.ref))
    return { _tag: 'Unavailable', reason: 'The run has no supported workflow path and head SHA.' }
  const content = await input.readFile(input.path, input.ref)
  if (content._tag === 'Err')
    return { _tag: 'Unavailable', reason: redactSecrets(content.error).slice(0, 500) }
  const workflow = document(content.value)
  if (workflow === null)
    return { _tag: 'Unavailable', reason: 'The workflow YAML is invalid or exceeds its limit.' }
  const candidates = Object.entries(object(workflow.jobs)).filter(([key, value]) => key === input.jobName || object(value).name === input.jobName)
  if (candidates.length !== 1)
    return { _tag: 'Unavailable', reason: 'The job name does not identify one workflow job.' }
  const [jobKey, value] = candidates[0]!
  const job = object(value)
  if (job.uses !== undefined || job.strategy !== undefined || !Array.isArray(job.steps))
    return { _tag: 'Unavailable', reason: 'Reusable workflows or matrix jobs need runtime resolution.' }
  const limitations = ['This declaration uses run.head_sha. It may differ from the workflow SHA executed by GitHub.', 'Steps remain ordered prerequisites. Conditions, expressions, action inputs, and runner state need runtime resolution.', 'Text and environment values are bounded and redacted. Declared invocations require review before local execution.', 'Shell argv templates require a script file. The exact runner executable and temporary script path remain unavailable.']
  const defaults = { ...object(object(workflow.defaults).run), ...object(object(job.defaults).run) }
  const environment = { ...strings(workflow.env), ...strings(job.env) }
  let remainingSteps = 30
  let remainingFiles = 4
  async function steps(values: unknown[], defaults: Record<string, unknown>, environment: Record<string, string>, depth: number): Promise<Step[]> {
    const result: Step[] = []
    for (const value of values) {
      if (remainingSteps-- <= 0) {
        limitations.push('Step declarations exceed the 30-step limit.')
        break
      }
      const step = object(value)
      const common = { name: text(step.name), condition: typeof step.if === 'boolean' ? String(step.if) : text(step.if), environment: { ...environment, ...strings(step.env) } }
      if (typeof step.run === 'string') {
        const run = text(step.run)!
        const shell = text(step.shell ?? defaults.shell)
        const declaredDirectory = text(step['working-directory'] ?? defaults['working-directory'] ?? '.')!
        const workingDirectory = localPath(declaredDirectory)
        if (workingDirectory === null)
          limitations.push('A working directory cannot be resolved within the checkout.')
        if (step.run.length > 2_000)
          limitations.push('A run command exceeds the text limit. Its invocation is unavailable.')
        result.push({ ...common, _tag: 'Run', run, shell, workingDirectory, invocation: step.run.length > 2_000 ? { _tag: 'Unavailable', reason: 'The run command was truncated.' } : invocation(run, shell) })
      }
      else if (typeof step.uses === 'string') {
        const uses = text(step.uses)!
        const action: Step = { ...common, _tag: 'Action', uses, with: strings(step.with), steps: [], limitation: 'External actions require their own runtime preparation.' }
        if (uses.startsWith('./')) {
          const directory = localPath(uses)
          action.limitation = 'The local action is unavailable or exceeds the composite action limit.'
          if (directory !== null && depth < 2 && remainingFiles > 0) {
            remainingFiles--
            let read = await input.readFile(`${directory}/action.yml`, input.ref)
            if (read._tag === 'Err')
              read = await input.readFile(`${directory}/action.yaml`, input.ref)
            const composite = read._tag === 'Ok' ? document(read.value) : null
            const runs = object(composite?.runs)
            if (runs.using === 'composite' && Array.isArray(runs.steps)) {
              action.steps = await steps(runs.steps, {}, common.environment, depth + 1)
              action.limitation = 'Composite inputs and action path expressions remain unresolved.'
            }
          }
        }
        result.push(action)
      }
      else {
        limitations.push('A step has no supported run command or action declaration.')
      }
    }
    return result
  }
  const context: JobWorkflowContext = { _tag: 'Available', path: input.path, ref: input.ref, job: redactSecrets(jobKey).slice(0, 100), steps: await steps(job.steps, defaults, environment, 0), limitations }
  return JSON.stringify(context).length > 12_000
    ? { _tag: 'Unavailable', reason: 'The workflow declarations exceed the context limit.' }
    : context
}
