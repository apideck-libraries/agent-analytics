# Testing the payment path

> **The payment surface is experimental.** These protocols are weeks old, their
> specs are moving, and no agent in our own production traffic has yet presented
> a payment credential. Test it, don't depend on it. Metering is the part that
> works today and needs nobody's cooperation.

Four levels, cheapest first. Do them in order — most bugs are caught at level 1,
and level 4 needs real credentials.

---

## Level 1 — No network, no keys (30 seconds)

Everything except settlement is pure functions over a `Request`. You can drive
the whole decision path in a script.

```bash
npm i @apideck/agent-analytics
```

```js
// pay.mjs
import { paymentGate, entitlementGateway, memoryEntitlementStore } from '@apideck/agent-analytics'
import { combinedVerifier } from '@apideck/agent-analytics/verify'

const store = memoryEntitlementStore({ lic_abc: { id: 'lic_abc', remaining: 3 } })

const gateway = entitlementGateway({
  store,
  offer: { units: 1_000_000, unit: 'pages', validForSeconds: 2_592_000, price: '$400' },
  challenges: [{ protocol: 'mpp', id: 'c1', realm: 'example.com', method: 'tempo', intent: 'charge' }],
  exposeRemaining: true
})

const req = (ua, headers = {}) =>
  new Request('https://example.com/docs/intro', { headers: { 'user-agent': ua, ...headers } })

for (const [ua, headers, label] of [
  ['Mozilla/5.0 (compatible; GPTBot/1.1)', {}, 'training, no licence'],
  ['Mozilla/5.0 (compatible; GPTBot/1.1)', { Authorization: 'Payment lic_abc' }, 'training, licensed'],
  ['Mozilla/5.0 (compatible; ChatGPT-User/1.0)', {}, 'retrieval'],
  ['Mozilla/5.0 (compatible; Googlebot/2.1)', {}, 'search']
]) {
  const gate = await paymentGate(req(ua, headers), {
    gateway,
    onTraining: 'charge',
    verify: combinedVerifier()
  })
  const served = gate.decorate(new Response('the page'))
  console.log(
    (gate.response ? gate.response.status : 200).toString().padEnd(5),
    gate.decision.intent.padEnd(10),
    (served.headers.get('x-quota-remaining') ?? '').padEnd(4),
    label
  )
}
```

```
$ node pay.mjs
402   training        training, no licence
200   training   2    training, licensed
200   retrieval       retrieval
200   search          search
```

**What this proves:** intent classification, the 402/200 split, quota
decrementing, and that retrieval and search are never gated. **What it does not
prove:** that any real agent understands the challenge.

### Inspect the challenge

```js
import { paymentRequired } from '@apideck/agent-analytics'

const res = paymentRequired({
  challenges: [
    { protocol: 'x402', accepts: [{ scheme: 'exact', network: 'base',
      maxAmountRequired: '1000', resource: 'https://example.com/docs',
      payTo: '0xabc', asset: '0xusdc' }] },
    { protocol: 'mpp', id: 'c1', realm: 'example.com', method: 'tempo', intent: 'charge' }
  ]
})

console.log(res.status)                                   // 402
console.log(res.headers.get('WWW-Authenticate'))          // MPP
console.log(atob(res.headers.get('PAYMENT-REQUIRED')))    // x402, decoded
console.log(res.headers.get('content-signal'))            // ai-train=paid
```

Both protocols on one response is intentional — they use non-colliding headers,
so the agent takes whichever it speaks.

---

## Level 2 — Against a running app, with curl (5 minutes)

Wire the gate into middleware, then drive it with user agents.

```ts
// middleware.ts
import { NextResponse, type NextRequest } from 'next/server'
import { paymentGate, entitlementGateway } from '@apideck/agent-analytics'
import { combinedVerifier } from '@apideck/agent-analytics/verify'

const gateway = entitlementGateway({
  store: {
    // Swap for KV/Redis in production. Quota state is money.
    lookup: (cred) => (cred === process.env.TEST_LICENCE ? { id: 'test', remaining: 5 } : null)
  },
  offer: { units: 1_000_000, unit: 'pages', validForSeconds: 2_592_000, price: '$400' },
  challenges: [{ protocol: 'mpp', id: 'test', realm: 'example.com', method: 'tempo' }]
})

export async function middleware(req: NextRequest) {
  const gate = await paymentGate(req, {
    gateway,
    onTraining: 'charge',
    verify: combinedVerifier(),
    meter: { record: (e) => console.log('[meter]', e.decision.intent, e.path) }
  })
  if (gate.response) return gate.response
  return gate.decorate(NextResponse.next())
}
```

```bash
# A training crawler with no licence — expect 402 and an offer
curl -si -A 'Mozilla/5.0 (compatible; GPTBot/1.1)' localhost:3000/docs/intro \
  | grep -Ei 'HTTP/|www-authenticate|x-bulk-offer|content-signal'

# The same crawler holding a licence — expect 200
curl -si -A 'Mozilla/5.0 (compatible; GPTBot/1.1)' \
  -H "Authorization: Payment $TEST_LICENCE" localhost:3000/docs/intro | head -1

# Retrieval must never be charged
curl -si -A 'Mozilla/5.0 (compatible; ChatGPT-User/1.0)' localhost:3000/docs/intro | head -1

# A browser must be untouched
curl -si localhost:3000/docs/intro \
  -H 'accept-language: en-GB' -H 'sec-fetch-mode: navigate' \
  -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36' | head -1
```

**Checklist**

- [ ] `402` for training without a credential, carrying `x-bulk-offer`
- [ ] `200` for training with a valid credential
- [ ] `200` for `ChatGPT-User`, `Claude-User`, `Googlebot` — always
- [ ] `200` for a real browser, no challenge, no quota consumed
- [ ] `403` for a spoofed identity (see below)
- [ ] `[meter]` logged for training when `onTraining` is left at `meter`

### Testing the spoofed path

A verification failure needs a UA claiming a vendor from an IP outside its
published range. Locally, forge the forwarded header:

```bash
curl -si -A 'Mozilla/5.0 (compatible; ClaudeBot/1.0)' \
  -H 'x-forwarded-for: 45.55.50.205' localhost:3000/docs | head -1   # → 403

curl -si -A 'Mozilla/5.0 (compatible; ClaudeBot/1.0)' \
  -H 'x-forwarded-for: 34.162.230.222' localhost:3000/docs | head -1  # → 402
```

> On a real deployment behind Vercel or Cloudflare the edge overwrites
> `x-forwarded-for`, so a client cannot forge it. Locally there is no edge, which
> is exactly why this works — and why **you must confirm your production edge
> controls that header before enforcing on the verdict.**

---

## Level 3 — Web Bot Auth signatures (15 minutes)

Verification of signed requests needs a real Ed25519 keypair and a key
directory. The test suite already does this end to end; reuse the approach.

```js
// sign.mjs — a minimal agent that signs like a real one
const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey)

// Serve this at https://<signer>/.well-known/http-message-signatures-directory
console.log(JSON.stringify({ keys: [jwk] }))
```

Then build the signature base over `("@authority" "@path" "signature-agent")`
with `tag="web-bot-auth"`, sign it, and send `Signature-Agent`,
`Signature-Input` and `Signature`. `test/webbotauth.test.ts` has a working
signer — copy `makeSigner()` from it rather than reimplementing RFC 9421.

**Expect:** `bot_verification: 'verified'` and, critically, that a signature
replayed onto a **different path** fails — `@path` is covered.

---

## Level 4 — Real settlement

Neither rail is ours. Pick one.

### Stripe MPP

Stripe's SDK generates challenges and settles; wrap it rather than
reimplementing.

```ts
import { mppxGateway } from '@apideck/agent-analytics'

const mppx = Mppx.create({ methods: [...], secretKey })
const handler = Mppx.compose(
  mppx.tempo.charge({ amount: '0.01', recipient }),
  mppx.stripe.charge({ amount: '0.50', currency: 'usd' })
)

const gate = await paymentGate(req, { gateway: mppxGateway(handler), onTraining: 'charge' })
```

Requires the `2026-03-25.preview` API version. Test in Stripe test mode first;
crypto deposits are testable on Tempo testnet (`testnet: true`).

### x402

```ts
x402Gateway({
  challenges: [{ protocol: 'x402', accepts: [...] }],
  settle: async (payload, req) => {
    const ok = await fetch('https://facilitator.example/verify', {
      method: 'POST',
      body: JSON.stringify({ payload, resource: req.url })
    }).then((r) => r.ok)
    return ok
  }
})
```

Coinbase runs a hosted facilitator; Base and Solana testnets are the cheap path.

**Do not skip:** confirm your facilitator rejects a replayed payload. `settle`
returning `true` for a payload already spent is a double-spend, and the library
cannot detect it — presence of a header is never proof.

---

## What none of this tests

Be clear-eyed about the gap between a green checklist and a working business.

- **No real crawler retries a 402 today.** Every level above uses a client you
  wrote. In the wild, GPTBot gets the 402, logs an error, and leaves. Charging
  per request is functionally blocking until that changes.
- **Quota under concurrency.** `memoryEntitlementStore` is single-instance. At
  the edge, two regions serving the same licence simultaneously will both read
  the same `remaining`. If overselling matters, your store needs atomic
  decrements — the library does not provide them.
- **Price.** No public market rate exists for a training crawl of one page.
  Nothing here discovers it.

If you only do one thing: run **level 1**, then turn on metering in production
and leave the charging alone until you have a month of numbers.
