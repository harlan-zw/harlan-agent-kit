import type { TerminalLaunch } from '../../../src/terminal-protocol.ts'

export type TerminalLaunchIntent = TerminalLaunch & { mode: 'Regular' | 'Force' }

export function retainedTerminalLaunch(previous: TerminalLaunchIntent | undefined, selection: Omit<TerminalLaunch, 'requestId'>): TerminalLaunchIntent | undefined {
  return previous?.projectId === selection.projectId && previous.provider === selection.provider && previous.initialPrompt === selection.initialPrompt ? previous : undefined
}

export function terminalLaunchBlocked(previous: TerminalLaunchIntent | undefined, selection: Omit<TerminalLaunch, 'requestId'>): boolean {
  return Boolean(previous && !retainedTerminalLaunch(previous, selection))
}

export function terminalLaunchIntent(previous: TerminalLaunchIntent | undefined, selection: Omit<TerminalLaunch, 'requestId'>, requestId: string, mode: 'Regular' | 'Force'): TerminalLaunchIntent {
  const retained = retainedTerminalLaunch(previous, selection)
  return retained
    ? { ...retained, mode }
    : { requestId, ...selection, mode }
}
