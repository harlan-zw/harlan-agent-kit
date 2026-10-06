// Pure core for `explicit-server-imports.ts`. It turns Nitro's server
// auto-imports into explicit imports, file by file. No I/O here: the caller
// passes file text in and writes the result out.
//
// Why this exists: `future.compatibilityVersion: 5` on Nuxt 4.6 sets
// `experimental.nitroAutoImports` to false. The build still exits 0, and every
// handler that relied on an auto-import then fails with a 500 at runtime.
import type * as TS from 'typescript'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

export interface AutoImport {
  /** Export name in the source module. */
  name: string
  /** Local name the auto-import exposes. */
  as: string
  /** Bare specifier, or an absolute path without extension. */
  from: string
  type: boolean
}

export interface Alias {
  /** Alias prefix without the trailing `/*`, such as `#server`. */
  alias: string
  /** Absolute directory the alias points to. */
  target: string
}

/**
 * `module`: a helper a module registered, with no public import path. It stays
 * an auto-import. Nuxt 5 auto-imports helpers that modules register; on 4.x it
 * depends on the installed kit, as the server imports reference explains.
 * `unreachable`: anything else. A person must import it by hand.
 */
export type Resolution
  = | { _tag: 'Ok', specifier: string }
    | { _tag: 'Err', kind: 'module' | 'unreachable', reason: string }

export interface AddedImport { name: string, as: string, specifier: string, type: boolean }

export interface FileEdit {
  code: string
  added: AddedImport[]
  /** Module helpers left as auto-imports. */
  kept: Array<{ as: string, reason: string }>
  unmapped: Array<{ as: string, reason: string }>
  /** True when every server helper the file uses behaves the same under `nuxt/server`. */
  portable: boolean
}

const EXPORT_LINE = /^\s*export (type )?\{([^}]*)\} from '([^']+)';?\s*$/gm
const NITROPACK_INTERNAL = /^nitropack\/runtime\/internal\//
// Nitro internals, and root aliases that would reach into `node_modules`.
// `#build` stays: generated templates in `.nuxt/` are imported through it.
const SKIPPED_ALIAS = /^(?:#internal|~~?|@@?)\//
const SOURCE_EXTENSION = /\.(?:d\.ts|d\.mts|ts|mts|cts|js|mjs|cjs)$/

/**
 * Parse `.nuxt/types/nitro-imports.d.ts`. Relative specifiers resolve against
 * `typesDir`, the directory that holds the file.
 */
export function parseNitroImports(dts: string, typesDir: string): AutoImport[] {
  const entries: AutoImport[] = []
  for (const match of dts.matchAll(EXPORT_LINE)) {
    const [, typeKeyword, names = '', rawFrom = ''] = match
    const from = rawFrom.startsWith('.')
      ? stripExtension(resolve(typesDir, rawFrom)).replace(/\.d$/, '')
      : stripExtension(rawFrom).replace(/\.d$/, '')
    for (const part of names.split(',')) {
      const [name, as = name] = part.trim().split(/\s+as\s+/)
      if (name)
        entries.push({ name, as: as!, from, type: Boolean(typeKeyword) })
    }
  }
  return entries
}

/** Parse the export names of `nitropack/dist/runtime/index.d.ts`. */
export function parseExportNames(dts: string): Set<string> {
  const names = new Set<string>()
  for (const match of dts.matchAll(/export (?:type )?\{([^}]*)\}/g)) {
    for (const part of (match[1] ?? '').split(',')) {
      const local = part.trim().split(/\s+as\s+/).pop()
      if (local)
        names.add(local)
    }
  }
  return names
}

/**
 * Read wildcard aliases from `.nuxt/tsconfig.server.json`. Nuxt writes these
 * from Nitro's aliases, so the build resolves every alias returned here.
 * `rootDir` is the app root. An alias that points at it or above it, such as
 * `~~` or a workspace package name, would swallow every path, so it is skipped.
 */
export function parseServerAliases(
  tsconfig: { compilerOptions?: { paths?: Record<string, string[]> } },
  tsconfigDir: string,
  rootDir: string,
): Alias[] {
  const aliases: Alias[] = []
  for (const [key, targets] of Object.entries(tsconfig.compilerOptions?.paths ?? {})) {
    const target = targets[0]
    if (!key.endsWith('/*') || !target?.endsWith('/*') || SKIPPED_ALIAS.test(key))
      continue
    const dir = resolve(tsconfigDir, target.slice(0, -2))
    if (dir === rootDir || rootDir.startsWith(`${dir}/`))
      continue
    aliases.push({ alias: key.slice(0, -2), target: dir })
  }
  // Longest target first, so `#server` wins over a broader alias that also matches.
  return aliases.sort((a, b) => b.target.length - a.target.length)
}

export interface ResolveContext {
  aliases: Alias[]
  nitroRuntimeExports: Set<string>
  /** Map a file inside `node_modules` to the package export that serves it. */
  packageSubpath: (path: string) => string | undefined
}

/** Choose the specifier one file should import an auto-import from. */
export function resolveSpecifier(entry: AutoImport, importer: string, context: ResolveContext): Resolution {
  const { from, name } = entry
  if (!isAbsolute(from)) {
    if (NITROPACK_INTERNAL.test(from)) {
      return context.nitroRuntimeExports.has(name)
        ? { _tag: 'Ok', specifier: 'nitropack/runtime' }
        : { _tag: 'Err', kind: 'unreachable', reason: `${name} is not exported from nitropack/runtime` }
    }
    if (from.startsWith('#internal/'))
      return { _tag: 'Err', kind: 'unreachable', reason: `${from} is internal to Nitro` }
    return { _tag: 'Ok', specifier: from }
  }
  const path = from.replace(/\/index$/, '')
  const inPackage = path.includes('/node_modules/')
  for (const { alias, target } of context.aliases) {
    // A package file is reachable only through an alias the package's module registered.
    if (inPackage && !target.includes('/node_modules/'))
      continue
    if (path === target)
      return { _tag: 'Ok', specifier: alias }
    if (path.startsWith(`${target}/`))
      return { _tag: 'Ok', specifier: `${alias}/${path.slice(target.length + 1)}` }
  }
  if (inPackage) {
    const subpath = context.packageSubpath(from)
    return subpath
      ? { _tag: 'Ok', specifier: subpath }
      : { _tag: 'Err', kind: 'module', reason: `no alias or package export reaches ${path}` }
  }
  const rel = relative(dirname(importer), path)
  return { _tag: 'Ok', specifier: rel.startsWith('.') ? rel : `./${rel}` }
}

/**
 * Find the `exports` subpath of `pkg` whose target is `file`. `pkgRoot` is the
 * package directory and `file` an absolute path without extension.
 */
export function findExportSubpath(pkg: { name?: string, exports?: unknown }, pkgRoot: string, file: string): string | undefined {
  if (!pkg.name || !pkg.exports)
    return undefined
  const exportsMap = typeof pkg.exports === 'object' && Object.keys(pkg.exports).every(key => key.startsWith('.'))
    ? pkg.exports as Record<string, unknown>
    : { '.': pkg.exports }
  for (const [subpath, target] of Object.entries(exportsMap)) {
    const path = firstTarget(target)
    if (subpath.includes('*') || !path)
      continue
    const resolved = stripExtension(resolve(pkgRoot, path))
    if (resolved === file || resolved === `${file}/index`)
      return subpath === '.' ? pkg.name : `${pkg.name}${subpath.slice(1)}`
  }
  return undefined
}

function firstTarget(target: unknown): string | undefined {
  if (typeof target === 'string')
    return target
  if (!target || typeof target !== 'object')
    return undefined
  const conditions = target as Record<string, unknown>
  for (const key of ['import', 'default', 'node', 'require']) {
    const found = firstTarget(conditions[key])
    if (found)
      return found
  }
  return undefined
}

/**
 * Helpers whose `nuxt/server` version behaves like the h3 v1 or Nitro one.
 * `sendRedirect`, `getRouterParam(s)`, `handleCors` and the session helpers
 * differ, so a file using them needs a person to read the differences table.
 */
const PORTABLE_HELPERS = new Set([
  'createError',
  'defineEventHandler',
  'deleteCookie',
  'getCookie',
  'getQuery',
  'getRequestHeader',
  'getRequestHeaders',
  'getRequestHost',
  'getRequestIP',
  'getRequestProtocol',
  'getRequestURL',
  'getValidatedQuery',
  'parseCookies',
  'readBody',
  'readValidatedBody',
  'setCookie',
  'setResponseStatus',
  'useAppConfig',
  'useRuntimeConfig',
])

/** Event members that `RequestEvent` provides. Any other member pins the file to h3. */
const PORTABLE_EVENT_MEMBERS = new Set(['req', 'url', 'res', 'context'])

/**
 * Add explicit imports for every auto-import `code` uses without declaring.
 * `resolveEntry` decides the specifier, or reports why it cannot.
 */
export function addExplicitImports(
  ts: typeof TS,
  code: string,
  fileName: string,
  entries: AutoImport[],
  resolveEntry: (entry: AutoImport) => Resolution,
): FileEdit {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, scriptKind(ts, fileName))
  const { declared, used, eventMembers } = scan(ts, source)
  const byLocal = new Map<string, AutoImport>()
  for (const entry of entries) {
    // A value export wins over a type export of the same name.
    if (!byLocal.has(entry.as) || (byLocal.get(entry.as)!.type && !entry.type))
      byLocal.set(entry.as, entry)
  }

  const added: AddedImport[] = []
  const kept: FileEdit['kept'] = []
  const unmapped: FileEdit['unmapped'] = []
  let portable = true
  let usesServerHelper = false
  for (const [local, kind] of used) {
    const entry = byLocal.get(local)
    if (!entry || declared.has(local))
      continue
    // Module helpers take the h3 event, so a file using one stays on h3.
    if (entry.from.includes('/node_modules/') && !entry.type && kind === 'value')
      portable = false
    const resolution = resolveEntry(entry)
    if (resolution._tag === 'Err') {
      (resolution.kind === 'module' ? kept : unmapped).push({ as: local, reason: resolution.reason })
      continue
    }
    const type = entry.type || kind === 'type'
    added.push({ name: entry.name, as: local, specifier: resolution.specifier, type })
    if (resolution.specifier === 'h3' || resolution.specifier === 'nitropack/runtime') {
      usesServerHelper = true
      if (!type && !PORTABLE_HELPERS.has(entry.name))
        portable = false
    }
  }
  for (const member of eventMembers) {
    if (!PORTABLE_EVENT_MEMBERS.has(member))
      portable = false
  }
  if (hasImportFrom(ts, source, ['h3', 'nitropack/runtime', 'nitropack']))
    portable = false

  added.sort((a, b) => a.as.localeCompare(b.as))
  return {
    code: added.length ? insertImports(ts, source, code, added) : code,
    added,
    kept,
    unmapped,
    portable: portable && usesServerHelper,
  }
}

function stripExtension(path: string): string {
  return path.replace(SOURCE_EXTENSION, '')
}

function scriptKind(ts: typeof TS, fileName: string): TS.ScriptKind {
  return /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS
}

interface Scan {
  /** Every name the file binds anywhere. Scope is ignored on purpose: a missed import fails typecheck, a wrong one does not. */
  declared: Set<string>
  used: Map<string, 'value' | 'type'>
  /** Members read from a parameter named like an event, such as `event.node`. */
  eventMembers: Set<string>
}

function scan(ts: typeof TS, source: TS.SourceFile): Scan {
  const declared = new Set<string>()
  const used = new Map<string, 'value' | 'type'>()
  const eventMembers = new Set<string>()
  const visit = (node: TS.Node): void => {
    if (ts.isIdentifier(node)) {
      const role = identifierRole(ts, node)
      if (role === 'declaration') {
        declared.add(node.text)
      }
      else if (role !== 'none') {
        if (role === 'value' || !used.has(node.text))
          used.set(node.text, role)
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && /^(?:event|e|evt)$/.test(node.expression.text))
      eventMembers.add(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { declared, used, eventMembers }
}

function identifierRole(ts: typeof TS, id: TS.Identifier): 'declaration' | 'value' | 'type' | 'none' {
  const parent = id.parent
  if (!parent)
    return 'none'
  if (isBindingName(ts, id, parent))
    return 'declaration'
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === id)
    || (ts.isQualifiedName(parent) && parent.right === id)
    || (ts.isPropertyAssignment(parent) && parent.name === id)
    || (ts.isBindingElement(parent) && parent.propertyName === id)
    || (ts.isImportSpecifier(parent) && parent.propertyName === id)
    || (ts.isExportSpecifier(parent) && (Boolean(parent.parent.parent.moduleSpecifier) || (parent.name === id && Boolean(parent.propertyName))))
    || (ts.isMetaProperty(parent))
    || (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent))
    || (ts.isJsxAttribute(parent) && parent.name === id)
    || (ts.isNamedTupleMember(parent) && parent.name === id)
    || isMemberName(ts, id, parent)
  ) {
    return 'none'
  }
  return usageKind(ts, id)
}

function isBindingName(ts: typeof TS, id: TS.Identifier, parent: TS.Node): boolean {
  return (
    (ts.isVariableDeclaration(parent) && parent.name === id)
    || (ts.isBindingElement(parent) && parent.name === id)
    || (ts.isParameter(parent) && parent.name === id)
    || ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)) && parent.name === id)
    || ((ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) && parent.name === id)
    || ((ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isEnumDeclaration(parent)) && parent.name === id)
    || (ts.isModuleDeclaration(parent) && parent.name === id)
    || (ts.isTypeParameterDeclaration(parent) && parent.name === id)
    || (ts.isImportClause(parent) && parent.name === id)
    || (ts.isImportSpecifier(parent) && parent.name === id)
    || (ts.isNamespaceImport(parent) && parent.name === id)
    || (ts.isImportEqualsDeclaration(parent) && parent.name === id)
  )
}

function isMemberName(ts: typeof TS, id: TS.Identifier, parent: TS.Node): boolean {
  return (
    ts.isPropertyDeclaration(parent)
    || ts.isPropertySignature(parent)
    || ts.isMethodDeclaration(parent)
    || ts.isMethodSignature(parent)
    || ts.isGetAccessorDeclaration(parent)
    || ts.isSetAccessorDeclaration(parent)
    || ts.isEnumMember(parent)
  ) && (parent as TS.NamedDeclaration).name === id
}

function usageKind(ts: typeof TS, id: TS.Identifier): 'value' | 'type' {
  // Climb to the head of `A.B.C` so the container decides the kind.
  let node: TS.Node = id
  while (node.parent && (ts.isQualifiedName(node.parent) || ts.isPropertyAccessExpression(node.parent)) && firstOf(ts, node.parent) === node)
    node = node.parent
  const container = node.parent
  if (!container)
    return 'value'
  if (ts.isExpressionWithTypeArguments(container) && ts.isHeritageClause(container.parent)) {
    const isClassExtends = container.parent.token === ts.SyntaxKind.ExtendsKeyword && !ts.isInterfaceDeclaration(container.parent.parent)
    return isClassExtends ? 'value' : 'type'
  }
  if (ts.isTypeReferenceNode(container) || ts.isTypeQueryNode(container))
    return 'type'
  return 'value'
}

function firstOf(ts: typeof TS, node: TS.QualifiedName | TS.PropertyAccessExpression): TS.Node {
  return ts.isQualifiedName(node) ? node.left : node.expression
}

function hasImportFrom(ts: typeof TS, source: TS.SourceFile, specifiers: string[]): boolean {
  return source.statements.some(statement =>
    ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier)
    && specifiers.includes(statement.moduleSpecifier.text),
  )
}

function insertImports(ts: typeof TS, source: TS.SourceFile, code: string, added: AddedImport[]): string {
  const edits: Array<{ at: number, text: string }> = []
  const fresh: string[] = []
  const imports = source.statements.filter(ts.isImportDeclaration)

  for (const { specifier, type, specifierText } of groupBySpecifier(added)) {
    const existing = imports.find(statement =>
      ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === specifier
      && Boolean(statement.importClause?.isTypeOnly) === type
      && statement.importClause?.namedBindings
      && ts.isNamedImports(statement.importClause.namedBindings),
    )
    const bindings = existing?.importClause?.namedBindings as TS.NamedImports | undefined
    if (bindings) {
      const last = bindings.elements.at(-1)
      edits.push(last
        ? { at: last.end, text: `, ${specifierText.join(', ')}` }
        : { at: bindings.getStart(source) + 1, text: ` ${specifierText.join(', ')} ` })
    }
    else {
      fresh.push(`import ${type ? 'type ' : ''}{ ${specifierText.join(', ')} } from '${specifier}'`)
    }
  }

  if (fresh.length) {
    const lines = fresh.join('\n')
    const lastImport = imports.at(-1)
    if (lastImport) {
      edits.push({ at: lastImport.end, text: `\n${lines}` })
    }
    else {
      const shebang = code.startsWith('#!') ? code.indexOf('\n') + 1 : 0
      edits.push({ at: shebang, text: `${lines}\n\n` })
    }
  }

  let out = code
  for (const { at, text } of edits.sort((a, b) => b.at - a.at))
    out = out.slice(0, at) + text + out.slice(at)
  return out
}

function groupBySpecifier(added: AddedImport[]): Array<{ specifier: string, type: boolean, specifierText: string[] }> {
  const groups = new Map<string, { specifier: string, type: boolean, specifierText: string[] }>()
  for (const entry of added) {
    const key = `${entry.type}:${entry.specifier}`
    const group = groups.get(key) ?? { specifier: entry.specifier, type: entry.type, specifierText: [] }
    group.specifierText.push(entry.name === entry.as ? entry.name : `${entry.name} as ${entry.as}`)
    groups.set(key, group)
  }
  return [...groups.values()]
}
