export default defineNuxtConfig({
  compatibilityDate: '2026-08-13',
  future: { compatibilityVersion: 5 },
  app: { head: { viewport: 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content' } },
  pages: { pattern: ['**/*.vue', '!**/_*.vue'] },
  css: ['~/assets/css/main.css'],
  colorMode: { preference: 'dark', fallback: 'dark' },
  devtools: { enabled: true },
  modules: ['@nuxt/ui', '@nuxt/fonts', '@nuxt/icon', '@vueuse/nuxt', 'nuxt-skew-protection'],
  skewProtection: {
    updateStrategy: 'polling',
    reloadStrategy: 'prompt',
  },
  fonts: {
    families: [
      { name: 'Hubot Sans', provider: 'google', weights: [400, 500, 600] },
      { name: 'JetBrains Mono', provider: 'google', weights: [400, 500] },
    ],
  },
  icon: {
    serverBundle: 'local',
    clientBundle: {
      scan: true,
      // WorkChip resolves these names from a `.ts` map at runtime. The scanner only reads templates.
      icons: [
        'octicon:code-review-16',
        'octicon:checklist-16',
        'octicon:tools-16',
        'octicon:git-merge-16',
        'octicon:pulse-16',
        'octicon:inbox-16',
        'octicon:code-16',
        'octicon:telescope-16',
        'octicon:workflow-16',
        // Shell navigation reads these from utils/navigation.ts.
        'octicon:terminal-16',
        'octicon:columns-16',
        'octicon:clock-16',
        'octicon:history-16',
        'octicon:broadcast-16',
        'octicon:calendar-16',
        'octicon:graph-16',
        'octicon:three-bars-16',
        'octicon:sidebar-collapse-16',
        'octicon:sidebar-expand-16',
      ],
    },
  },
  ui: {
    theme: {
      colors: ['primary', 'success', 'warning', 'error', 'neutral'],
    },
  },
  nitro: {
    // es2019 (the default) warns on BigInt literals bundled into the server chunks.
    esbuild: {
      options: {
        target: 'esnext',
      },
    },
    prerender: {
      // `/kit` stays out on purpose. It is a dev page and nothing links to it.
      routes: ['/', '/timeline', '/sessions', '/history', '/stats', '/watching', '/routines', '/flow'],
      ignore: ['/kit'],
    },
  },
  vite: {
    build: {
      // The terminal diff feature lazily loads Shiki, and each language
      // grammar plus the inlined oniguruma wasm ships as a single module the
      // bundler cannot split; the largest is about 780 kB. The limit sits
      // above them, as notes-viewer does for mermaid's unsplittable elk
      // bundle.
      chunkSizeWarningLimit: 1600,
    },
  },
})
