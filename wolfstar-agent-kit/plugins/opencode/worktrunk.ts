import type { Plugin } from '@opencode/plugin'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export default {
  id: 'wolfstar-agent-kit.worktrunk',
  setup(ctx) {
    const controller = new AbortController()
    const events = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const directory = event.location?.directory
        if (directory === undefined) continue
        const marker = event.type === 'session.status' ? '🤖' : event.type === 'session.idle' ? '💬' : undefined
        if (marker === undefined && event.type !== 'session.deleted') continue
        await execute('wt', ['config', 'state', 'marker', ...(marker === undefined ? ['clear'] : ['set', marker])], {
          cwd: directory,
        }).catch((error: Error) => console.error(`OpenCode Worktree marker failed: ${error.message}`))
      }
    })().catch((error: Error) => {
      if (!controller.signal.aborted) console.error(`OpenCode Worktree events failed: ${error.message}`)
    })
    return async () => {
      controller.abort()
      await events
    }
  },
} satisfies Plugin.Plugin
