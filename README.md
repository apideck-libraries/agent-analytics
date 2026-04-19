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

By default only AI bots are captured. Pass `onlyBots: false` to track every request.

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
