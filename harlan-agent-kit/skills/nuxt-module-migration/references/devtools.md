# Optional DevTools packages

Inspect the current host integration and UI distribution before proposing a split.
Lazy JavaScript execution does not reduce npm installation when the package remains a required dependency.
Optional peers can still auto-install. Measure the actual consumer graph.

## Host versions and native APIs

At the October 2026 audit, Nuxt 4.6.0 declares DevTools `^3.4.2`.
The Nuxt 5 `5x` nightly declares `^4.0.0-beta.3`.
The npm latest tag also resolves to v4 beta.3. Recheck these versions before implementation.
Installing DevTools Kit 4 does not upgrade a running DevTools 3 host.
Keep core modules independent of the beta host.

Sources: [Nuxt manifest](https://github.com/nuxt/nuxt/blob/v4.6.0/packages/nuxt/package.json),
[stable Kit](https://github.com/nuxt/devtools/blob/v3.4.2/packages/devtools-kit/src/index.ts),
[beta Kit](https://github.com/nuxt/devtools/blob/v4.0.0-beta.3/packages/devtools-kit/src/index.ts).

Choose the supported host contract before implementing optional loading:

| Host | Distribution and integration |
| --- | --- |
| DevTools 3, bundled with Nuxt 4.6 | Prebuilt locally installed UI; custom tab hook; namespaced RPC |
| DevTools 4 beta, deliberate optional upgrade | Native remote assets, docks, commands, RPC, tracked terminals |

For the stable path, a small `devtools:customTabs` hook avoids a runtime DevTools Kit import.
The tab's iframe factory runs during tab collection, rather than first open.
Use the iframe HTTP request as the expensive initialization boundary.
Capture host initialization early. Initialization hooks do not replay after late registration.
There is no generic server iframe-open callback in the inspected native dock types.
`devtools:ready` means the host connected, rather than the panel opened.

Stable tabs also support `view.type: 'launch'` with `actions: [{ label, pending, handle }]`.
The authenticated `customTabAction` server RPC invokes handlers and refreshes tabs around execution.
Use this native consent action instead of a handwritten GET installation endpoint.
Prove version checks, concurrent actions, and progress handling.
The exported `ModuleIframeTabLazyOptions.onLoad` is not connected to `ModuleCustomTab` or the inspected iframe component.
Do not treat that type as an implemented first-open callback.
Source: [stable launch actions](https://github.com/nuxt/devtools/blob/v3.4.2/packages/devtools/src/server-rpc/custom-tabs.ts).

DevTools 4 deprecates `addCustomTab`, `extendServerRpc`, and `startSubprocess`.
Its native entry is `onDevtoolsReady(fn, nuxt?)`, receiving `ViteDevToolsNodeContext`.

| Native API | Candidate replacement |
| --- | --- |
| `ctx.views.hostStatic(baseUrl, source)` | Custom static server and local UI build |
| `ctx.docks.register(entry)` | Custom tab registration |
| `ctx.rpc.register({ name, handler })` | New birpc host contracts |
| `ctx.rpc.broadcast({ method, args, event })` | Panel refresh events |
| `ctx.commands.register({ id, title, handler })` | Explicit setup actions |
| `ctx.terminals.startChildProcess(options, terminal)` | Custom installation subprocess tracking |

Use a launcher `command` for an external viewer. A function-valued `onLaunch` does not cross shared state.
Native `frameId` and `subTabs: { protocol: 'postmessage' }` support one SPA across separate docks.
Consider native JSON render docks for simple configuration viewers.
Verify these APIs in the exact published host before using them.

Sources: [v4 migration](https://devtools.nuxt.com/module/migration-v4),
[dock system](https://devtools.vite.dev/kit/dock-system.html).

## Native remote assets, v4 only

Nuxt DevTools 4 serves its own separate `@nuxt/devtools-assets` package this way.
`hostStatic` accepts a local directory or a `RemoteAssets` object.
The object accepts `package`, `version`, `path`, `provider`, `resolveFrom`, `fetch`, and `offline`.
The defaults include `path: 'dist'` and the jsDelivr provider.

Resolution uses installed assets, then the versioned cache, then streams and caches requested CDN files.
This downloads browser assets without changing the consumer's manifest or lockfile.
An asset package can have zero required dependencies when all browser imports are bundled.
Keep Vue, Nuxt UI, Tailwind, Shiki, and icons in its maintainer build dependencies.

Export the asset package's `./package.json`.
Resolve from an absolute consumer-root file URL for strict pnpm installations.
Different installed majors fail. Other versions within one major warn and remain usable.
Add a protocol handshake if core and UI versions evolve independently.

With `offline: true`, only installed files and existing cached files are available.
Offer exact local asset installation for complete offline use.
`hostStatic` does not add Nuxt's app base URL. Preserve the trailing slash and portable asset URLs.
It also supports build-time copying, so use an explicit development guard.

Sources: [DevTools asset setup](https://github.com/nuxt/devtools/blob/v4.0.0-beta.3/packages/devtools/src/module-main.ts),
[asset contract](https://github.com/devframes/devframe/blob/v1.2.0/packages/devframe/src/types/remote-assets.ts),
[asset implementation](https://github.com/devframes/devframe/blob/v1.2.0/packages/devframe/src/utils/remote-assets.ts).

`createInstallLauncher` from `@vitejs/devtools-kit/node` installs missing development packages after a command.
It checks presence, rather than compatible versions, and asks for a restart after success.
Its workspace-root selection can differ from a nested Nuxt app root.
Prove concurrent-request handling before adopting it. Do not promise seamless hot activation.
The published DevTools beta.3 peer requires Vite `^8.1.5`.
Prefer the published manifest over a less restrictive documentation example.

Sources: [launcher implementation](https://github.com/vitejs/devtools/blob/v0.7.6/packages/kit/src/node/create-install-launcher.ts),
[DevTools manifest](https://github.com/nuxt/devtools/blob/v4.0.0-beta.3/packages/devtools/package.json).

## Recommended boundary

Keep a small registration surface in each core module.
Put panel source or compiled assets in a separately installed package.
Move DevTools host integration and its RPC, static serving, and installation dependencies out of shared core runtime packages.
Choose one aggregate UI package or several panel packages from actual independent-use and dependency data.
Do not create ten copies of the UI stack just to separate ten panels.

Prefer a prebuilt UI when the user does not need to compile it locally.
Keep its UI build dependencies in development dependencies when only assets ship.
An npm package of source layers still requires its build toolchain at user install time.
Compare cold-open latency, tarball size, installed count, and maintainability before choosing.

Preserve the current opt-in boundary if first-open installation already exists.
Show the exact package and compatible version before installing into the consumer's development dependencies.
Support a manual install command for non-interactive environments.
Loading an already installed package can be automatic.
The user's installation choice authorizes the package-manager operation in that app.
Never silently change a consumer's manifest or lockfile just because a panel route was requested.

Nuxt 4.6 provides `ensureDependencyInstalled` and `getAddDependencyCommand`.
Inspect their implementation before substituting them for custom installation.
The helper installs development dependencies internally. Its options do not expose that selection.
Its StackBlitz behavior can install without a prompt, depending on options.
Use `getAddDependencyCommand(..., { dev: true })` where the requirement is an explicit developer command.

Source: [versioned Kit dependency helper](https://github.com/nuxt/nuxt/blob/v4.6.0/packages/kit/src/dependency.ts).

Use Kit `useTerminal()` for terminal prompts, tasks, notifications, and compatible output.
Its `interactive` field reports host availability.
Source: [terminal implementation](https://github.com/nuxt/nuxt/blob/v4.6.0/packages/kit/src/terminal.ts).

## Loading and lifecycle

Register a lightweight tab without importing the full host integration or UI package eagerly.
On first open, resolve compatible installed packages and load their integration.
If installation is required, show the install action first.
Use one in-flight operation for concurrent tab opens.
Make retry, package mismatch, missing package, and offline failure visible.

Keep inspection endpoints and RPC dev-only.
Use an explicit mutation request for installation, with same-origin checks and session authorization.
A generic GET request must not start package installation.
Keep package names and versions server-controlled.
Handle non-root `app.baseURL`, disabled DevTools, custom ports, restarts, and package-manager detection.
Invalidate UI caches using core, UI, and protocol versions, plus enabled panels.
Stop task-owned subprocesses when the dev server closes.

Version the host-to-panel contract.
Resolve from the user's project rather than a maintainer's workspace or hoisted dependency.
Test strict pnpm resolution from packed artifacts.
If a separate package is unavailable, the core module must still start and build.

## Required measurements and tests

| Scenario | Expected result |
| --- | --- |
| Core module installed, UI absent | Core functionality works; UI packages stay outside the graph |
| Production build | No panel assets, install endpoint, RPC, or UI runtime dependencies in output |
| Dev server, panel unopened | No UI build or install operation |
| First open, UI absent | Stable host: explicit install; v4: versioned remote assets or explicit local install |
| Already installed UI | Panel loads without reinstalling |
| Concurrent opens | One install or build operation |
| Offline or incompatible UI | Clear failure and recovery; core remains functional |
| Multiple modules | Shared UI dependencies install once; correct panels appear |

Report package counts and byte sizes for core-only, one panel, and the complete collection.
Never equate an extracted subpath with a separate installed package.
Run DevTools checks outside fixtures whose test flags automatically disable the host.
Prove optional v4 host installation in exact Nuxt 4.6 and actual Nuxt 5 consumers.
Before publication, a local registry fixture can serve the genuine packed host to the unchanged native installer.
Preserve trust policy and use official registry metadata for other packages. Never substitute an installer stub.
Report local registry installation separately from public npm installation after publication.
DevTools supports the Vite builder in the inspected versions. Preserve core behavior for other builders.
