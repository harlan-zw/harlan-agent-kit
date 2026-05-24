# Site Directory Structure (Nuxt 4)

```
app/                    # Nuxt 4 app directory
  app.vue               # Root component
  app.config.ts         # App-level config (UI theme, etc.)
  pages/                # File-based routing
  layouts/              # Page layouts
  components/           # Vue components
  composables/          # Composition API hooks
  utils/                # Client utilities
  css/                  # Global styles (Tailwind)
  assets/               # Static assets (icons, images)
  error.vue             # Error page
server/                 # Nitro server
  api/                  # API routes
  routes/               # Server routes
  utils/                # Server utilities
  database/             # DB schemas/migrations (if applicable)
  mcp-handlers/         # MCP protocol handlers (if applicable)
layers/                 # Nuxt layers (optional, for code organization)
content/                # Markdown content (if using @nuxt/content)
shared/                 # Shared utilities (app + server)
public/                 # Static public files
nuxt.config.ts          # Main Nuxt config
content.config.ts       # Content collection config (if using @nuxt/content)
tsconfig.json           # Extends .nuxt/tsconfig.json
eslint.config.js        # @antfu/eslint-config + harlanzw
.editorconfig           # 2-space, LF, UTF-8
.npmrc                  # shamefully-hoist=true
```

## Key conventions

- **Nuxt 4 `app/` dir**: All frontend code lives under `app/`, not root-level `pages/`, `components/`, etc.
- **`server/`**: Nitro server code stays at root level (not inside `app/`)
- **`layers/`**: Use for logical grouping (e.g. `layers/admin/`, `layers/tools/`) when the app gets large
- **`shared/`**: Code importable from both app and server contexts — must be pure JS (no Vue, no H3)
- **`content/`**: Local markdown when using `@nuxt/content` — can also source from GitHub repos
