# Verification

Prove the migration with evidence. Never with how the diff reads.

## Baseline

Run the repository's own scripts on the base branch before you change anything: install, lint, typecheck, test, build.
Record each failure. Then a failure that already existed is never attributed to the upgrade.
Redirect long output to a log file. A pipe into `tail` hides the exit code.

## Gates

Run all of them after the migration. Each must pass, or carry a written reason in the pull request.

| Gate | Command | Pass |
| --- | --- | --- |
| Server imports | `node --experimental-strip-types <skill>/scripts/explicit-server-imports.ts --root .` | `Would change 0 of N files`, exit 0 |
| Lint | the repository's lint script | exit 0 |
| Typecheck | `nuxt typecheck`, or the repository's script | exit 0 |
| Tests | the repository's test script | exit 0, or the same failures as the baseline |
| Build | the repository's build script | exit 0 and no new `NUXT_B` or `NUXT_E` warnings |

Read the build log for diagnostic codes. `NUXT_B5023` means a config file needs `jiti`. Fix it. See [compatibility version 5](compat-v5.md#nuxt-5-preparation-on-46).

## Runtime Smoke

A passing build does not prove server routes work. Request them.

1. Build for a local server. For a Cloudflare site, use the repository's preview command, such as `wrangler dev` or `cf dev`. If bindings block a local preview, build with `NITRO_PRESET=node-server` and test the routes that need no binding.
2. Start the server on a free port: `PORT=<port> node .output/server/index.mjs > run.log 2>&1 &`.
3. Request one route of each kind with `curl -s -o /dev/null -w '%{http_code} %{content_type}'`:
   - the home page and one page per layout
   - one route under `server/api/`, one under `server/routes/`, and one path that a `server/middleware/` file handles
   - a route that reads runtime config, storage, or a cached handler
   - an unknown path, which must return 404
4. Search the server log: `rg -n 'is not defined|ReferenceError|NUXT_E' run.log`. Expect no hits.
5. Stop the server.

On 2026-10-06 the trial on a copy of harlanzw.com returned 200 for `/`, `/feed.xml`, `/feed.json`, `/api/projects`, and `/experimental`, 400 for an invalid tweet id, and 404 for an unknown path.

## Browser Pass

Load the `browser` Skill. Run `dev-browser --headless` against the preview.

Open these pages and check the console for errors:

- every page that uses a component flagged by the Options API detection
- every page with a `.client.vue` component, for layout shift where a placeholder reserved space before
- the error page, through an unknown path
- one page per layout, when layout props or `appLayout` changed

Take one screenshot per changed area. Keep screenshots in the session scratchpad.

## Pull Request

Use the `pr` Skill. Commit subject: `chore(deps): upgrade nuxt to 4.6 with compatibility version 5`, or `feat:` when Tier 2 features ship.
The body names:

- the Nuxt version before and after, and the Node floor
- the server import codemod counts, and every unmapped name with its follow-up
- each compatibility version 5 default that needed code, and each opt-out kept with its reason
- the Tier 1 and Tier 2 changes, grouped by minor
- the Tier 3 follow-ups, one line each
- the gate table and the runtime smoke output

## Report

End the session with this table. Fill in measured results only.

| Check | Result |
| --- | --- |
| Nuxt | `4.x.y` to `4.6.z`, compatibility version 5 |
| Server imports | N files changed, 0 left, M unmapped |
| Lint, typecheck, tests, build | pass or fail each |
| Runtime smoke | routes and status codes |
| Browser pass | pages checked, console errors |
| Opt-outs kept | key: reason |
| Follow-ups | Tier 3 items |
