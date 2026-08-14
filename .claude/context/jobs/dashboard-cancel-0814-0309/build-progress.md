# Dashboard cancellation progress

## Dashboard

- [x] C1 and C2: active and queued tasks expose Cancel controls.
- [x] C3 and C4: requests disable matching controls and show local failures.
- [x] C5: successful cancellation reloads state and live updates continue.
- [x] C6 and C7: cancellation survives polls and closed pull requests use it.
- [x] C8 through C10: mobile, dark tokens, labels, and focus styles verified.
- [x] Passed 116 tests, lint, typecheck, package build, service restart, and browser checks.

## Service fixes

- [x] Closed PR #235 stopped its running Codex process.
- [x] Conflict, review, status, and publication work share durable cancellation.
- [x] Intentional restarts no longer exhaust task retries.
- [x] Live update timers stop before SQLite closes.
