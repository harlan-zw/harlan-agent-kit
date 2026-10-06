# Optional DevTools packages

Inspect the current host integration and UI distribution before proposing a split.
Lazy JavaScript execution does not reduce npm installation when the package remains a required dependency.
Optional peers can still auto-install. Measure the actual consumer graph.

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
| First open, UI absent | Explicit install action or manual command |
| Already installed UI | Panel loads without reinstalling |
| Concurrent opens | One install or build operation |
| Offline or incompatible UI | Clear failure and recovery; core remains functional |
| Multiple modules | Shared UI dependencies install once; correct panels appear |

Report package counts and byte sizes for core-only, one panel, and the complete collection.
Never equate an extracted subpath with a separate installed package.
