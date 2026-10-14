const encoder = new TextEncoder()

/**
 * Verifies one GitHub webhook signature over the raw request bytes.
 *
 * `crypto.subtle.verify` compares in constant time. A header of the wrong
 * shape is rejected before any key work, so a malformed value cannot throw.
 */
export async function verifyWebhookSignature(
  secret: string,
  body: ArrayBuffer,
  signature: string | null,
): Promise<boolean> {
  if (signature === null || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'verify',
  ])
  return crypto.subtle.verify('HMAC', key, hexBytes(signature.slice('sha256='.length)), body)
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  return bytes
}
