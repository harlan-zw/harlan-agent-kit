import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeHomeOverlay } from '../src/worker-home-layer.ts'

/** Non-Review sandboxes need bubblewrap 0.10 or later. An older host skips those tests instead of failing them. */
export const homeOverlayMissing = await (async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-home-overlay-probe-'))
  try {
    return (await probeHomeOverlay(root))._tag === 'Unsupported'
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})()
