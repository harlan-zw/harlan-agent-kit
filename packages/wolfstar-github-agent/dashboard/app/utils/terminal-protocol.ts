import type {
  TerminalCapabilities,
  TerminalCell,
  TerminalFailure,
  TerminalProject,
  TerminalResult,
  TerminalScreen,
  TerminalServerMessage,
  TerminalSession,
  TerminalState,
  TerminalWriter,
} from '../../../src/terminal-protocol.ts'

const MAX_FRAME_BYTES = 8 * 1024 * 1024
const MAX_CELLS = 20_000
const states: readonly TerminalState[] = ['Starting', 'Running', 'Stopping', 'Exited', 'Interrupted', 'Unknown']
const failures: readonly TerminalFailure[] = [
  'InvalidRequest',
  'AuthenticationRequired',
  'OriginRefused',
  'ProtocolMismatch',
  'StaleGeneration',
  'WriterBusy',
  'StaleWriter',
  'DuplicateInput',
  'SizeLimit',
  'ProviderUnavailable',
  'ProjectUnavailable',
  'CapacityUnavailable',
  'CapacityRefused',
  'LaunchConflict',
  'OwnershipUnknown',
  'SessionUnavailable',
  'DeliveryUnknown',
]
const invalid = (): TerminalResult<never> => ({ _tag: 'Err', reason: 'InvalidRequest' })
const limit = (): TerminalResult<never> => ({ _tag: 'Err', reason: 'SizeLimit' })
const ok = <T>(value: T): TerminalResult<T> => ({ _tag: 'Ok', value })
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function text(value: unknown, max = 128): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}
function member<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === 'string' && choices.includes(value as T)
}
function scalar(value: unknown): value is number {
  return integer(value, 0, 0x10ffff) && !(value >= 0xd800 && value <= 0xdfff)
}
function unicode(value: string): boolean {
  for (const char of value) {
    const point = char.codePointAt(0)!
    if (point >= 0xd800 && point <= 0xdfff) return false
  }
  return true
}
function session(value: unknown): TerminalResult<TerminalSession> {
  if (
    !record(value) ||
    !text(value.id) ||
    !text(value.generation) ||
    !text(value.projectId) ||
    !text(value.hostId) ||
    !text(value.bootId) ||
    !member(value.provider, ['codex', 'claude', 'opencode'] as const) ||
    !member(value.state, states) ||
    !text(value.createdAt, 64) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !(value.worktree === null || text(value.worktree, 4096))
  ) {
    return invalid()
  }
  return ok({
    id: value.id,
    generation: value.generation,
    projectId: value.projectId,
    provider: value.provider,
    hostId: value.hostId,
    bootId: value.bootId,
    state: value.state,
    createdAt: value.createdAt,
    worktree: value.worktree,
  })
}
function writer(value: unknown): TerminalResult<TerminalWriter> {
  if (value === null) return ok(null)
  if (!record(value) || !text(value.viewId) || !text(value.lease) || !integer(value.expiresAt)) return invalid()
  return ok({ viewId: value.viewId, lease: value.lease, expiresAt: value.expiresAt })
}
export function parseTerminalCapabilities(value: unknown): TerminalResult<TerminalCapabilities> {
  if (
    !record(value) ||
    value.protocol !== 1 ||
    !text(value.hostId) ||
    !text(value.bootId) ||
    !text(value.hostLabel, 256) ||
    typeof value.controller !== 'boolean' ||
    !record(value.providers) ||
    typeof value.controllerReadOnly !== 'boolean' ||
    (value.controllerReadOnly && !value.controller) ||
    typeof value.providers.codex !== 'boolean' ||
    typeof value.providers.claude !== 'boolean' ||
    typeof value.providers.opencode !== 'boolean' ||
    !record(value.supports) ||
    !['terminal', 'stop', 'writer', 'resize', 'mouse', 'focus'].every(
      (key) => value.supports && record(value.supports) && value.supports[key] === true,
    )
  ) {
    return invalid()
  }
  return ok({
    protocol: 1,
    hostId: value.hostId,
    bootId: value.bootId,
    hostLabel: value.hostLabel,
    controller: value.controller,
    controllerReadOnly: value.controllerReadOnly,
    providers: { codex: value.providers.codex, claude: value.providers.claude, opencode: value.providers.opencode },
    supports: { terminal: true, stop: true, writer: true, resize: true, mouse: true, focus: true },
  })
}
export function parseTerminalProjects(value: unknown): TerminalResult<TerminalProject[]> {
  if (!Array.isArray(value)) return invalid()
  if (value.length > MAX_CELLS) return limit()
  const projects: TerminalProject[] = []
  const ids = new Set<string>()
  for (const item of value) {
    if (!record(item) || !text(item.id) || !text(item.name, 256) || !text(item.path, 4096) || ids.has(item.id))
      return invalid()
    ids.add(item.id)
    projects.push({ id: item.id, name: item.name, path: item.path })
  }
  return ok(projects)
}
export function parseTerminalSessions(value: unknown): TerminalResult<TerminalSession[]> {
  if (!Array.isArray(value)) return invalid()
  if (value.length > MAX_CELLS) return limit()
  const sessions: TerminalSession[] = []
  const ids = new Set<string>()
  for (const item of value) {
    const result = session(item)
    if (result._tag === 'Err') return result
    if (ids.has(result.value.id)) return invalid()
    ids.add(result.value.id)
    sessions.push(result.value)
  }
  return ok(sessions)
}
export function parseTerminalSessionResult(value: unknown): TerminalResult<TerminalSession> {
  if (!record(value)) return invalid()
  if (value._tag === 'Err' && member(value.reason, failures)) return { _tag: 'Err', reason: value.reason }
  return value._tag === 'Ok' ? session(value.value) : invalid()
}
function cell(value: unknown): TerminalResult<TerminalCell> {
  if (
    !record(value) ||
    !scalar(value.codepoint) ||
    !['fg_r', 'fg_g', 'fg_b', 'bg_r', 'bg_g', 'bg_b'].every((key) => integer(value[key], 0, 255)) ||
    !integer(value.flags, 0, 255) ||
    !integer(value.width, 0, 2) ||
    !integer(value.hyperlink_id, 0, 65535) ||
    !integer(value.grapheme_len, 0, 255)
  ) {
    return invalid()
  }
  return ok({
    codepoint: value.codepoint,
    fg_r: value.fg_r as number,
    fg_g: value.fg_g as number,
    fg_b: value.fg_b as number,
    bg_r: value.bg_r as number,
    bg_g: value.bg_g as number,
    bg_b: value.bg_b as number,
    flags: value.flags,
    width: value.width,
    hyperlink_id: value.hyperlink_id,
    grapheme_len: value.grapheme_len,
  })
}
function grid(
  lines: unknown,
  graphemes: unknown,
  dimensions?: { rows: number; cols: number },
): TerminalResult<{ lines: TerminalCell[][]; graphemes: string[][] }> {
  if (!Array.isArray(lines) || !Array.isArray(graphemes)) return invalid()
  if (lines.length > 200 || graphemes.length > 200) return limit()
  if (lines.length !== graphemes.length || (dimensions && lines.length !== dimensions.rows)) return invalid()
  const parsedLines: TerminalCell[][] = []
  const parsedGraphemes: string[][] = []
  let count = 0
  for (let row = 0; row < lines.length; row++) {
    const line: unknown = lines[row]
    const strings: unknown = graphemes[row]
    if (!Array.isArray(line) || !Array.isArray(strings)) return invalid()
    count += line.length
    if (line.length > 500 || strings.length > 500 || count > MAX_CELLS) return limit()
    if (line.length !== strings.length || (dimensions && line.length !== dimensions.cols)) return invalid()
    const parsed: TerminalCell[] = []
    const glyphs: string[] = []
    for (let col = 0; col < line.length; col++) {
      const result = cell(line[col])
      if (result._tag === 'Err') return result
      const glyph: unknown = strings[col]
      if (typeof glyph !== 'string' || !unicode(glyph) || glyph.includes('\0')) return invalid()
      if (glyph.length > 4096) return limit()
      parsed.push(result.value)
      glyphs.push(glyph)
    }
    parsedLines.push(parsed)
    parsedGraphemes.push(glyphs)
  }
  return ok({ lines: parsedLines, graphemes: parsedGraphemes })
}
function screen(value: unknown): TerminalResult<TerminalScreen> {
  if (
    !record(value) ||
    !integer(value.revision) ||
    !integer(value.scrollbackLength, 0, 1000) ||
    !record(value.dimensions) ||
    !record(value.cursor) ||
    !record(value.modes)
  ) {
    return invalid()
  }
  const { cols, rows } = value.dimensions
  if (!integer(cols, 2, 500) || !integer(rows, 2, 200) || cols * rows > MAX_CELLS) return limit()
  if (
    !integer(value.cursor.x, 0, cols - 1) ||
    !integer(value.cursor.y, 0, rows - 1) ||
    typeof value.cursor.visible !== 'boolean' ||
    !['alternate', 'paste', 'focus', 'mouse'].every(
      (key) => record(value.modes) && typeof value.modes[key] === 'boolean',
    ) ||
    !integer(value.modes.keyboard, 0, 31) ||
    !Array.isArray(value.wrapped) ||
    value.wrapped.length !== rows ||
    !value.wrapped.every((item) => typeof item === 'boolean')
  ) {
    return invalid()
  }
  const parsed = grid(value.lines, value.graphemes, { cols, rows })
  if (parsed._tag === 'Err') return parsed
  return ok({
    revision: value.revision,
    scrollbackLength: value.scrollbackLength,
    dimensions: { cols, rows },
    cursor: { x: value.cursor.x, y: value.cursor.y, visible: value.cursor.visible },
    ...parsed.value,
    wrapped: [...value.wrapped],
    modes: {
      alternate: value.modes.alternate as boolean,
      paste: value.modes.paste as boolean,
      focus: value.modes.focus as boolean,
      mouse: value.modes.mouse as boolean,
      keyboard: value.modes.keyboard,
    },
  })
}
export function parseTerminalServerMessage(value: unknown): TerminalResult<TerminalServerMessage> {
  if (!record(value)) return invalid()
  if (value.type === 'Attached') {
    if (value.protocol !== 1) return invalid()
    const parsedSession = session(value.session)
    if (parsedSession._tag === 'Err') return parsedSession
    const parsedWriter = writer(value.writer)
    return parsedWriter._tag === 'Err'
      ? parsedWriter
      : ok({ type: 'Attached', protocol: 1, session: parsedSession.value, writer: parsedWriter.value })
  }
  if (value.type === 'WriterChanged') {
    const result = writer(value.writer)
    return result._tag === 'Err' ? result : ok({ type: 'WriterChanged', writer: result.value })
  }
  if (value.type === 'Screen' && text(value.generation)) {
    const result = screen(value.screen)
    return result._tag === 'Err' ? result : ok({ type: 'Screen', generation: value.generation, screen: result.value })
  }
  if (value.type === 'Rows' && text(value.generation)) {
    if (
      !integer(value.baseRevision) ||
      !integer(value.revision, value.baseRevision + 1) ||
      !integer(value.scrollbackLength, 0, 1000) ||
      !Array.isArray(value.rows) ||
      !record(value.cursor) ||
      !integer(value.cursor.x, 0, 499) ||
      !integer(value.cursor.y, 0, 199) ||
      typeof value.cursor.visible !== 'boolean' ||
      !record(value.modes) ||
      !['alternate', 'paste', 'focus', 'mouse'].every(
        (key) => record(value.modes) && typeof value.modes[key] === 'boolean',
      ) ||
      !integer(value.modes.keyboard, 0, 31)
    ) {
      return invalid()
    }
    if (value.rows.length > 200) return limit()
    const indices = new Set<number>()
    const rows: Extract<TerminalServerMessage, { type: 'Rows' }>['rows'] = []
    let cells = 0
    for (const row of value.rows) {
      if (!record(row) || !integer(row.index, 0, 199) || indices.has(row.index) || typeof row.wrapped !== 'boolean')
        return invalid()
      const result = grid([row.cells], [row.graphemes])
      if (result._tag === 'Err') return result
      const line = result.value.lines[0]!
      if (line.length < 2) return invalid()
      cells += line.length
      if (cells > MAX_CELLS) return limit()
      indices.add(row.index)
      rows.push({ index: row.index, cells: line, graphemes: result.value.graphemes[0]!, wrapped: row.wrapped })
    }
    return ok({
      type: 'Rows',
      generation: value.generation,
      baseRevision: value.baseRevision,
      revision: value.revision,
      rows,
      cursor: { x: value.cursor.x, y: value.cursor.y, visible: value.cursor.visible },
      modes: {
        alternate: value.modes.alternate as boolean,
        paste: value.modes.paste as boolean,
        focus: value.modes.focus as boolean,
        mouse: value.modes.mouse as boolean,
        keyboard: value.modes.keyboard,
      },
      scrollbackLength: value.scrollbackLength,
    })
  }
  if (
    value.type === 'Scrollback' &&
    text(value.generation) &&
    integer(value.total, 0, 1000) &&
    integer(value.offset, 0, value.total)
  ) {
    const result = grid(value.lines, value.graphemes)
    if (result._tag === 'Err') return result
    if (value.offset + result.value.lines.length > value.total) return invalid()
    return ok({
      type: 'Scrollback',
      generation: value.generation,
      total: value.total,
      offset: value.offset,
      ...result.value,
    })
  }
  if (value.type === 'InputReceipt' && integer(value.sequence, 1) && text(value.lease))
    return ok({ type: 'InputReceipt', sequence: value.sequence, lease: value.lease })
  if (value.type === 'Process' && member(value.state, states)) return ok({ type: 'Process', state: value.state })
  if (value.type === 'Failure' && member(value.reason, failures)) return ok({ type: 'Failure', reason: value.reason })
  return invalid()
}
export function parseTerminalFrame(input: string): TerminalResult<TerminalServerMessage> {
  if (input.length > MAX_FRAME_BYTES || new TextEncoder().encode(input).byteLength > MAX_FRAME_BYTES) return limit()
  let value: unknown
  try {
    value = JSON.parse(input)
  } catch (cause) {
    if (cause instanceof SyntaxError) return invalid()
    throw cause
  }
  return parseTerminalServerMessage(value)
}
