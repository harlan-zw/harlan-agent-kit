import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const script = fileURLToPath(new URL('./opencode-v2-migrate.ts', import.meta.url))

it.each(['host', 'worker'])(
  'keeps migrated %s credentials private even when the old file was group writable',
  async (target) => {
    const home = await mkdtemp(join(tmpdir(), 'opencode-v2-migrate-'))
    try {
      const configuration = join(home, '.config/opencode')
      await mkdir(configuration, { recursive: true })
      await writeFile(
        join(configuration, 'opencode.json'),
        JSON.stringify({ providers: { 'zai-coding-plan': { settings: { apiKey: 'fixture-key' } } } }),
      )
      const worker = join(home, 'worker')
      if (target === 'worker') {
        await mkdir(join(home, '.config/wolfstar-github-agent'), { recursive: true })
        await writeFile(join(home, '.config/wolfstar-github-agent/worker.json'), JSON.stringify({ home: worker }))
        await mkdir(join(worker, '.config/opencode'), { recursive: true })
        await writeFile(join(worker, '.config/opencode/opencode.json'), '{}')
      } else {
        await mkdir(join(configuration, 'plugins'))
        for (const name of ['wolfstar-hooks.ts', 'worktrunk.ts'])
          await writeFile(join(configuration, 'plugins', name), '// fixture')
        await writeFile(join(configuration, 'opencode.jsonc'), '{}')
        await mkdir(join(home, '.local/share/opencode'), { recursive: true })
        await writeFile(join(home, '.local/share/opencode/auth.json'), '{}')
        await mkdir(join(home, '.codex'))
        await writeFile(join(home, '.codex/AGENTS.md'), 'Fixture instructions.')
      }
      const path = join(target === 'host' ? home : worker, '.config/opencode/opencode.json')
      await chmod(path, 0o664)
      await execute(
        process.execPath,
        ['--experimental-strip-types', script, ...(target === 'host' ? [home] : ['--worker'])],
        { env: { ...process.env, HOME: home } },
      )
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  },
)
