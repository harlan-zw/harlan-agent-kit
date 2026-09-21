# advocaat (fork)

Typed client for Jev, the TypeSafe AI System One model, routed through the
Cloudflare AI `/ai/run` endpoint.

Forked from [pithings/advocaat](https://github.com/pithings/advocaat) by
Pooya Parsa. The question builders and the `ask` tag API are his, unchanged.
The transport is replaced: this fork speaks only [Cloudflare](https://cloudflare.com), never
`api.typesafe.ai` or the Vercel AI Gateway.

## Why

Cloudflare serves Jev as a catalog model, `typesafe/jev`, behind its own
account token and Unified Billing. The request is the System One
`{ state, questions }` payload wrapped in a `{ model, input }` envelope. The
upstream client has no Cloudflare provider, so this fork carries one.

## Use

```ts
import { ask } from 'advocaat'

const { kind } = await ask(
  { title: 'Checkout is down', body: 'No one can pay.' },
  {
    kind: ask.choice`What kind of issue is this?`({
      bug: 'Something is broken',
      other: null,
    }),
  },
  { accountId: '...', apiToken: '...' },
)

console.log(kind.choice) // "bug" | "other"
```

Credentials come from `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` when
the options omit them. The token needs `Account > Workers AI > Read`. Set
`gatewayId` to route through a named AI Gateway instead of the account
default.

Requests retry on HTTP 429 and 529, honouring `retry-after`. Every other
failure throws `APIError`.
