# src/module.ts Template

```ts
import type { ModuleOptions } from './types'
import { addImports, addPlugin, addServerHandler, addServerImportsDir, addServerPlugin, createResolver, defineNuxtModule, hasNuxtModule } from '@nuxt/kit'

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'my-module',
    configKey: 'myModule',
  },
  defaults: {
    enabled: true,
  },
  async setup(config, nuxt) {
    const { resolve } = createResolver(import.meta.url)

    // Skip if disabled
    if (!config.enabled)
      return

    // Aliases for clean imports
    nuxt.options.alias['#my-module'] = resolve('./runtime')
    nuxt.options.nitro.alias ||= {}
    nuxt.options.nitro.alias['#my-module'] = resolve('./runtime')
    nuxt.options.nitro.alias['#my-module/server'] = resolve('./runtime/server')

    // App plugins
    addPlugin({
      src: resolve('./runtime/app/plugins/init'),
      mode: 'all', // or 'server' | 'client'
    })

    // App composables (auto-imported)
    addImports({
      name: 'useMyModule',
      from: resolve('./runtime/app/composables/useMyModule'),
    })

    // Server composables (auto-imported in Nitro)
    addServerImportsDir(resolve('./runtime/server/composables'))

    // Nitro plugin (runs on server startup)
    addServerPlugin(resolve('./runtime/server/plugins/init'))

    // API routes
    addServerHandler({
      route: '/api/my-module',
      handler: resolve('./runtime/server/routes/api'),
    })

    // Debug routes (dev only)
    if (nuxt.options.dev) {
      addServerHandler({
        route: '/__my-module__/debug',
        handler: resolve('./runtime/server/routes/__my-module__/debug'),
      })
    }

    // H3 middleware
    addServerHandler({
      middleware: true,
      handler: resolve('./runtime/server/middleware/context'),
    })

    // Conditional features based on other modules
    if (hasNuxtModule('@nuxt/content')) {
      addServerPlugin(resolve('./runtime/server/plugins/content'))
    }

    // Virtual modules (dynamic content at build time)
    nuxt.hooks.hook('nitro:config', (nitroConfig) => {
      nitroConfig.virtual ||= {}
      nitroConfig.virtual['#my-module/virtual'] = `export default ${JSON.stringify(config)}`
    })

    // Runtime config
    nuxt.options.runtimeConfig.public.myModule = defu(
      nuxt.options.runtimeConfig.public.myModule,
      { enabled: config.enabled }
    )

    // Type templates (see templates.ts pattern below)
    registerTypeTemplates({ nuxt, config })
  },
})
```

## Type Templates (src/templates.ts)

Separate file for type augmentations using `addTypeTemplate()`:

```ts
import type { Nuxt } from '@nuxt/schema'
import type { ModuleOptions } from './module'
import { addTypeTemplate } from '@nuxt/kit'
import { relative, resolve } from 'pathe'

interface TemplateContext {
  nuxt: Nuxt
  config: ModuleOptions
}

function getTypesPath(nuxt: Nuxt) {
  return relative(
    resolve(nuxt.options.rootDir, nuxt.options.buildDir, 'module'),
    resolve('runtime/types'),
  )
}

export function registerTypeTemplates(ctx: TemplateContext) {
  const { nuxt, config } = ctx

  // Nuxt-only: client/Vue type augments
  addTypeTemplate({
    filename: 'module/my-module.d.ts',
    getContents: () => `declare module '#my-module' {
  export interface MyModuleContext {
    config: typeof import('../../../src/types').ModuleOptions
  }
}
`,
  }, { nuxt: true })

  // Nitro-only: server virtual module types
  addTypeTemplate({
    filename: 'module/my-module-server.d.ts',
    getContents: (data) => {
      const typesPath = getTypesPath(data.nuxt!)
      return `declare module '#my-module/virtual' {
  const config: import('${typesPath}').ModuleOptions
  export default config
}
`
    },
  }, { nitro: true })

  // Nitro-only: nitropack augmentations (route rules, hooks)
  addTypeTemplate({
    filename: 'module/my-module-nitro.d.ts',
    getContents: (data) => {
      const typesPath = getTypesPath(data.nuxt!)
      const types = `interface NitroRouteRules {
    myModule?: false | import('${typesPath}').RouteOptions
  }
  interface NitroRouteConfig {
    myModule?: false | import('${typesPath}').RouteOptions
  }
  interface NitroRuntimeHooks {
    'my-module:context': (ctx: import('${typesPath}').ModuleContext) => void | Promise<void>
  }`
      return `import '${typesPath}'

declare module 'nitropack' {
${types}
}

declare module 'nitropack/types' {
${types}
}

export {}
`
    },
  }, { nitro: true })
}
```

### Type Template Context Options

| Option | Effect |
|--------|--------|
| `{ nuxt: true }` | Vue/Nuxt app context (default if no context passed) |
| `{ nitro: true }` | Nitro server build context |
| `{ node: true }` | Node.js env where nuxt.config.ts loads |
| `{ shared: true }` | Shared types across all environments |

Can combine: `{ nuxt: true, nitro: true }` for both contexts.

### Common Augmentations

```ts
// Runtime config augmentation (in src/types.ts)
declare module '@nuxt/schema' {
  interface PublicRuntimeConfig {
    myModule: ModuleOptions
  }
}

// App config augmentation
declare module 'nuxt/schema' {
  interface AppConfigInput {
    myModule?: ModuleOptions
  }
}
```

## Mock Pattern (when disabled)

```ts
// In module setup when disabled:
if (!config.enabled) {
  // Provide mock composables so imports don't break
  addImports({
    name: 'useMyModule',
    from: resolve('./runtime/app/composables/mock'),
  })

  // Mock server composables
  nuxt.hooks.hook('nitro:config', (nitroConfig) => {
    nitroConfig.imports ||= {}
    nitroConfig.imports.presets ||= []
    nitroConfig.imports.presets.push({
      from: resolve('./runtime/server/composables/mock'),
      imports: ['useMyServerComposable'],
    })
  })
}
```
