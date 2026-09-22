#!/usr/bin/env bash
set -e
mkdir -p server/utils
cat > server/utils/d1-http.ts <<'TS'
export async function d1Query(sql: string, params: unknown[], env: Env) {
  const res = await fetch(env.D1_URL, {
    method: 'POST',
    body: JSON.stringify({ sql, params }),
  })
  if (!res.ok)
    throw new Error(`D1 recieved a non-ok response: ${res.status}`)
  return await res.json()
}
TS
git init -q -b main
git config user.email eval@example.com
git config user.name Eval
git add -A
git commit -qm "chore: add the d1 http client"
sed 's/recieved/received/' server/utils/d1-http.ts > server/utils/d1-http.ts.tmp
mv server/utils/d1-http.ts.tmp server/utils/d1-http.ts
