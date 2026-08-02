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
