# Dev Server: Start and Verify

## Start on a random port

Use the runtime `REVIEW_PORT` allocation. Try three random ports against `ss -tln`. If none is free, repeat the allocation.

Detect project type and start the matching command in the background:

1. **Nuxt module monorepo** (has `playground/`): `pnpm dev:prepare && pnpm --filter '*-playground' dev --port $REVIEW_PORT`
2. **Nuxt app** (has `nuxt.config.ts`): `pnpm dev --port $REVIEW_PORT`
3. **Vite app** (has `vite.config.ts`): `pnpm dev --port $REVIEW_PORT`

```bash
DEV_LOG="{JOB_DIR}/review-dev-server.log"
mkdir -p "$(dirname "$DEV_LOG")"
( <detected-command> ) > "$DEV_LOG" 2>&1 &
DEV_PID=$!
trap "kill $DEV_PID 2>/dev/null" EXIT
echo "Started dev server PID=$DEV_PID on port $REVIEW_PORT, log: $DEV_LOG"
```

The trap guarantees teardown; an explicit `kill $DEV_PID` at the end is still good hygiene in long-lived shells.

## Verify health

An open port is not health. Confirm it serves the right project and inspect build output.

```bash
timeout 90 bash -c "until curl -sf http://localhost:$REVIEW_PORT/ > /dev/null 2>&1; do sleep 2; done" \
  || { echo "Server failed to start within timeout"; tail -100 "$DEV_LOG"; exit 1; }

curl -s "http://localhost:$REVIEW_PORT/" | head -50
curl -s "http://localhost:$REVIEW_PORT/" | grep -c '<div id="__nuxt"'
curl -s "http://localhost:$REVIEW_PORT/" | grep -c 'nuxt-error'

# Nuxt/Vite log markers, targeted to avoid benign substring matches
grep -nE '^\s*(\[error\]|\[warn\]|ERROR|WARN|✖|✘|Hydration |Cannot find|Failed to (resolve|compile)|\[Vue warn\]|\[nuxt\] error)' "$DEV_LOG" \
  || echo "dev server log clean"
```

Look for HTTP errors, build errors in `$DEV_LOG`, Vue/SSR warnings, blank responses, and hydration errors in the HTML.

Any grep match is a finding. Hydration mismatches, missing components, `[Vue warn]`, and `[error]` lines are hard rejects; deprecation warnings are RUBRIC items.

Confirm the response HTML contains a project-specific string (app name from `nuxt.config.ts`, or a component name from the handoff).

If the server fails, capture `$DEV_LOG` output in the report and tell the user. You cannot fix code.
