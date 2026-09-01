export default defineNuxtConfig({
  compatibilityDate: '2026-08-13',
  pages: { pattern: ['**/*.vue', '!**/_*.vue'] },
  css: ['~/assets/css/main.css'],
  devtools: { enabled: true },
  modules: ['@nuxt/ui', '@nuxt/fonts', '@nuxt/icon', '@vueuse/nuxt'],
  fonts: {
    families: [
      { name: 'Mona Sans', provider: 'google', weights: [400, 500, 600] },
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
      ],
    },
  },
  ui: {
    theme: {
      colors: ['primary', 'success', 'warning', 'error', 'neutral'],
    },
  },
  nitro: {
    prerender: {
      // `/kit` stays out on purpose. It is a dev page and nothing links to it.
      routes: ['/', '/history', '/stats', '/watching', '/flow'],
      ignore: ['/kit'],
    },
  },
})
