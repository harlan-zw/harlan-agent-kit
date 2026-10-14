# Ghostty terminal bindings

This private package provides verified Ghostty bindings for Agent terminals.
The host owns parsing and key encoding.
The browser renders immutable screens and forwards key events.

## Build

```sh
pnpm --filter ghostty-terminal-bindings build
pnpm --filter ghostty-terminal-bindings typecheck
pnpm --filter ghostty-terminal-bindings test:run
```

Build verifies checked artifacts offline with Node 24 or newer.
It checks source pins, patch digests, artifact digests, and license notices.
CI needs no GitHub token or Zig download.
Eight artifact files inside `.generated` are tracked.

To reproduce these artifacts, run `pnpm --filter ghostty-terminal-bindings build:source` on Linux x64.
The source builder needs `agent-gh`, `curl`, `tar`, and `patch`.
It downloads Zig 0.15.2 and verifies every source archive.
Public GitHub downloads use the dedicated Agent identity.
Downloads and unique build directories stay in `~/scratch/ghostty-bindings-source`.
Set `GHOSTTY_BINDINGS_SOURCE_CACHE` to use another source cache.
The builder checks every regenerated artifact against reviewed checksums before replacing tracked files.
If patches change, review the regenerated checksums and update their pins together.

## Host

```ts
import { readFileSync } from 'node:fs'
import { createGhostty, encodeKey, encodeTextCommit, wasmPath } from 'ghostty-terminal-bindings'

const ghostty = await createGhostty(readFileSync(wasmPath()), (message) => process.stderr.write(message))
const terminal = ghostty.createTerminal(100, 30)
const encoder = ghostty.createKeyEncoder()
```

Send ordinary keyboard events through `encodeKey(terminal, encoder, event)`.
It synchronizes all terminal-derived keyboard options before encoding.
It preserves event action, consumed modifiers, composition state, and Unicode codepoints.

Send completed IME text through `encodeTextCommit(terminal, encoder, text)`.
This uses Ghostty's native IME-confirmation behavior.
Keep paste separate and apply bracketed paste only when the terminal requests it.

Drain native terminal responses to the PTY even when no browser is attached.
Close the encoder and terminal after the host ends their Session.

`createTerminal` accepts `scrollbackLimit` in bytes, rather than rows.
Zero selects unlimited native history.
Ghostty keeps enough pages for the active screen and its page algorithms.
This minimum can retain thousands of rows in a narrow terminal.
The native byte limit is a heuristic. Active graphemes and styles can require more space.
Apply a separate row limit when exposing history through the host protocol.
Count and offset those visible rows from the latest retained native history.

## Browser

```ts
import { browserKeyEvent, CanvasRenderer } from 'ghostty-terminal-bindings/browser'
```

This entry contains the renderer, key enums, and physical key map.
It contains no Node imports or terminal parser.
Forward both keydown and keyup events.
The helper identifies repeats and preserves text for host encoding.
It returns null during composition previews and for unsupported keys.

When available, pass the browser keyboard layout map as the helper's second argument.
This preserves base codepoints for shifted punctuation and other keyboard layouts.
Without that map, the helper uses the observed character's lower-case codepoint.
Keep browser shortcuts outside focused terminal input.

## Source and licenses

Ghostty web source: `coder/ghostty-web` at `1858a5947767a3e1c9e98dbf53b2ff87fedb2aab`.
Ghostty source: `ghostty-org/ghostty` at `5714ed07a1012573261b7b7e3ed2add9c1504496`.
Both use the MIT license.
Their notices stay beside this README and inside generated output.

The native patch answers Kitty keyboard queries and exposes parsed keyboard options.
The wrapper patch preserves borrowed UTF8 memory and applies every key-event field.
It also exports the physical key map for browser event conversion.
