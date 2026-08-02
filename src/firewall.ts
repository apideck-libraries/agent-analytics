/**
 * Recommend Vercel WAF rules from observed agent traffic.
 *
 * This generates *proposals*, never live changes. Every recommendation comes out
 * with `action: 'log'`, because a firewall rule's blast radius is unpredictable
 * until real traffic hits it and a bad `deny` takes out real users or your SEO.
 * Vercel's own guidance is log → review → preview → production; the `eventual`
 * field records where a rule is meant to end up, and `cli` emits the command for
 * the *current* stage only.
 *
 * Two hard rules, both from measurement rather than taste:
 *
 *   1. Retrieval agents and search crawlers are never proposed for blocking.
 *      60% of AI traffic on one production site is retrieval — a person asked a
 *      question and an assistant went to read the page. Blocking that is
 *      blocking your own distribution. The recommender emits a `bypass` rule to
 *      protect them *first*, so later rules cannot catch them.
 *
 *   2. Training crawlers get rate limits, not denials, by default. The point is
 *      to bound cost, not to disappear from corpora.
 *
 * Only abuse gets a denial: an identity that failed cryptographic or IP
 * verification, or a single address behaving like a scraper.
 */

import type { AgentIntent } from './policy.js'

/** A Vercel WAF condition. Mirrors the CLI's `--condition` JSON. */
export interface FirewallCondition {
  type:
    | 'user_agent'
    | 'ip_address'
    | 'geo_as_number'
    | 'geo_country'
    | 'path'
    | 'method'
    | 'environment'
    | 'ja4_digest'
  op: 'eq' | 'neq' | 'sub' | 'pre' | 'suf' | 're' | 'inc' | 'ninc' | 'gt' | 'gte'
  value?: string | number | Array<string | number>
  key?: string
  neg?: boolean
}

export type FirewallAction = 'log' | 'deny' | 'challenge' | 'bypass' | 'rate_limit'

export interface RateLimitSpec {
  /** Seconds, 10–3600. */
  window: number
  /** Max requests per window. */
  requests: number
  /** What happens on breach. */
  action: 'rate_limit' | 'deny' | 'challenge' | 'log'
  keys: Array<'ip' | 'ja4'>
}

export interface FirewallRecommendation {
  name: string
  /** Why this rule is proposed, in one sentence. */
  rationale: string
  /** The measurement behind it. Never propose a rule without evidence. */
  evidence: string
  /** OR of ANDs: outer array is groups, inner is conditions within a group. */
  groups: FirewallCondition[][]
  /** Always `'log'` or `'bypass'` — see the module note. */
  action: FirewallAction
  /** Where this rule is intended to end up after review. */
  eventual: FirewallAction
  rateLimit?: RateLimitSpec
  /** How likely this is to catch traffic you wanted. */
  risk: 'low' | 'medium' | 'high'
  /** What could go wrong, when it is not obvious. */
  caveat?: string
  /** Ready-to-run CLI for the *current* stage. */
  cli: string
  /** Equivalent `--json` payload. */
  json: unknown
}

/** One aggregated slice of observed traffic. */
export interface TrafficObservation {
  userAgent: string
  botName: string
  intent: AgentIntent
  requests: number
  ip?: string
  /** Autonomous system number, if you resolved one. */
  asn?: number
  /** Distinct paths this slice touched — a scraper sweeps, a reader does not. */
  distinctPaths?: number
  /**
   * Seconds between this slice's first and last request. Combined with
   * `requests` this gives a rate, which is the signal that separates a scraper
   * from a reader when volume alone does not: on one production site the
   * heaviest single address managed only 100 requests a day — far under any
   * sane abuse threshold — but fetched 16 distinct pages in one second.
   */
  spanSeconds?: number
  /** Verification verdict, if you ran one. */
  verification?: 'verified' | 'spoofed' | 'unverifiable' | 'not-claimed'
  country?: string
}

export interface RecommendOptions {
  /**
   * Requests-per-slice above which a single IP is considered abusive. Defaults
   * to 10x the median across observations, floored at 500.
   */
  abuseThreshold?: number
  /** Rate-limit budget proposed for training crawlers. Defaults to 600/hour. */
  trainingBudget?: { window: number; requests: number }
  /** Skip the protective bypass rule. Rarely a good idea. */
  omitProtectiveBypass?: boolean
  /**
   * Burst budget for the distributed-scraper rule, in *page* requests. Defaults
   * to 30 per 60s, which no human reaches once static assets are excluded.
   */
  burstBudget?: { window: number; requests: number }
  /**
   * How many distinct low-volume addresses must look alike before they are
   * treated as one coordinated pool. Defaults to 5.
   */
  minPoolSize?: number
  /**
   * Path prefixes and extensions the burst rule must not count, because the WAF
   * sees every asset request while your middleware probably does not. Defaults
   * to Next.js internals and the usual static extensions.
   */
  assetExclusions?: { prefixes: readonly string[]; extensions: readonly string[] }
}

const DEFAULT_ASSET_EXCLUSIONS = {
  prefixes: ['/_next/'],
  extensions: [
    'js', 'css', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico',
    'woff', 'woff2', 'ttf', 'otf', 'map'
  ]
} as const

/* -------------------------------------------------------------------------- */

function shellQuote(json: unknown): string {
  return `'${JSON.stringify(json).replace(/'/g, `'\\''`)}'`
}

function toCli(r: Omit<FirewallRecommendation, 'cli' | 'json'>): string {
  const parts = [`vercel firewall rules add ${JSON.stringify(r.name)}`]
  r.groups.forEach((group, i) => {
    if (i > 0) parts.push('  --or')
    for (const c of group) parts.push(`  --condition ${shellQuote(c)}`)
  })
  parts.push(`  --action ${r.action}`)
  if (r.action === 'rate_limit' && r.rateLimit) {
    parts.push(`  --rate-limit-window ${r.rateLimit.window}`)
    parts.push(`  --rate-limit-requests ${r.rateLimit.requests}`)
    parts.push(`  --rate-limit-action ${r.rateLimit.action}`)
    for (const k of r.rateLimit.keys) parts.push(`  --rate-limit-keys ${k}`)
  }
  parts.push('  --yes')
  return parts.join(' \\\n')
}

function toJson(r: Omit<FirewallRecommendation, 'cli' | 'json'>): unknown {
  return {
    name: r.name,
    conditionGroup: r.groups.map((conditions) => ({ conditions })),
    action: { mitigate: { action: r.action } }
  }
}

function finish(r: Omit<FirewallRecommendation, 'cli' | 'json'>): FirewallRecommendation {
  return { ...r, cli: toCli(r), json: toJson(r) }
}

function median(ns: number[]): number {
  if (!ns.length) return 0
  const s = [...ns].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/* -------------------------------------------------------------------------- */

/**
 * Turn observations into staged WAF proposals.
 *
 * @example
 * ```ts
 * const rules = recommendFirewallRules(observations)
 * for (const r of rules) {
 *   console.log(`# ${r.name} — ${r.rationale}`)
 *   console.log(`# evidence: ${r.evidence}`)
 *   console.log(r.cli)
 * }
 * ```
 */
export function recommendFirewallRules(
  observations: readonly TrafficObservation[],
  opts: RecommendOptions = {}
): FirewallRecommendation[] {
  const out: FirewallRecommendation[] = []

  /* 1. Protect the traffic you want, first and above everything else. --------
     Rules are evaluated top to bottom, so this has to be rule #1 or a later
     user-agent rule will swallow the agents that bring you readers. */
  if (!opts.omitProtectiveBypass) {
    const wanted = observations.filter((o) => o.intent === 'retrieval' || o.intent === 'search')
    const requests = wanted.reduce((n, o) => n + o.requests, 0)
    const names = [...new Set(wanted.map((o) => o.botName))]
    out.push(
      finish({
        name: 'Allow retrieval and search agents',
        rationale:
          'Retrieval agents and search crawlers must never be caught by the rules below — they bring readers and rankings.',
        evidence: requests
          ? `${requests.toLocaleString('en-US')} observed requests across ${names.length} vendors (${names.slice(0, 6).join(', ')})`
          : 'no retrieval or search traffic observed yet; installed pre-emptively',
        groups: [
          [
            {
              type: 'user_agent',
              op: 'inc',
              value: [
                'ChatGPT-User',
                'OAI-SearchBot',
                'Claude-User',
                'Claude-SearchBot',
                'Perplexity-User',
                'PerplexityBot',
                'Googlebot',
                'bingbot',
                'DuckDuckBot',
                'Applebot'
              ]
            }
          ]
        ],
        action: 'bypass',
        eventual: 'bypass',
        risk: 'low',
        caveat:
          'Place this rule first (`vercel firewall rules reorder ... --first`). A user-agent allowlist is spoofable, so pair with verification in middleware rather than relying on it for security — its job here is to stop your own rules misfiring.'
      })
    )
  }

  /* 1b. Link unfurlers, protected separately from the agents above. ----------
     Kept out of the rule above deliberately. Those tokens belong to vendors who
     publish IP ranges and increasingly sign their requests; `facebookexternalhit`
     and friends do neither and are among the most-forged strings on the web. A
     `bypass` skips every managed ruleset too, so folding them into a rule
     labelled `low` risk would understate what it hands out. Same protection,
     honest label, and an operator can decline this one on its own. */
  const preview = observations.filter((o) => o.intent === 'preview')
  if (!opts.omitProtectiveBypass && preview.length) {
    const requests = preview.reduce((n, o) => n + o.requests, 0)
    const names = [...new Set(preview.map((o) => o.botName))]
    out.push(
      finish({
        name: 'Allow link unfurlers',
        rationale:
          'Someone pasted your URL into a conversation and the platform fetched it to render a card. Blocking it makes your links look broken wherever they are shared.',
        evidence: `${requests.toLocaleString('en-US')} requests across ${names.length} platform${names.length === 1 ? '' : 's'} (${names.slice(0, 6).join(', ')})`,
        groups: [
          [
            {
              type: 'user_agent',
              op: 'inc',
              value: [
                'facebookexternalhit',
                'Twitterbot',
                'LinkedInBot',
                'Slackbot',
                'Discordbot',
                'TelegramBot',
                'WhatsApp',
                'redditbot'
              ]
            }
          ]
        ],
        action: 'bypass',
        eventual: 'bypass',
        risk: 'medium',
        caveat:
          'These user agents are trivially spoofed and none of these platforms publish verifiable IP ranges, so this rule hands a bypass to anyone who sets the header. Scope it to your public content paths and never to anything authenticated or expensive.'
      })
    )
  }

  /* 2. Failed verification — the only class that earns a denial. ------------- */
  const spoofed = observations.filter((o) => o.verification === 'spoofed')
  const spoofedIps = [...new Set(spoofed.map((o) => o.ip).filter((v): v is string => !!v))]
  if (spoofedIps.length) {
    const requests = spoofed.reduce((n, o) => n + o.requests, 0)
    const vendors = [...new Set(spoofed.map((o) => o.botName))]
    out.push(
      finish({
        name: 'Deny impersonated crawler identities',
        rationale:
          'These addresses claimed a crawler identity that failed verification against the vendor’s published ranges or signature.',
        evidence: `${requests.toLocaleString('en-US')} requests from ${spoofedIps.length} address${spoofedIps.length === 1 ? '' : 'es'} impersonating ${vendors.join(', ')}`,
        groups: [[{ type: 'ip_address', op: 'inc', value: spoofedIps }]],
        action: 'log',
        eventual: 'deny',
        risk: 'low',
        caveat:
          'Verification failure is strong evidence, but confirm your edge controls x-forwarded-for before enforcing — behind a proxy that forwards a client-supplied header the verdict is worthless.'
      })
    )
  }

  /* 3. Single addresses behaving like scrapers. ------------------------------ */
  const perIp = observations.filter((o) => o.ip && o.verification !== 'verified')
  const threshold =
    opts.abuseThreshold ?? Math.max(500, Math.round(median(perIp.map((o) => o.requests)) * 10))
  const heavy = perIp
    .filter((o) => o.requests >= threshold)
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 50)
  if (heavy.length) {
    const sweeping = heavy.filter((o) => (o.distinctPaths ?? 0) > 100)
    out.push(
      finish({
        name: 'Rate limit high-volume unverified addresses',
        rationale:
          'A single address making orders of magnitude more requests than the median, with no verified identity.',
        evidence:
          `${heavy.length} address${heavy.length === 1 ? '' : 'es'} above ${threshold.toLocaleString('en-US')} requests` +
          (sweeping.length
            ? `; ${sweeping.length} swept >100 distinct paths, which reads as a scrape rather than a reader`
            : ''),
        groups: [[{ type: 'ip_address', op: 'inc', value: heavy.map((o) => o.ip!) }]],
        action: 'log',
        eventual: 'rate_limit',
        rateLimit: { window: 60, requests: 60, action: 'rate_limit', keys: ['ip'] },
        risk: 'medium',
        caveat:
          'Shared egress means one address can front many real users — a corporate NAT, a mobile carrier, or a VPN. Review the dashboard before enforcing.'
      })
    )
  }

  /* 3b. Many small addresses behaving as one. --------------------------------
     Rule 3 asks "is any single address abusive?" and a rotating proxy pool is
     built precisely so the answer is no. Observed on one production site: 34
     addresses across 11 countries, one user agent each, none above 100 requests
     a day — every one of them invisible to a per-address threshold, while
     collectively sweeping the site and inflating its analytics.

     Volume cannot separate that from real readers, so this keys on rate. It is
     safe to do so only because the condition excludes static assets: a person
     loading one page fires dozens of asset requests that the WAF counts and
     your middleware does not, and a naive limit on `Mozilla` would throttle
     real users on their first page view. */
  const pool = observations.filter(
    (o) =>
      o.ip !== undefined &&
      !heavy.some((h) => h.ip === o.ip) &&
      o.verification !== 'verified' &&
      (o.intent === 'unknown' || o.intent === 'tooling') &&
      /Mozilla|Chrome|Safari/i.test(o.userAgent)
  )
  const minPool = opts.minPoolSize ?? 5
  const poolIps = [...new Set(pool.map((o) => o.ip!))]
  if (poolIps.length >= minPool) {
    const burst = opts.burstBudget ?? { window: 60, requests: 30 }
    const requests = pool.reduce((n, o) => n + o.requests, 0)
    const countries = [...new Set(pool.map((o) => o.country).filter(Boolean))]

    // Only slices that actually carry timing can be shown to exceed the budget.
    // Say how many were measurable rather than implying the rest were clean.
    const timed = pool.filter((o) => o.spanSeconds !== undefined && o.spanSeconds > 0)
    const overBudget = timed.filter(
      (o) => o.requests / o.spanSeconds! > burst.requests / burst.window
    )
    const peak = timed.length
      ? Math.max(...timed.map((o) => (o.requests / o.spanSeconds!) * 60))
      : 0

    const assets = opts.assetExclusions ?? DEFAULT_ASSET_EXCLUSIONS
    const conditions: FirewallCondition[] = [
      { type: 'user_agent', op: 'sub', value: 'Mozilla' },
      ...assets.prefixes.map(
        (p): FirewallCondition => ({ type: 'path', op: 'pre', value: p, neg: true })
      ),
      {
        type: 'path',
        op: 're',
        value: `\\.(?:${assets.extensions.join('|')})$`,
        neg: true
      }
    ]

    out.push(
      finish({
        name: 'Burst limit page navigations',
        rationale:
          'A pool of addresses each too small to trip a per-address threshold, together behaving like one scraper. Rate is the only signal that separates them from real readers.',
        evidence:
          `${poolIps.length} addresses across ${countries.length} countries, ${requests.toLocaleString('en-US')} requests, none individually above the abuse threshold` +
          (timed.length
            ? `; ${overBudget.length} of ${timed.length} measurable slices exceeded ${burst.requests} requests/${burst.window}s, peaking at ${Math.round(peak).toLocaleString('en-US')}/min`
            : '; no timing supplied, so the burst budget is a default rather than a measurement'),
        groups: [conditions],
        action: 'log',
        eventual: 'rate_limit',
        rateLimit: { window: burst.window, requests: burst.requests, action: 'rate_limit', keys: ['ip'] },
        risk: 'medium',
        caveat:
          'The asset exclusions are what make this safe — the WAF counts every request, including the dozens of assets behind a single page view, so verify they match how your app actually serves static files before enforcing. Vercel counters are per region, so N regions can collectively exceed the limit by ~Nx.'
      })
    )
  }

  /* 4. Training crawlers: bound the cost, do not disappear from corpora. ----- */
  const training = observations.filter((o) => o.intent === 'training')
  if (training.length) {
    const requests = training.reduce((n, o) => n + o.requests, 0)
    const vendors = [...new Set(training.map((o) => o.botName))]
    const budget = opts.trainingBudget ?? { window: 3600, requests: 600 }
    out.push(
      finish({
        name: 'Rate limit training crawlers',
        rationale:
          'Bound what bulk corpus collection costs you without removing yourself from training sets.',
        evidence: `${requests.toLocaleString('en-US')} training requests from ${vendors.length} vendors (${vendors.slice(0, 6).join(', ')})`,
        groups: [
          [
            {
              type: 'user_agent',
              op: 'inc',
              value: ['GPTBot', 'ClaudeBot', 'CCBot', 'Bytespider', 'Amazonbot', 'meta-externalagent']
            }
          ]
        ],
        action: 'log',
        eventual: 'rate_limit',
        rateLimit: { window: budget.window, requests: budget.requests, action: 'rate_limit', keys: ['ip'] },
        risk: 'medium',
        caveat:
          'Denying these removes you from future training sets, which may be exactly wrong for discoverability. Rate limit rather than deny unless you have decided otherwise. Note Vercel counters are per region, so N regions can collectively exceed the limit by ~Nx.'
      })
    )
  }

  /* 5. Datacenter ASNs presenting browser user agents. ---------------------- */
  const headlessAsns = [
    ...new Set(
      observations
        .filter((o) => o.asn !== undefined && /Mozilla|Chrome|Safari/i.test(o.userAgent))
        .filter((o) => o.verification !== 'verified')
        .map((o) => o.asn!)
    )
  ]
  if (headlessAsns.length) {
    const slices = observations.filter((o) => o.asn !== undefined && headlessAsns.includes(o.asn))
    const requests = slices.reduce((n, o) => n + o.requests, 0)
    out.push(
      finish({
        name: 'Challenge browser user agents from datacenter networks',
        rationale:
          'A browser user agent arriving from a hosting network is automation wearing a costume — real browsers come from consumer ISPs.',
        evidence: `${requests.toLocaleString('en-US')} requests across ${headlessAsns.length} datacenter AS numbers`,
        groups: [
          [
            { type: 'geo_as_number', op: 'inc', value: headlessAsns },
            { type: 'user_agent', op: 'sub', value: 'Mozilla' }
          ]
        ],
        action: 'log',
        eventual: 'challenge',
        risk: 'high',
        caveat:
          'Highest false-positive risk here. Corporate VPNs, privacy relays and some mobile carriers egress from hosting ASNs, and a challenge page breaks API clients and link unfurlers outright. Keep this in log mode for a full week before considering enforcement.'
      })
    )
  }

  return out
}

/** Render recommendations as a runnable, commented shell script. */
export function firewallScript(recommendations: readonly FirewallRecommendation[]): string {
  const lines = [
    '#!/usr/bin/env bash',
    '# Vercel WAF proposals generated from observed agent traffic.',
    '#',
    '# Every rule starts in LOG mode and blocks nothing. Vercel stages rule',
    '# changes as drafts, so nothing is live until you run:',
    '#',
    '#   vercel firewall diff            # review',
    '#   vercel firewall publish --yes   # go live',
    '#',
    '# Review each rule in the dashboard before promoting it to its eventual',
    '# action. Rules evaluate top to bottom, so keep the bypass rule first.',
    'set -euo pipefail',
    ''
  ]
  recommendations.forEach((r, i) => {
    lines.push(`# ${i + 1}. ${r.name}`)
    lines.push(`#    why:      ${r.rationale}`)
    lines.push(`#    evidence: ${r.evidence}`)
    lines.push(`#    risk:     ${r.risk} — eventual action: ${r.eventual}`)
    if (r.caveat) lines.push(`#    caveat:   ${r.caveat}`)
    lines.push(r.cli)
    lines.push('')
  })
  const protective = recommendations.filter((r) => r.action === 'bypass')
  if (protective.length) {
    lines.push('# Keep the protective allow rules at the top of the evaluation order.')
    // Reversed: each --first pushes to the top, so applying them back-to-front
    // leaves the array's own order intact once all of them have run.
    for (const r of [...protective].reverse()) {
      lines.push(`vercel firewall rules reorder ${JSON.stringify(r.name)} --first --yes`)
    }
  }
  if (recommendations.length) {
    lines.push('')
    lines.push('vercel firewall diff')
    lines.push('echo "Review above, then: vercel firewall publish --yes"')
  }
  return lines.join('\n')
}
