import type { H3 } from 'h3'
import type { EmergencyOperation, EmergencyProxy } from './emergency-isolation.ts'
import { createError } from 'h3'

export function registerEmergencyRoutes(app: H3, proxy: EmergencyProxy, credential: (headers: Headers) => string | null) {
  for (const operation of ['status', 'options', 'isolate'] as const) {
    const handle = async (request: Request) => {
      const credentialId = credential(request.headers)
      if (!credentialId)
        throw createError({ status: 403, message: 'Sign in with a public Passkey to use emergency isolation.' })
      let body: Record<string, unknown> = {}
      if (operation !== 'status') {
        const reader = request.body?.getReader()
        if (!reader)
          throw createError({ status: 400, message: 'Provide an isolation request.' })
        const chunks: Uint8Array[] = []
        let size = 0
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done)
            break
          size += chunk.value.length
          if (size > 65536) {
            await reader.cancel()
            throw createError({ status: 413, message: 'Isolation request exceeds the size limit.' })
          }
          chunks.push(chunk.value)
        }
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('Invalid object')
          body = parsed as Record<string, unknown>
        }
        catch { throw createError({ status: 400, message: 'Invalid isolation request.' }) }
      }
      try {
        return await proxy(operation as EmergencyOperation, operation === 'status' ? undefined : operation === 'options' ? { credentialId } : body)
      }
      catch { throw createError({ status: 503, message: 'Emergency isolation is unavailable. Use admin recovery to inspect.' }) }
    }
    const path = `/api/emergency-isolation/${operation}`
    if (operation === 'status')
      app.get(path, event => handle(event.req))
    else app.post(path, event => handle(event.req))
  }
}
