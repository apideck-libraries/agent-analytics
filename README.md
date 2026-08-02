<div align="center">

# agent-analytics

### See the agents your JavaScript can't.

**Drop-in Next.js / Vercel middleware that tracks ClaudeBot, GPTBot, Perplexity, and 20+ AI crawlers in PostHog — or any analytics backend you already pay for.**

[![npm version](https://img.shields.io/npm/v/@apideck/agent-analytics.svg?style=flat-square&color=2563eb)](https://www.npmjs.com/package/@apideck/agent-analytics)
[![npm downloads](https://img.shields.io/npm/dm/@apideck/agent-analytics.svg?style=flat-square&color=2563eb)](https://www.npmjs.com/package/@apideck/agent-analytics)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@apideck/agent-analytics?style=flat-square&color=2563eb&label=gzipped)](https://bundlephobia.com/package/@apideck/agent-analytics)
[![CI](https://img.shields.io/github/actions/workflow/status/apideck-libraries/agent-analytics/ci.yml?style=flat-square&label=ci)](https://github.com/apideck-libraries/agent-analytics/actions)
[![license](https://img.shields.io/npm/l/@apideck/agent-analytics?style=flat-square&color=2563eb)](./LICENSE)
[![typescript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square)](./tsconfig.json)

[**Install**](#install) · [**Quick start**](#quick-start-60-seconds-to-your-first-event) · [**How it works**](#how-it-works) · [**Adapters**](#built-in-adapters) · [**Markdown mirror**](#advanced-markdown-mirror-for-docs-sites) · [**FAQ**](#faq)

</div>

---

## The problem

Client-side analytics libraries run in the browser. AI crawlers don't. That means **every time ClaudeBot, GPTBot, or Perplexity fetches a page on your site, your dashboard stays empty.**

You can't see:

- Which AI agents are reading your docs, marketing pages, or blog
- Which pages they actually fetch (vs. which you *think* they should)
- Which agent-driven referrals convert
- How much of your "traffic" is actually LLM training pipelines

Server logs have the data, but turning them into analytics is a pipeline project. This library is the one-line version.

## What you get

```ts
import { trackVisit, posthogAnalytics } from '@apideck/agent-analytics'

const analytics = posthogAnalytics({ apiKey: process.env.POSTHOG_KEY! })

export function middleware(req: NextRequest) {
  void trackVisit(req, { analytics })   // ← that's the whole thing
  return NextResponse.next()
}
```

One line of middleware. Fire-and-forget. Zero impact on your response latency. Events in PostHog within seconds.

<details>
<summary><b>What shows up in your analytics</b> (click to expand)</summary>

```jsonc
{
  "event": "doc_view",
  "distinct_id": "anon_7f3a1b2c",          // hashed ip:ua, no person profile
  "timestamp": "2026-04-19T08:30:00.000Z",
  "properties": {
    "$process_person_profile": false,       // PostHog: don't create a person
    "$current_url": "https://example.com/docs/intro",
    "path": "/docs/intro",
    "method": "GET",
    "user_agent": "ClaudeBot/1.0 (+https://claude.ai/bot)",
    "is_ai_bot": true,                      // strict: matches a branded AI crawler
    "bot_name": "Claude",                   // 'Claude' | 'ChatGPT' | ... | 'curl' | 'axios' | 'Electron' | 'Browser' | 'Other'
    "ua_category": "declared-crawler",      // 'declared-crawler' | 'coding-agent-hint' | 'browser' | 'other'
    "coding_agent_hint": false,             // loose: HTTP-library / automation UA (curl, axios, got, colly, Electron, ...)
    "referer": "https://claude.ai/",
    "source": "page-view"                   // whatever label you passed
  }
}
```

Now you can build:
- **AI-vs-human traffic ratio** over time
- **Breakdown by agent** (Claude vs ChatGPT vs Perplexity vs Google-Extended)
- **Top pages for agents** (what do they actually read?)
- **Conversion funnels** from agent referral → human visit → sign-up
- **Anomaly detection** when a new bot starts hammering your site

</details>

---

## Charging for training crawls (experimental)

> **⚠️ Experimental.** The payment surface — `paymentRequired`, `paymentGate`,
> `x402Gateway`, `mppxGateway` — may change without a major version bump. The
> protocols are weeks old and still moving: x402 and MPP are both live but their
> specs are unstable, MPP had not publicly pinned a settlement-confirmation
> header at the time of writing, and no agent in our own production traffic has
> yet presented a payment credential. Detection, verification and policy are
> stable; this is not. Do not put it on a revenue-critical path yet.

### Meter first. Charge later, if at all.

Per-request 402 is what x402 and MPP define, and it is the wrong shape for a
training sweep. On one production site that is ~199,000 training requests a
month: three times the traffic once you add pay-and-retry, 199,000 settlements
whose per-transaction cost exceeds any sane per-page price, and — decisively —
**no crawler in the wild retries a 402**. Charging per request is blocking with
extra steps.

So start by counting:

```ts
import { paymentGate } from '@apideck/agent-analytics/payments'
import { combinedVerifier } from '@apideck/agent-analytics/verify'

const gate = await paymentGate(req, {
  verify: combinedVerifier(),
  meter: { record: (e) => warehouse.insert(e) } // training only
})
if (gate.response) return gate.response
return gate.decorate(await serve(req))
```

`meter` fires only for training traffic. Retrieval and search are served free
and never counted, because charging the channel that sends you readers is the
one outcome this design exists to prevent.

### Then sell a licence, not a page

When you know the number, switch to an entitlement: one 402 advertising a bulk
offer, one settlement, a reusable credential.

```ts
import { entitlementGateway } from '@apideck/agent-analytics/payments'

const gate = await paymentGate(req, {
  onTraining: 'charge',
  gateway: entitlementGateway({
    store: myKV,                    // lookup + consume; quota state is yours
    offer: { units: 1_000_000, unit: 'pages', validForSeconds: 2_592_000, price: '$400' },
    challenges: [{ protocol: 'mpp', id, realm: 'example.com', method: 'tempo' }]
  })
})
```

```
402  once, advertising the licence
200  every request after, quota −1
402  again when it runs out
```

Unknown, expired and exhausted credentials all return the same challenge —
distinguishing them would turn the endpoint into an oracle for probing quota.

MPP's reusable `Authorization: Payment` credential suits this better than
x402's per-resource signature, which proves payment for a single URL.

Measured against real traffic shapes:

```
402    training   charge  GPTBot
serve  retrieval  allow   ChatGPT-User
403    training   block   ClaudeBot from an unpublished IP
402    training   charge  ClaudeBot from a real Anthropic IP
serve  search     allow   Googlebot, PerplexityBot
serve  preview    allow   Slackbot, facebookexternalhit
```

`preview` is its own intent rather than a flavour of `retrieval`: a link unfurl
is a person pasting your URL into a conversation, not an assistant answering a
question. Folding the two together would inflate the retrieval number, which is
the one figure the split exists to measure.

Settlement is never ours. `mppxGateway` wraps Stripe's MPP SDK; `x402Gateway`
calls a facilitator you supply. The library emits challenges and reads
credentials — holding money would drag PCI scope into edge middleware.

## Cryptographic verification (Web Bot Auth)

Published IP ranges were always the weak form of identity. [Web Bot
Auth](https://blog.cloudflare.com/web-bot-auth/) is the strong one: an RFC 9421
HTTP Message Signatures profile where an agent signs each request with Ed25519
and publishes its keys at a well-known directory. Backed by Cloudflare, Amazon,
Akamai and OpenAI, with an IETF working group chartered in 2026.

```ts
import { combinedVerifier } from '@apideck/agent-analytics/verify'

void trackVisit(req, { analytics, verify: combinedVerifier() })
```

`combinedVerifier` prefers the signature and falls back to ranges:

| | published IP ranges | Web Bot Auth |
| --- | --- | --- |
| Coverage | 4 vendors | any agent that signs |
| Freshness | rots; needs weekly refresh | none needed |
| False `spoofed` | stale list accuses real crawlers | impossible |
| Agents on a user's machine | unverifiable | signable |

A present-but-invalid signature is decisive: it returns `spoofed` even if the
client IP happens to sit in a published range, so a forged signature cannot be
laundered by the weaker check. Unsigned traffic is `unverifiable`, never
`spoofed` — most agents do not sign yet, and treating silence as forgery would
mislabel nearly all real traffic.

Unsigned requests cost nothing: the check returns before any I/O. Signed ones
fetch the signer's key directory once per origin and cache it for an hour.

## Upgrading to 0.12

Four breaking changes, all deliberate. Each one existed because the previous
behaviour was wrong in a way that failed quietly.

**`distinctId` is now keyed.** The old identifier was an unsalted 32-bit djb2
over `ip:userAgent`. Since the user agent ships in plaintext on the same event,
only the IP had to be searched — a laptop recovered a residential address in
75 seconds. Set `idSecret` (or `AGENT_ANALYTICS_ID_SECRET`) to a stable secret;
without one, a random per-instance secret is used, which stays private but
means ids no longer correlate across instances. Existing ids will not match the
new ones either way.

```diff
- void trackVisit(req, { analytics })
+ void trackVisit(req, { analytics, idSecret: process.env.AGENT_ANALYTICS_ID_SECRET })
```

**`verifyIdentity: true` is replaced by an injected verifier.** The published
IP range tables are the largest thing in the package, and importing them from
the root entry shipped them to every consumer whether or not they verified
anything. They now live behind `@apideck/agent-analytics/verify`.

```diff
- void trackVisit(req, { analytics, verifyIdentity: true })
+ import { verifyRequest } from '@apideck/agent-analytics/verify'
+ void trackVisit(req, { analytics, verify: verifyRequest })
```

**Caller `properties` no longer override computed fields.** They were spread
last, so `properties: { path }` silently replaced the real path and
`properties: { is_ai_bot }` could contradict the classification on the same
event. Non-colliding keys are unaffected.

**Headless automation is labelled `Headless`, not `Browser`.** A browser user
agent with headless headers accounted for 79% of one production site's agent
traffic, and calling it `Browser` hid it behind the obvious
`bot_name != 'Browser'` filter. `headless_score` and `headless_likely` are now
omitted on declared crawlers and HTTP clients, where they fired on 99% of
events and carried no signal.

**Node 18 is no longer supported; the minimum is Node 20.** `globalThis.crypto`
only became available by default in Node 19, and shipping a `node:crypto`
fallback would mean a static import of a Node builtin in a library whose main
target is edge runtimes. Node 18 reached end of life in April 2025. Runtimes
without Web Crypto now fail with an explicit message rather than a confusing
`undefined` dereference.

### Also in 0.12

- Adapters surface non-2xx responses as `CaptureTransportError` instead of
  swallowing them. Pass `onError` to `trackVisit` to see them; capture still
  never throws into the response path.
- Outbound captures carry a 3s `AbortSignal` (`timeoutMs` to change it).
- Root bundle is 65% smaller (27.7 kB → 9.6 kB, 3.8 kB gzipped).

## Recommending firewall rules

Turn observed traffic into staged Vercel WAF proposals. It emits *proposals* —
every rule comes out in `log` mode and Vercel stages rule changes as drafts, so
nothing is live until you run `vercel firewall publish` yourself.

```ts
import { recommendFirewallRules, firewallScript } from '@apideck/agent-analytics/firewall'

const rules = recommendFirewallRules(observations) // aggregate from your warehouse
console.log(firewallScript(rules))                // runnable, commented bash
```

Two rules it will not break, both from measurement rather than taste:

- **Retrieval and search agents are never proposed for blocking**, and a `bypass`
  rule protecting them is emitted *first* so later rules cannot catch them.
  Rules evaluate top to bottom, and 60% of AI traffic on one production site is
  a person asking a question.
- **Training crawlers get rate limits, not denials.** Denying them removes you
  from future training sets, which is a discoverability decision rather than a
  default.

Only a failed verification earns a proposed `deny`. Every recommendation carries
its `evidence`, a `risk` rating, and a `caveat` where over-blocking is plausible
— the datacenter-ASN rule is marked `high` risk because corporate VPNs and
privacy relays egress from hosting networks.

### Pools that no per-address threshold catches

A rotating proxy pool is built so that no single address looks abusive. Measured
on one production site: 34 addresses across 11 countries, one user agent each,
the heaviest doing 100 requests in a day — every one invisible to a per-address
threshold, while collectively sweeping the site.

Volume cannot separate that from real readers, so the burst rule keys on *rate*,
which needs `spanSeconds` on your observations:

```ts
{ ip: '104.28.233.73', requests: 31, distinctPaths: 16, spanSeconds: 1 }
// → 1,860 requests/min. Not a person.
```

The rule is only safe because its condition excludes static assets. The WAF sees
every request; the middleware that produced your observations probably does not,
so a naive limit on `Mozilla` throttles a real visitor on their first page view.
Override `assetExclusions` if your app does not serve assets from `/_next/`.

See [`docs/TESTING-PAYMENTS.md`](./docs/TESTING-PAYMENTS.md) for testing the
payment path end to end.

## Entry points

The root carries detection, classification, policy and capture — what every
consumer needs. Everything optional lives behind a subpath, so it only reaches
your bundle if you import it.

| Import | Contains | Root bundle cost |
| --- | --- | ---: |
| `@apideck/agent-analytics` | detection, classification, `agentPolicy`, `trackVisit` | 11.6 kB / **4.5 kB gz** |
| `…/verify` | Web Bot Auth + published IP range tables | 19.0 kB |
| `…/payments` | 402 challenges, gateways, entitlements | 10.9 kB |
| `…/firewall` | WAF rule recommendations (offline tool) | 6.8 kB |
| `…/markdown` | Markdown-twin content negotiation | 2.0 kB |

This split is load-bearing rather than tidy-minded. Exporting the payment and
firewall surfaces from the root once pushed it from 9.6 kB to 22.5 kB — every
site paid for a firewall recommender that will never run in middleware. Nothing
failed; the number just drifted for weeks until someone looked.

So CI now enforces it. `npm run size` checks each entry against
[`size-budget.json`](./size-budget.json) and fails the build on a regression:

```
entry               gzipped     budget  used
dist/index.js       4.44 kB    4.88 kB   91%
dist/verify.js      6.25 kB    7.42 kB   84%
dist/pay.js         4.05 kB    4.49 kB   90%
```

Raising a budget is deliberate — `npm run size -- --update`, and say why in the
commit.

## Install

```bash
npm install @apideck/agent-analytics
# or
pnpm add @apideck/agent-analytics
# or
yarn add @apideck/agent-analytics
```

Zero dependencies. Runs on Node 18+, Edge, Bun, and anywhere the Web Fetch API exists.

## Quick start (60 seconds to your first event)

<table>
<tr>
<td width="33%" valign="top">

### 1. Pick an adapter

```ts
import {
  posthogAnalytics
} from '@apideck/agent-analytics'

const analytics = posthogAnalytics({
  apiKey: process.env.POSTHOG_KEY!
})
```

Ships with **PostHog**, **webhook**, and **custom** adapters. BYO analytics.

</td>
<td width="33%" valign="top">

### 2. Wire the middleware

```ts
// middleware.ts
import {
  trackVisit
} from '@apideck/agent-analytics'

export function middleware(req) {
  void trackVisit(req, {
    analytics,
    source: 'page-view'
  })
  return NextResponse.next()
}
```

Works in any middleware that hands you a `Request`.

</td>
<td width="33%" valign="top">

### 3. Ship it

```bash
vercel --prod
```

Hit any page with a spoofed UA:

```bash
curl -A "ClaudeBot/1.0" \
  https://yoursite.com/
```

Event lands in PostHog in seconds.

</td>
</tr>
</table>

---

## How it works

```text
                   Request                   Response (unchanged)
   Agent ─────────────────────►  middleware ───────────────────► Agent
                                      │
                                      │ fire-and-forget
                                      │ keepalive: true
                                      ▼
                            ┌──────────────────┐
                            │  AnalyticsAdapter │
                            │  (PostHog /       │
                            │   webhook /       │
                            │   custom fn)      │
                            └──────────────────┘
```

The middleware call:

1. **Reads UA** from `req.headers.get('user-agent')`
2. **Matches against** `AI_BOT_PATTERN` (ClaudeBot, GPTBot, PerplexityBot, Google-Extended, Applebot-Extended, CCBot, Bytespider, Amazonbot, Meta-ExternalAgent, MistralAI-User, Cursor, Windsurf, and more)
3. **Hashes `ip:ua`** with djb2 → stable anon distinct_id (same bot from same network = same visitor, no PII)
4. **Posts to your adapter** with `keepalive: true` so the request survives after the response returns
5. **Swallows errors** — a downed analytics backend never breaks your response

By default every request is captured so coding-agent traffic (axios, curl, Electron, …) surfaces alongside branded crawlers. Pass `onlyBots: true` to restrict capture to UAs matching the built-in AI bot pattern.

---

## Who's detected out of the box

<table>
<tr><th>Agent</th><th>UA signature</th><th>bot_name label</th></tr>
<tr><td><b>Anthropic</b></td><td><code>ClaudeBot</code>, <code>Claude-User</code>, <code>Anthropic-*</code></td><td><code>Claude</code></td></tr>
<tr><td><b>OpenAI</b></td><td><code>ChatGPT-User</code>, <code>GPTBot</code>, <code>OAI-SearchBot</code></td><td><code>ChatGPT</code></td></tr>
<tr><td><b>Perplexity</b></td><td><code>PerplexityBot</code>, <code>Perplexity-User</code></td><td><code>Perplexity</code></td></tr>
<tr><td><b>Google</b></td><td><code>Google-Extended</code>, <code>Googlebot</code></td><td><code>Google</code></td></tr>
<tr><td><b>Apple</b></td><td><code>Applebot-Extended</code>, <code>Applebot</code></td><td><code>Apple</code></td></tr>
<tr><td><b>Meta</b></td><td><code>Meta-ExternalAgent</code>, <code>FacebookBot</code></td><td><code>Meta</code></td></tr>
<tr><td><b>Amazon</b></td><td><code>Amazonbot</code></td><td><code>Amazon</code></td></tr>
<tr><td><b>Bytedance</b></td><td><code>Bytespider</code></td><td><code>Bytespider</code></td></tr>
<tr><td><b>Common Crawl</b></td><td><code>CCBot</code></td><td><code>Common Crawl</code></td></tr>
<tr><td><b>Mistral</b></td><td><code>MistralAI-User</code></td><td><code>Mistral</code></td></tr>
<tr><td><b>Cohere</b></td><td><code>cohere-ai</code></td><td><code>Cohere</code></td></tr>
<tr><td><b>DuckDuckGo</b></td><td><code>DuckAssistBot</code></td><td><code>DuckDuckGo</code></td></tr>
<tr><td><b>You.com</b></td><td><code>YouBot</code></td><td><code>You.com</code></td></tr>
<tr><td><b>AI2</b></td><td><code>AI2Bot</code></td><td><code>AI2</code></td></tr>
<tr><td><b>Diffbot</b></td><td><code>Diffbot</code></td><td><code>Diffbot</code></td></tr>
<tr><td><b>Coding agents</b></td><td><code>Cursor</code>, <code>Windsurf</code></td><td><code>Cursor</code> / <code>Windsurf</code></td></tr>
</table>

New agents appear every month. Patch releases ship as the list grows — watch the repo for updates. Raise a PR if you spot one we're missing.

### Coding agents (loose detection — `coding_agent_hint: true`)

Coding agents like Claude Code, Cline, Cursor, and Windsurf **don't identify themselves by name** in their user agent. They use whatever HTTP library they're built on, so detection is a loose heuristic — the UAs below are *also* used by legitimate curl scripts, CI jobs, and server-to-server traffic.

`is_ai_bot` stays `false` for these so your strict AI-traffic segment is clean. The `coding_agent_hint` property is the wider net; pair it with other signals (path patterns, [JA4 fingerprints via Vercel Log Drains](https://vercel.com/docs/observability/log-drains), HEAD-then-GET request shape) when you need higher confidence.

| Agent | Signature observed | `bot_name` |
|---|---|---|
| Claude Code | `axios/1.8.4` | `axios` |
| Cline / Junie | `curl/8.4.0` | `curl` |
| Cursor | `got (sindresorhus/got)` | `got` |
| Windsurf | `colly` (Go) | `colly` |
| VS Code | `Electron/` marker | `Electron` |
| Other automation | `node-fetch`, `python-requests`, `Go-http-client`, `okhttp`, `aiohttp`, `Deno` | exact library name |

Playwright-based agents (Aider, OpenCode) spoof full Mozilla/Safari UAs and are **indistinguishable from real browsers by UA alone**. They'll show up as `bot_name: Browser`, `ua_category: browser`. Catching those needs TLS fingerprinting (JA4) or behavioural analysis.

Credit: coding-agent signatures catalogued by [Addy Osmani](https://addyosmani.com/blog/agentic-engine-optimization/).

---

## Built-in adapters

### `posthogAnalytics`

```ts
import { posthogAnalytics } from '@apideck/agent-analytics'

const analytics = posthogAnalytics({
  apiKey: process.env.NEXT_PUBLIC_POSTHOG_KEY!,
  host: 'https://eu.i.posthog.com'        // optional; defaults to US cloud
})
```

Host can be the PostHog cloud (`us.i.posthog.com`, `eu.i.posthog.com`) **or** your own reverse-proxy domain (e.g. `https://svc.yourdomain.com`) to dodge ad-blockers. Scheme is optional — both `'https://host'` and `'host'` work.

### `webhookAnalytics`

```ts
import { webhookAnalytics } from '@apideck/agent-analytics'

const analytics = webhookAnalytics({
  url: 'https://collector.example.com/events',
  headers: { Authorization: `Bearer ${process.env.TOKEN}` },
  transform: (event) => ({              // optional: reshape for your backend
    type: event.event,
    user: event.distinctId,
    ...event.properties
  })
})
```

### `customAnalytics`

```ts
import { customAnalytics } from '@apideck/agent-analytics'
import { Mixpanel } from 'mixpanel'

const mp = Mixpanel.init(process.env.MIXPANEL_TOKEN!)

const analytics = customAnalytics((event) => {
  mp.track(event.event, { distinct_id: event.distinctId, ...event.properties })
})
```

Any `{ capture(event): Promise<void> | void }` object is a valid adapter. Compose multiple by fanning out in a custom callback.

---

## Advanced: Markdown mirror for docs sites

Content-heavy sites should serve **clean Markdown** when an agent asks for it — that's what makes your docs actually useful to coding agents, not just indexable. The `/markdown` subpath exports the helpers that power [developers.apideck.com](https://developers.apideck.com)'s agent-readiness stack:

```ts
import {
  markdownServeDecision,   // decide if this request should get Markdown
  markdownHeaders,         // Content-Type, Content-Signal, x-markdown-tokens
  synthesizeMarkdownPointer // fallback for URLs without a mirror
} from '@apideck/agent-analytics/markdown'
```

Three triggers, one decision helper:

| Trigger | Example | `reason` |
|---|---|---|
| AI-bot UA on any URL | `curl -A ClaudeBot /docs/intro` | `ua-rewrite` |
| `.md` suffix | `curl /docs/intro.md` | `md-suffix` |
| `Accept: text/markdown` header | `curl -H "Accept: text/markdown" /docs/intro` | `accept-header` |

Full middleware example: [`README.md → Markdown mirror helpers`](./README.md#markdown-mirror-helpers) section, or copy from [the reference implementation](https://github.com/apideck-io/developer-docs/blob/main/src/middleware.ts).

---

## Advanced: verifying crawler identity against published IP ranges

User agents are trivially forged — `curl -A "ChatGPT-User"` is indistinguishable
from the real thing at the UA layer. Set `verifyIdentity: true` to check the
client IP against the vendor's published crawler ranges:

```ts
void trackVisit(request, {
  analytics,
  verifyIdentity: true,
  captureIp: true // not required, but useful for auditing a 'spoofed' verdict
})
```

Three properties land on the event:

| property | values |
| --- | --- |
| `bot_verification` | `verified` \| `spoofed` \| `unverifiable` \| `not-claimed` |
| `bot_verified` | `true` \| `false` \| `null` — tri-state, for quick filtering |
| `bot_verification_reason` | why, when the verdict is `unverifiable` |

### What can actually be verified

Only vendors that publish a machine-readable range feed: **OpenAI**,
**Anthropic**, **Perplexity**, and **Apple**. Bytespider, Amazonbot, Meta and
the rest report `unverifiable` — never `spoofed`. Collapsing "we can't check"
into "impostor" would be a false accusation, which is why `bot_verified` is
tri-state rather than a boolean.

### Server-side crawlers vs client-side agents

A published range list covers a vendor's **crawler fleet**, not its products
that fetch from the end user's device. Claude Code runs on a developer's
laptop, so the request carries *their* IP and will never appear in Anthropic's
ranges. Measured over 30 days of production traffic:

| user agent | events | distinct IPs | in published range |
| --- | ---: | ---: | ---: |
| `ClaudeBot` | 13,671 | 236 | 96% |
| `PerplexityBot` | 6,897 | 158 | 91% |
| `ChatGPT-User` | ~72,000 | 43 | 99% |
| `Claude-User` (claude-code CLI) | 6,492 | 4,486 | **0%** |
| `Perplexity-User` | 493 | 148 | **0%** |

A naive vendor-level check would brand the bottom two rows — roughly 7,000
legitimate fetches a month — as impersonation. So the library gates verdicts on
the *product*, returning `unverifiable` with reason `client-side-agent` for
those. Note the distinction is not a `-User` suffix: OpenAI's `ChatGPT-User`
fetches server-side from Azure and verifies at ~99%.

### Keeping the ranges fresh

The bundled snapshot is in `src/bot-ranges.ts`, stamped with
`BOT_RANGES_CAPTURED_AT`. Refresh it on a schedule:

```bash
node scripts/refresh-bot-ranges.mjs
```

Freshness is the whole game. Nearly every OpenAI prefix is an Azure block and
Anthropic's are GCP, so "came from a datacenter" proves nothing on its own —
only membership in the *current* published list does. A stale snapshot produces
false `spoofed` verdicts on real crawlers, so the refresh script refuses to
write a list that shrinks by more than half or when any feed errors.

### Trusting the client IP

The verdict is only as good as the IP. On Vercel and Cloudflare the edge
overwrites `x-forwarded-for`, so the first hop is trustworthy. Behind a proxy
that passes a client-supplied header through, an attacker controls the value
and `verified` means nothing — confirm your proxy's behaviour before acting on
this data.

---

## Advanced: Peec.ai crawl-insights export

[Peec.ai](https://peec.ai)'s **Agent analytics** product ingests a CSV/CLF access log and produces dashboards on top of it. The Peec docs assume you have a Vercel Log Drain → Axiom (or similar) pipeline that emits these eight columns: `timestamp, request_method, request_url, response_status, client_ip, user_agent, country_code, referer`.

If you're already running this library, **you can skip the log drain** — your PostHog `agent_visit` events are a near-superset of that schema. Opt into the two privacy-sensitive fields:

```ts
void trackVisit(req, {
  analytics,
  captureCountry: true,   // emits country_code from x-vercel-ip-country / cf-ipcountry / x-country-code
  captureGeo: true,       // emits region, city, latitude, longitude, timezone from x-vercel-ip-* (URL-decoded)
  captureIp: true         // emits raw client_ip (first hop of x-forwarded-for)
})
```

All three default to **off** so the library stays PII-free out of the box. Enable them only on the deployments you intend to export. `captureGeo` is more identifying than `captureCountry` (city resolution vs. country) — opt in deliberately.

Then export from PostHog with a SQL insight:

```sql
SELECT
  timestamp                                       AS timestamp,
  coalesce(properties.method, 'GET')              AS request_method,
  properties.$current_url                         AS request_url,
  '200'                                           AS response_status,   -- middleware runs pre-response
  coalesce(properties.client_ip, properties.$ip)  AS client_ip,
  properties.user_agent                           AS user_agent,
  coalesce(properties.country_code,
           properties.$geoip_country_code)        AS country_code,
  properties.referer                              AS referer
FROM events
WHERE event = 'agent_visit'
  AND properties.is_ai_bot = true
  AND timestamp >= now() - INTERVAL 30 DAY
ORDER BY timestamp DESC
```

`coalesce` makes the query work on historical events that predate the new fields and on events where `captureCountry` / `captureIp` are off (PostHog's built-in `$ip` and `$geoip_country_code` enrichment fills the gap). Click **Export → CSV** and upload to Peec.

**Caveats:**
- `response_status` is hardcoded `200` — middleware runs before the response. If Peec filters on status, use the Vercel Log Drain path instead.
- Drop `is_ai_bot = true` from the `WHERE` clause to also include coding-agent / scraper traffic (curl, axios, headless browsers).

---

## Compared to…

<table>
<tr>
<th></th>
<th align="center">@apideck/agent-analytics</th>
<th align="center">DIY middleware</th>
<th align="center">Dark Visitors SaaS</th>
<th align="center">Cloudflare AI Labyrinth</th>
</tr>
<tr>
<td><b>Tracks agents in your analytics</b></td>
<td align="center">✓</td>
<td align="center">✓ (after N hours of glue code)</td>
<td align="center">✓ (external dashboard)</td>
<td align="center">✗ (it blocks them instead)</td>
</tr>
<tr>
<td><b>Reuses your analytics backend</b></td>
<td align="center">✓ PostHog / webhook / any</td>
<td align="center">✓</td>
<td align="center">✗ (their dashboard)</td>
<td align="center">✗</td>
</tr>
<tr>
<td><b>Zero runtime dependencies</b></td>
<td align="center">✓</td>
<td align="center">✓</td>
<td align="center">✗ (SaaS)</td>
<td align="center">✗ (Cloudflare)</td>
</tr>
<tr>
<td><b>Ships maintained UA list</b></td>
<td align="center">✓</td>
<td align="center">✗</td>
<td align="center">✓</td>
<td align="center">✓</td>
</tr>
<tr>
<td><b>Markdown-mirror helpers</b></td>
<td align="center">✓</td>
<td align="center">✗</td>
<td align="center">✗</td>
<td align="center">✗</td>
</tr>
<tr>
<td><b>Monthly cost</b></td>
<td align="center">$0</td>
<td align="center">$0 + engineering time</td>
<td align="center">$$$</td>
<td align="center">Requires CF plan</td>
</tr>
</table>

---

## FAQ

<details>
<summary><b>Will this slow down my middleware?</b></summary>

No. `trackVisit` returns a promise you don't await, and the underlying `fetch` uses `keepalive: true` — the browser / runtime guarantees the request completes after your response returns. Your critical path is: `req.headers.get('user-agent')` + a regex test + a `void fetch(...)`. Sub-millisecond.

</details>

<details>
<summary><b>What if my analytics backend is down?</b></summary>

The adapter call is wrapped in try/catch — `trackVisit` never throws, even if PostHog / your webhook / your custom callback crashes. You lose the event, not the response.

</details>

<details>
<summary><b>Does this create PostHog person profiles for every bot?</b></summary>

No. The event includes `$process_person_profile: false`, which tells PostHog to skip profile creation. Distinct IDs are djb2 hashes of `ip:ua`, so same-bot-same-network collapses into one anonymous visitor for journey analysis, but no "person" row gets created.

</details>

<details>
<summary><b>How do I detect a bot I added to the UA list in my own code?</b></summary>

```ts
import { isAiBot, parseBotName } from '@apideck/agent-analytics'

if (isAiBot(req.headers.get('user-agent'))) {
  // serve Markdown, skip personalisation, add rate limits, etc.
}
parseBotName('ClaudeBot/1.0')  // → 'Claude'
```

</details>

<details>
<summary><b>Can I use this outside Next.js?</b></summary>

Yes. The primary API takes a standard Web Fetch `Request` object. Works in Hono, Bun, Cloudflare Workers, Deno Deploy, Node 18+ HTTP handlers — anywhere you can get a `Request`.

</details>

<details>
<summary><b>Why not just enable PostHog's bot filtering?</b></summary>

PostHog's bot filter excludes bots from your metrics. This library does the opposite: it makes bots *visible* so you can analyse them deliberately. Complementary — segment by `is_ai_bot` to split the populations.

</details>

<details>
<summary><b>Is the UA list going to go stale?</b></summary>

AI crawlers keep appearing. We publish patch releases whenever the list changes — `npm update @apideck/agent-analytics` picks them up. If you spot a missing agent, send a PR with a link to the bot's official docs; merges ship the same day.

</details>

---

## Who uses this

- **[developers.apideck.com](https://developers.apideck.com)** — extracted from and battle-tested on the Apideck developer documentation site
- *Your company here — send a PR*

---

## Roadmap

- [ ] Runtime UA list fetching (opt-in) so patches land without a dependency bump
- [ ] First-class Mixpanel, Amplitude, Segment adapters
- [ ] Vercel Marketplace one-click install
- [ ] Pre-built PostHog dashboards (JSON export) for AI-vs-human, agent leaderboard, top-pages-per-agent
- [ ] `createMarkdownMiddleware()` — a batteries-included Next.js middleware for the full agent-readiness stack

File a [feature request](https://github.com/apideck-libraries/agent-analytics/issues/new) if something's missing from your setup.

---

## Contributing

PRs welcome — especially new UA signatures, adapters, and docs.

```bash
git clone https://github.com/apideck-libraries/agent-analytics
cd agent-analytics
npm install
npm test
```

### Releasing

Publishing to npm is fully automated by two workflows:

1. **`release.yml`** watches `package.json` on `main`. When the version field
   bumps to something without a matching `v<version>` tag, it creates the
   GitHub Release.
2. **`publish.yml`** fires on `release: published`, runs typecheck + tests +
   build, and publishes to npm with `--provenance` via OIDC trusted
   publishing (no secrets required).

So cutting a release is just:

```bash
# Pick a level (patch | minor | major), or edit package.json directly.
npm version patch
git push
```

The push lands on main, `release.yml` notices the new version, cuts the
release, and `publish.yml` publishes. No CLI juggling, no secrets to manage.

OIDC trusted publishing is configured at
[npmjs.com/package/@apideck/agent-analytics/access](https://www.npmjs.com/package/@apideck/agent-analytics/access)
— the GitHub repo + `publish.yml` workflow are registered as the sole
trusted publisher.

## Credits

Built on learnings from:

- [Agentic Engine Optimization](https://addyosmani.com/blog/agentic-engine-optimization/) by Addy Osmani — the case for making sites agent-ready
- [contentsignals.org](https://contentsignals.org) — the Content-Signal spec
- [darkvisitors.com](https://darkvisitors.com) — maintained catalogue of AI user-agents we cross-reference

## License

[MIT](./LICENSE) © [Apideck](https://apideck.com)

---

<div align="center">
<sub>Built by <a href="https://apideck.com">Apideck</a> — the unified API platform for integrations.</sub>
</div>
