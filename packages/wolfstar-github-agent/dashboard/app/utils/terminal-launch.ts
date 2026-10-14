import type { TerminalLaunch } from '../../../src/terminal-protocol.ts'

export type TerminalLaunchIntent = TerminalLaunch & { mode: 'Regular' | 'Force' }

export function terminalLaunchIntent(
  previous: TerminalLaunchIntent | undefined,
  selection: Omit<TerminalLaunch, 'requestId'>,
  requestId: string,
  mode: 'Regular' | 'Force',
): TerminalLaunchIntent {
  return previous?.projectId === selection.projectId &&
    previous.provider === selection.provider &&
    previous.initialPrompt === selection.initialPrompt
    ? { ...previous, mode }
    : { requestId, ...selection, mode }
}
