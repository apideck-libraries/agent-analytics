import { describe, expect, it } from 'vitest'
import {
  firewallScript,
  recommendFirewallRules,
  type TrafficObservation
} from '../src/firewall.js'

const OBS: TrafficObservation[] = [
  // Traffic we want: a person asked, an assistant read the page.
  { userAgent: 'ChatGPT-User/1.0', botName: 'ChatGPT', intent: 'retrieval', requests: 280000, verification: 'verified' },
  { userAgent: 'Googlebot/2.1', botName: 'Google', intent: 'search', requests: 13000 },
  // Bulk corpus collection.
  { userAgent: 'GPTBot/1.1', botName: 'ChatGPT', intent: 'training', requests: 24000, verification: 'verified' },
  { userAgent: 'ClaudeBot/1.0', botName: 'Claude', intent: 'training', requests: 13600, verification: 'verified' },
  // An impostor.
  { userAgent: 'ClaudeBot/1.0', botName: 'Claude', intent: 'training', requests: 535, ip: '45.55.50.205', verification: 'spoofed' },
  // A scraper wearing a browser UA, from a hosting network.
  { userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15', botName: 'Headless', intent: 'unknown', requests: 16771, ip: '164.92.65.128', asn: 14061, distinctPaths: 5213 }
]

function byName(name: string) {
  return recommendFirewallRules(OBS).find((r) => r.name === name)!
}

describe('recommendFirewallRules', () => {
  it('never proposes an enforcing action — everything starts in log or bypass', () => {
    // A firewall rule's blast radius is unknowable until real traffic hits it.
    for (const r of recommendFirewallRules(OBS)) {
      expect(['log', 'bypass'], r.name).toContain(r.action)
    }
  })

  it('puts the protective allow rule first', () => {
    // Rules evaluate top to bottom. If this is not first, the user-agent rules
    // below it will swallow the agents that bring readers.
    const rules = recommendFirewallRules(OBS)
    expect(rules[0]!.action).toBe('bypass')
    expect(rules[0]!.name).toMatch(/retrieval and search/i)
  })

  it('never proposes blocking retrieval or search, at any stage', () => {
    // The single most important property. 60% of AI traffic is retrieval.
    const rules = recommendFirewallRules(OBS)
    const enforcing = rules.filter((r) => r.eventual === 'deny' || r.eventual === 'challenge')
    for (const r of enforcing) {
      const serialised = JSON.stringify(r.groups)
      for (const protectedUa of ['ChatGPT-User', 'Googlebot', 'Perplexity-User', 'Claude-User']) {
        expect(serialised, `${r.name} must not target ${protectedUa}`).not.toContain(protectedUa)
      }
    }
  })

  it('denies only failed verification', () => {
    const denies = recommendFirewallRules(OBS).filter((r) => r.eventual === 'deny')
    expect(denies).toHaveLength(1)
    expect(denies[0]!.name).toMatch(/impersonated/i)
    expect(JSON.stringify(denies[0]!.groups)).toContain('45.55.50.205')
  })

  it('rate limits training crawlers rather than denying them', () => {
    const r = byName('Rate limit training crawlers')
    expect(r.eventual).toBe('rate_limit')
    expect(r.rateLimit).toMatchObject({ window: 3600, requests: 600 })
    // Removing yourself from training sets is a discoverability decision, not a
    // default, so the caveat has to say so.
    expect(r.caveat).toMatch(/training sets/i)
  })

  it('flags the datacenter rule as the highest risk', () => {
    const r = byName('Challenge browser user agents from datacenter networks')
    expect(r.risk).toBe('high')
    expect(r.caveat).toMatch(/VPN|relay|carrier/i)
  })

  it('carries evidence on every recommendation', () => {
    // No rule without a number behind it.
    for (const r of recommendFirewallRules(OBS)) {
      expect(r.evidence.length, r.name).toBeGreaterThan(10)
      expect(r.rationale.length, r.name).toBeGreaterThan(10)
    }
  })

  it('emits valid Vercel CLI and JSON forms', () => {
    for (const r of recommendFirewallRules(OBS)) {
      expect(r.cli).toContain('vercel firewall rules add')
      expect(r.cli).toContain(`--action ${r.action}`)
      expect(r.cli).toContain('--yes')
      // Conditions must be single-quoted JSON the shell will pass through intact.
      for (const group of r.groups) {
        for (const c of group) expect(r.cli).toContain(JSON.stringify(c))
      }
      expect(r.json).toMatchObject({
        name: r.name,
        action: { mitigate: { action: r.action } }
      })
    }
  })

  it('includes rate-limit flags only on rate-limited rules', () => {
    for (const r of recommendFirewallRules(OBS)) {
      if (r.action === 'rate_limit' && r.rateLimit) {
        expect(r.cli).toContain('--rate-limit-window')
      } else {
        expect(r.cli, r.name).not.toContain('--rate-limit-window')
      }
    }
  })

  it('proposes nothing beyond the protective rule when traffic is clean', () => {
    const clean: TrafficObservation[] = [
      { userAgent: 'ChatGPT-User/1.0', botName: 'ChatGPT', intent: 'retrieval', requests: 900, verification: 'verified' }
    ]
    const rules = recommendFirewallRules(clean)
    expect(rules).toHaveLength(1)
    expect(rules[0]!.action).toBe('bypass')
  })

  it('handles empty input without inventing rules', () => {
    const rules = recommendFirewallRules([])
    expect(rules).toHaveLength(1)
    expect(rules[0]!.evidence).toMatch(/no retrieval or search traffic/i)
  })

  it('can omit the protective bypass when explicitly asked', () => {
    const rules = recommendFirewallRules(OBS, { omitProtectiveBypass: true })
    expect(rules.some((r) => r.action === 'bypass')).toBe(false)
  })

  it('honours an explicit abuse threshold', () => {
    const low = recommendFirewallRules(OBS, { abuseThreshold: 100 })
    const high = recommendFirewallRules(OBS, { abuseThreshold: 10_000_000 })
    expect(low.some((r) => r.name.match(/high-volume/))).toBe(true)
    expect(high.some((r) => r.name.match(/high-volume/))).toBe(false)
  })
})

describe('distributed pools', () => {
  // Modelled on real traffic: 34 addresses, 11 countries, one UA each, the
  // heaviest doing 100 requests a day. Every one of them sits far below any
  // per-address threshold, which is the entire design of a rotating proxy pool.
  const POOL: TrafficObservation[] = [
    { userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/26.5 Safari/605.1.15', botName: 'Headless', intent: 'unknown', requests: 100, distinctPaths: 76, ip: '172.225.240.217', country: 'Germany', spanSeconds: 577 },
    { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/150.0.0.0 Safari/537.36', botName: 'Headless', intent: 'unknown', requests: 71, distinctPaths: 40, ip: '93.156.192.71', country: 'Spain', spanSeconds: 139 },
    { userAgent: 'Mozilla/5.0 (Macintosh) Chrome/150.0.0.0 Safari/537.36', botName: 'Headless', intent: 'unknown', requests: 68, distinctPaths: 50, ip: '148.252.147.43', country: 'United Kingdom', spanSeconds: 50 },
    { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/151.0.0.0 Safari/537.36', botName: 'Headless', intent: 'unknown', requests: 34, distinctPaths: 28, ip: '41.239.255.216', country: 'Egypt', spanSeconds: 329 },
    { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/150.0.0.0 Safari/537.36', botName: 'Headless', intent: 'unknown', requests: 31, distinctPaths: 16, ip: '104.28.233.73', country: 'United States', spanSeconds: 1 },
    { userAgent: 'Mozilla/5.0 (Macintosh) Chrome/150.0.0.0 Safari/537.36', botName: 'Headless', intent: 'unknown', requests: 13, distinctPaths: 12, ip: '109.206.198.23', country: 'Poland', spanSeconds: 11 }
  ]

  const burst = () =>
    recommendFirewallRules(POOL).find((r) => r.name === 'Burst limit page navigations')

  it('catches a pool that no per-address threshold would', () => {
    // Sanity-check the premise first: if any of these tripped rule 3 on its
    // own, this rule would be redundant and the test would prove nothing.
    const perAddress = recommendFirewallRules(POOL).find((r) => r.name.match(/high-volume/))
    expect(perAddress).toBeUndefined()
    expect(burst()).toBeDefined()
  })

  it('excludes static assets, which is the only reason it is safe', () => {
    // The WAF sees every asset request; the middleware that produced these
    // observations does not. Without these exclusions a 30/60s limit throttles
    // a real person on their first page view.
    const conditions = burst()!.groups[0]!
    expect(conditions.some((c) => c.type === 'path' && c.op === 'pre' && c.neg === true)).toBe(true)
    const ext = conditions.find((c) => c.type === 'path' && c.op === 're')!
    expect(ext.neg).toBe(true)
    expect(String(ext.value)).toMatch(/css/)
    expect(String(ext.value)).toMatch(/woff2/)
  })

  it('reports the peak rate it actually measured', () => {
    // 31 requests in 1 second — the slice that made the case.
    expect(burst()!.evidence).toMatch(/1,860\/min/)
    expect(burst()!.evidence).toMatch(/6 addresses across 6 countries/)
  })

  it('says so when it had no timing rather than implying it measured one', () => {
    const untimed = POOL.map(({ spanSeconds: _drop, ...o }) => o)
    expect(
      recommendFirewallRules(untimed).find((r) => r.name === 'Burst limit page navigations')!.evidence
    ).toMatch(/no timing supplied/)
  })

  it('does not re-cover addresses the per-address rule already caught', () => {
    const heavy: TrafficObservation[] = [
      ...POOL,
      { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/150 Safari/537.36', botName: 'Headless', intent: 'unknown', requests: 90_000, distinctPaths: 40_000, ip: '164.92.65.128', country: 'United States' }
    ]
    const rules = recommendFirewallRules(heavy)
    const perAddress = rules.find((r) => r.name.match(/high-volume/))!
    expect(perAddress.groups[0]![0]!.value).toContain('164.92.65.128')
    // The burst rule still fires for the pool, but the heavy address is not
    // double-counted into its evidence.
    expect(rules.find((r) => r.name === 'Burst limit page navigations')!.evidence).toMatch(
      /6 addresses/
    )
  })

  it('stays quiet below the pool size', () => {
    expect(
      recommendFirewallRules(POOL.slice(0, 3)).some((r) => r.name === 'Burst limit page navigations')
    ).toBe(false)
    expect(
      recommendFirewallRules(POOL.slice(0, 3), { minPoolSize: 3 }).some(
        (r) => r.name === 'Burst limit page navigations'
      )
    ).toBe(true)
  })

  it('leaves verified crawlers out of the pool', () => {
    const verified = POOL.map((o) => ({ ...o, verification: 'verified' as const }))
    expect(
      recommendFirewallRules(verified).some((r) => r.name === 'Burst limit page navigations')
    ).toBe(false)
  })
})

describe('link unfurlers', () => {
  const WITH_PREVIEW: TrafficObservation[] = [
    ...OBS,
    { userAgent: 'Slackbot-LinkExpanding 1.0', botName: 'Slack', intent: 'preview', requests: 420 },
    { userAgent: 'facebookexternalhit/1.1', botName: 'Facebook', intent: 'preview', requests: 180 }
  ]

  it('gets its own rule rather than riding the low-risk bypass', () => {
    const rules = recommendFirewallRules(WITH_PREVIEW)
    const unfurl = rules.find((r) => r.name === 'Allow link unfurlers')!
    const agents = rules.find((r) => r.name.match(/retrieval and search/i))!
    expect(unfurl.action).toBe('bypass')
    // A bypass skips managed rulesets too, and these tokens are unverifiable.
    // Labelling that `low` alongside vendors who publish IP ranges would
    // understate what the rule hands out.
    expect(unfurl.risk).toBe('medium')
    expect(agents.risk).toBe('low')
    expect(agents.groups[0]![0]!.value).not.toContain('facebookexternalhit')
  })

  it('sits immediately behind the agent bypass in evaluation order', () => {
    const rules = recommendFirewallRules(WITH_PREVIEW)
    expect(rules[0]!.name).toMatch(/retrieval and search/i)
    expect(rules[1]!.name).toBe('Allow link unfurlers')
  })

  it('is not emitted when nothing unfurled', () => {
    expect(recommendFirewallRules(OBS).some((r) => r.name === 'Allow link unfurlers')).toBe(false)
  })

  it('keeps every bypass rule on top of the published order', () => {
    const script = firewallScript(recommendFirewallRules(WITH_PREVIEW))
    const reorders = script.split('\n').filter((l) => l.includes('--first --yes'))
    expect(reorders).toHaveLength(2)
    // Applied back-to-front, so the agent rule lands on top.
    expect(reorders[0]).toContain('Allow link unfurlers')
    expect(reorders[1]).toContain('Allow retrieval and search agents')
  })
})

describe('firewallScript', () => {
  it('is a runnable script that publishes nothing', () => {
    const script = firewallScript(recommendFirewallRules(OBS))
    expect(script).toMatch(/^#!\/usr\/bin\/env bash/)
    expect(script).toContain('set -euo pipefail')
    // It must show the diff and stop — publishing is the human's call.
    expect(script).toContain('vercel firewall diff')
    expect(script).not.toMatch(/^vercel firewall publish/m)
    expect(script).toContain('--first --yes') // bypass rule stays on top
  })

  it('carries the why and the evidence into comments', () => {
    const script = firewallScript(recommendFirewallRules(OBS))
    expect(script).toContain('#    why:')
    expect(script).toContain('#    evidence:')
    expect(script).toContain('#    risk:')
  })
})
