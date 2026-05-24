# Nuxt Module Structure

## Directory Layout

```
src/
├── module.ts              # Main module entry (build-time)
├── templates.ts           # Type augments via addTypeTemplate()
├── runtime/
│   ├── app/               # Client/SSR code (Vue context)
│   │   ├── composables/   # Auto-imported composables
│   │   │   └── useX.ts
│   │   ├── components/    # Auto-imported components
│   │   ├── plugins/       # Nuxt plugins
│   │   │   ├── init.ts
│   │   │   └── X.server.ts  # SSR-only plugin
│   │   └── utils/         # Client utilities
│   ├── server/            # Nitro server code
│   │   ├── composables/   # Server composables (auto-imported)
│   │   │   └── useX.ts
│   │   ├── plugins/       # Nitro plugins (startup hooks)
│   │   │   └── init.ts
│   │   ├── routes/        # API endpoints
│   │   │   ├── api.ts
│   │   │   └── __my-module__/  # Debug routes (prefixed)
│   │   │       └── debug.ts
│   │   ├── middleware/    # H3 middleware
│   │   └── utils/         # Server utilities
│   ├── shared/            # Isomorphic code (client + server)
│   │   ├── utils.ts
│   │   └── constants.ts
│   └── types.ts           # Runtime types (for nitro augments)
├── content.ts             # Content module integration (optional)
└── types.ts               # ModuleOptions + schema augments

playground/
├── nuxt.config.ts
├── app.vue
└── pages/
    └── index.vue

test/
├── unit/
│   └── *.test.ts
├── e2e/
│   └── *.test.ts
└── fixtures/
    ├── basic/
    │   ├── nuxt.config.ts
    │   └── app.vue
    └── i18n/              # Additional fixture variants
```

## Runtime Directory Rules

**`runtime/app/`** - Client & SSR code (Vue context)
- Has access to `useNuxtApp()`, `useRuntimeConfig()`, Vue reactivity
- Composables auto-imported via `addImports()`
- Plugins registered via `addPlugin()`
- Use `.server.ts` suffix for SSR-only files
- Use `.client.ts` suffix for client-only files

**`runtime/server/`** - Nitro server code
- Has access to H3, Nitro context, `useRuntimeConfig()`
- NO access to Vue, Nuxt app context
- Composables auto-imported via `addServerImportsDir()`
- Plugins registered via `addServerPlugin()` (run on Nitro startup)
- Routes registered via `addServerHandler()`
- Debug routes prefixed with `__module-name__/`

**`runtime/shared/`** - Isomorphic code
- Pure JS/TS utilities usable in both contexts
- NO framework-specific imports (no Vue, no H3)
- Constants, type guards, pure functions
- Import via alias in both app/ and server/

## Registration Patterns

| What | Function | Mode/Location |
|------|----------|---------------|
| App composable | `addImports()` | auto-imported in Vue |
| App plugin | `addPlugin()` | `mode: 'all'/'server'/'client'` |
| App component | `addComponent()` | auto-imported in Vue |
| Server composable | `addServerImportsDir()` | auto-imported in Nitro |
| Server plugin | `addServerPlugin()` | runs on Nitro startup |
| API route | `addServerHandler({ route })` | GET/POST endpoint |
| Middleware | `addServerHandler({ middleware: true })` | H3 middleware |
| Type augments | `addTypeTemplate()` | `nuxt`/`nitro`/`node`/`shared` |
