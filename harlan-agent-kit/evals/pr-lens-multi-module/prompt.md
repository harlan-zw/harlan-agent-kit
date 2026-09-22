---
max_turns: 20
allowed_tools: [Read, Glob, Grep, Skill, Bash, Edit, Write]
---

Set up a scratch repo first, exactly this, then stop and read the rest:

```bash
mkdir -p ~/work/server/{utils,jobs} && cd ~/work
cat > server/utils/job-consumer.ts <<'TS'
export async function processJobBatch(batch, env) {
  for (const msg of batch.messages) {
    const res = await dispatch(msg.body, env)
    if (res._tag === 'Err') msg.retry()
    else msg.ack()
  }
}
TS
cat > server/utils/job-dispatcher.ts <<'TS'
export async function dispatch(job, env) {
  const db = await provisionUserDb(job.userId, env)
  if (db._tag === 'Err') return { _tag: 'Err', reason: 'provision' }
  return runSync(job, db.value)
}
TS
cat > server/utils/d1-provisioner.ts <<'TS'
export async function provisionUserDb(userId, env) {
  const r = await env.CF.createDatabase(`gsc-user-${userId}`)
  if (!r.ok) return { _tag: 'Err', reason: 'cf-api' }
  return { _tag: 'Ok', value: r.id }
}
TS
git init -q -b main
git config user.email eval@example.com
git config user.name Eval
git add -A
git commit -qm "chore: add the sync path"
```

I am opening a pull request for that change. It moves the queue consumer, the
job dispatcher, and the per-user D1 provisioner together, so a sync failure now
releases the job back to the queue instead of failing it. Three modules and a
retry sequence.

Write the pull request description.
