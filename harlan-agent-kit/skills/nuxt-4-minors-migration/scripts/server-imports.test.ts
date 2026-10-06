import type { AutoImport } from './server-imports.ts'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { run } from './explicit-server-imports.ts'
import { addExplicitImports, findExportSubpath, parseNitroImports, parseServerAliases, resolveSpecifier } from './server-imports.ts'

const ROOT = '/site'
const aliases = parseServerAliases({
  compilerOptions: {
    paths: {
      '#server/*': ['../server/*'],
      '#shared/*': ['../shared/*'],
      '#site-config/*': ['../node_modules/nuxt-site-config/dist/runtime/*'],
      '#build/*': ['./*'],
      '#internal/nitro/*': ['../node_modules/nitropack/dist/runtime/*'],
      '~~/*': ['../*'],
      '@@/*': ['../*'],
      '@scope/app/*': ['../*'],
    },
  },
}, `${ROOT}/.nuxt`, ROOT)
const context = {
  aliases,
  nitroRuntimeExports: new Set(['useRuntimeConfig', 'useStorage', 'defineNitroPlugin']),
  packageSubpath: (path: string) => path === `${ROOT}/node_modules/evlog/dist/runtime/server/index` ? 'evlog/server' : undefined,
}

const entries: AutoImport[] = [
  { name: 'defineEventHandler', as: 'defineEventHandler', from: 'h3', type: false },
  { name: 'getQuery', as: 'getQuery', from: 'h3', type: false },
  { name: 'sendRedirect', as: 'sendRedirect', from: 'h3', type: false },
  { name: 'H3Event', as: 'H3Event', from: 'h3', type: false },
  { name: 'useRuntimeConfig', as: 'useRuntimeConfig', from: 'nitropack/runtime/internal/config', type: false },
  { name: 'nitroPlugin', as: 'nitroPlugin', from: 'nitropack/runtime/internal/plugin', type: false },
  { name: 'greet', as: 'greet', from: `${ROOT}/server/utils/greet`, type: false },
  { name: 'helper', as: 'layerHelper', from: `${ROOT}/layers/core/server/utils/helper`, type: false },
  { name: 'getSiteConfig', as: 'getSiteConfig', from: `${ROOT}/node_modules/nuxt-site-config/dist/runtime/server/composables/getSiteConfig`, type: false },
  { name: 'useImage', as: 'useImage', from: `${ROOT}/node_modules/@nuxt/image/dist/runtime/server/utils/image`, type: false },
  { name: 'useLogger', as: 'useLogger', from: `${ROOT}/node_modules/evlog/dist/runtime/server/index`, type: false },
  { name: 'useDb', as: 'useDb', from: `${ROOT}/.nuxt/drizzle/db`, type: false },
  { name: 'BotContext', as: 'BotContext', from: `${ROOT}/node_modules/nuxt-site-config/dist/runtime/types`, type: true },
]

function edit(code: string, file = `${ROOT}/server/api/hello.ts`) {
  return addExplicitImports(ts, code, file, entries, entry => resolveSpecifier(entry, file, context))
}

describe('findExportSubpath', () => {
  const pkg = {
    name: '@scope/pkg',
    exports: {
      '.': { types: './dist/index.d.mts', import: './dist/index.mjs' },
      './server': { import: { types: './dist/server.d.mts', default: './dist/runtime/server/index.mjs' } },
      './*': './dist/*.mjs',
    },
  }
  it('maps a file to the export subpath that serves it', () => {
    expect(findExportSubpath(pkg, '/nm/@scope/pkg', '/nm/@scope/pkg/dist/runtime/server')).toBe('@scope/pkg/server')
    expect(findExportSubpath(pkg, '/nm/@scope/pkg', '/nm/@scope/pkg/dist/index')).toBe('@scope/pkg')
    expect(findExportSubpath({ name: 'solo', exports: './main.js' }, '/nm/solo', '/nm/solo/main')).toBe('solo')
  })
  it('returns nothing for a file no export serves', () => {
    expect(findExportSubpath(pkg, '/nm/@scope/pkg', '/nm/@scope/pkg/dist/runtime/server/standalone')).toBeUndefined()
  })
})

describe('parseNitroImports', () => {
  it('reads value and type exports, aliases, and relative paths', () => {
    const dts = [
      'declare global {',
      '  // @ts-ignore',
      `  export type { BotDetectionContext } from '../../node_modules/robots/dist/runtime/getBotDetection.d'`,
      '}',
      `export { useNitroApp } from 'nitropack/runtime/internal/app';`,
      `export { getRouteRules as getSiteRouteRules, getSiteConfig } from '/site/node_modules/site-config/dist/runtime/server/composables/utils';`,
    ].join('\n')
    expect(parseNitroImports(dts, '/site/.nuxt/types')).toEqual([
      { name: 'BotDetectionContext', as: 'BotDetectionContext', from: '/site/node_modules/robots/dist/runtime/getBotDetection', type: true },
      { name: 'useNitroApp', as: 'useNitroApp', from: 'nitropack/runtime/internal/app', type: false },
      { name: 'getRouteRules', as: 'getSiteRouteRules', from: '/site/node_modules/site-config/dist/runtime/server/composables/utils', type: false },
      { name: 'getSiteConfig', as: 'getSiteConfig', from: '/site/node_modules/site-config/dist/runtime/server/composables/utils', type: false },
    ])
  })
})

describe('addExplicitImports', () => {
  it('imports each used auto-import from a committable specifier', () => {
    const result = edit([
      'export default defineEventHandler(async (event) => {',
      '  const config = useRuntimeConfig(event)',
      '  return { a: greet(getQuery(event).name), b: layerHelper(), c: await getSiteConfig(event) }',
      '})',
    ].join('\n'))
    expect(result.code.split('\n').slice(0, 5)).toEqual([
      `import { defineEventHandler, getQuery } from 'h3'`,
      `import { getSiteConfig } from '#site-config/server/composables/getSiteConfig'`,
      `import { greet } from '#server/utils/greet'`,
      `import { helper as layerHelper } from '../../layers/core/server/utils/helper'`,
      `import { useRuntimeConfig } from 'nitropack/runtime'`,
    ])
    expect(result.unmapped).toEqual([])
  })

  it('leaves names the file binds itself', () => {
    const result = edit([
      `import { getQuery } from './local'`,
      'function greet() {}',
      'export default defineEventHandler(({ useRuntimeConfig }) => greet(getQuery, useRuntimeConfig))',
    ].join('\n'))
    expect(result.added.map(item => item.as)).toEqual(['defineEventHandler'])
  })

  it('ignores property names and member access but imports shorthand properties', () => {
    const result = edit('const o = { getQuery: 1, greet, x: api.sendRedirect, useRuntimeConfig() {} }')
    expect(result.added.map(item => item.as)).toEqual(['greet'])
  })

  it('imports type-only usage with import type', () => {
    const result = edit('export function f(event: H3Event, ctx: BotContext): typeof greet { return null! }')
    expect(result.code.split('\n').slice(0, 3)).toEqual([
      `import type { BotContext } from '#site-config/types'`,
      `import type { greet } from '#server/utils/greet'`,
      `import type { H3Event } from 'h3'`,
    ])
  })

  it('merges into an existing named import from the same specifier', () => {
    const result = edit([
      `import { readBody } from 'h3'`,
      '',
      'export default defineEventHandler(event => readBody(event))',
    ].join('\n'))
    expect(result.code.split('\n')[0]).toBe(`import { readBody, defineEventHandler } from 'h3'`)
  })

  it('inserts after the last import and keeps a shebang first', () => {
    expect(edit(`import a from 'a'\nexport default defineEventHandler(a)`).code)
      .toBe(`import a from 'a'\nimport { defineEventHandler } from 'h3'\nexport default defineEventHandler(a)`)
    expect(edit(`#!/usr/bin/env node\ndefineEventHandler()`).code)
      .toBe(`#!/usr/bin/env node\nimport { defineEventHandler } from 'h3'\n\ndefineEventHandler()`)
  })

  it('reaches module files through package exports, never through a root alias', () => {
    expect(edit('useLogger()').code.split('\n')[0]).toBe(`import { useLogger } from 'evlog/server'`)
  })

  it('imports generated templates through #build, ahead of a broader workspace alias', () => {
    expect(edit('useDb()').code.split('\n')[0]).toBe(`import { useDb } from '#build/drizzle/db'`)
  })

  it('keeps module helpers with no public path as auto-imports, and reports other misses', () => {
    const result = edit('nitroPlugin(() => useImage())')
    expect(result.added).toEqual([])
    expect(result.kept).toEqual([
      { as: 'useImage', reason: `no alias or package export reaches ${ROOT}/node_modules/@nuxt/image/dist/runtime/server/utils/image` },
    ])
    expect(result.unmapped).toEqual([
      { as: 'nitroPlugin', reason: 'nitroPlugin is not exported from nitropack/runtime' },
    ])
  })

  it('returns the code unchanged when nothing is auto-imported', () => {
    const code = `import { x } from 'y'\nexport const z = x`
    expect(edit(code)).toEqual({ code, added: [], kept: [], unmapped: [], portable: false })
  })

  it('marks a file portable only when nuxt/server helpers behave the same', () => {
    expect(edit('export default defineEventHandler(event => ({ q: getQuery(event), u: event.url, c: useRuntimeConfig() }))').portable).toBe(true)
    expect(edit('export default defineEventHandler(event => sendRedirect(event, "/"))').portable).toBe(false)
    expect(edit('export default defineEventHandler(event => event.node.req.url)').portable).toBe(false)
    expect(edit(`import { readBody } from 'h3'\nexport default defineEventHandler(event => readBody(event))`).portable).toBe(false)
    expect(edit('export default defineEventHandler(event => getSiteConfig(event))').portable).toBe(false)
  })
})

describe('run', () => {
  let root = ''
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function project(files: Record<string, string>) {
    root = mkdtempSync(join(tmpdir(), 'explicit-server-imports-'))
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), content)
    }
  }

  const tsconfig = JSON.stringify({ compilerOptions: { paths: { '#server/*': ['../server/*'], '#shared/*': ['../shared/*'] } } })

  it('rewrites server files, limits shared files to shared code, and skips declaration files', () => {
    project({
      '.nuxt/tsconfig.server.json': tsconfig,
      '.nuxt/types/nitro-imports.d.ts': [
        `export { defineEventHandler } from 'h3';`,
        `export { slug } from '../../shared/utils/slug';`,
      ].join('\n'),
      'server/api/a.ts': 'export default defineEventHandler(() => slug("x"))',
      'server/types.d.ts': 'declare const x: typeof defineEventHandler',
      'shared/utils/title.ts': 'export const title = (s: string) => slug(s) + defineEventHandler',
    })
    const result = run({ root, serverDirs: ['server'], sharedDirs: ['shared'], write: true }, ts)
    expect(result).toMatchObject({ _tag: 'Ok', scanned: 2 })
    expect(readFileSync(join(root, 'server/api/a.ts'), 'utf8').split('\n').slice(0, 2)).toEqual([
      `import { defineEventHandler } from 'h3'`,
      `import { slug } from '#shared/utils/slug'`,
    ])
    expect(readFileSync(join(root, 'shared/utils/title.ts'), 'utf8').split('\n')[0]).toBe(`import { slug } from '#shared/utils/slug'`)
  })

  it('leaves files untouched without --write', () => {
    project({
      '.nuxt/tsconfig.server.json': tsconfig,
      '.nuxt/types/nitro-imports.d.ts': `export { defineEventHandler } from 'h3';`,
      'server/api/a.ts': 'export default defineEventHandler(() => 1)',
    })
    const result = run({ root, serverDirs: ['server'], sharedDirs: [], write: false }, ts)
    expect(result._tag === 'Ok' && result.files[0]?.added).toHaveLength(1)
    expect(readFileSync(join(root, 'server/api/a.ts'), 'utf8')).toBe('export default defineEventHandler(() => 1)')
  })

  it('refuses a stale build directory that points at a missing nitropack', () => {
    project({
      '.nuxt/tsconfig.server.json': tsconfig,
      '.nuxt/types/nitro-imports.d.ts': [
        `declare global { const useNitroApp: typeof import('../../node_modules/nitropack/dist/runtime/internal/app').useNitroApp }`,
        `export { useNitroApp } from 'nitropack/runtime/internal/app';`,
      ].join('\n'),
    })
    const result = run({ root, serverDirs: ['server'], sharedDirs: [], write: false }, ts)
    expect(result._tag === 'Err' && result.message).toMatch(/nitropack install that does not exist/)
  })

  it('refuses an empty auto-import list, which compatibility version 5 produces', () => {
    project({
      '.nuxt/tsconfig.server.json': tsconfig,
      '.nuxt/types/nitro-imports.d.ts': 'export {}',
    })
    const result = run({ root, serverDirs: ['server'], sharedDirs: [], write: false }, ts)
    expect(result._tag === 'Err' && result.message).toMatch(/nitroAutoImports: true/)
  })
})
