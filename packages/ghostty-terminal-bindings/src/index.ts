import type { GhosttyTerminal, KeyEncoder, KeyEvent } from '../.generated/ghostty-web.js'
import { fileURLToPath } from 'node:url'
import { Ghostty, Key, KeyAction, Mods } from '../.generated/ghostty-web.js'

export { Ghostty, Key, KeyAction, KeyEncoder, Mods } from '../.generated/ghostty-web.js'
export type { GhosttyCell, GhosttyTerminal, IRenderable, KeyEvent } from '../.generated/ghostty-web.js'

/** Resolve the generated asset through package exports, including bundled consumers. */
export function wasmPath(): string {
  return fileURLToPath(import.meta.resolve('ghostty-terminal-bindings/wasm'))
}

/** Instantiate one authoritative parser. The caller owns diagnostic handling. */
export async function createGhostty(wasmBytes: Uint8Array, onLog: (message: string) => void): Promise<Ghostty> {
  let memory: WebAssembly.Memory | undefined
  const { instance } = await WebAssembly.instantiate(wasmBytes as Uint8Array<ArrayBuffer>, {
    env: {
      log(pointer: number, length: number) {
        if (!memory)
          throw new Error('Ghostty emitted diagnostics before exposing memory.')
        onLog(new TextDecoder().decode(new Uint8Array(memory.buffer, pointer, length)))
      },
    },
  })
  memory = instance.exports.memory as WebAssembly.Memory
  return new Ghostty(instance)
}

/** Read all native negotiation state immediately before each keyboard event. */
export function encodeKey(terminal: GhosttyTerminal, encoder: KeyEncoder, event: KeyEvent): Uint8Array {
  terminal.configureKeyEncoder(encoder)
  return encoder.encode(event)
}

/** Follow Ghostty's native IME-confirmation path without inventing a physical key. */
export function encodeTextCommit(terminal: GhosttyTerminal, encoder: KeyEncoder, text: string): Uint8Array {
  if (text.length === 0)
    return new Uint8Array()
  return encodeKey(terminal, encoder, { action: KeyAction.PRESS, key: Key.ENTER, mods: Mods.NONE, utf8: text })
}
