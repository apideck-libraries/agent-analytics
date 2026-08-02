import { describe, expect, it } from 'vitest'
import { compileRanges, ipInCidr, ipInRanges, ipv4ToInt, ipv6ToBigInt } from '../src/cidr.js'
import { verifyBotIdentity, verifyRequest, verifiableVendors } from '../src/verify.js'
import { BOT_IP_RANGES } from '../src/bot-ranges.js'

describe('ipv4ToInt', () => {
  it('parses dotted quads', () => {
    expect(ipv4ToInt('0.0.0.0')).toBe(0)
    expect(ipv4ToInt('255.255.255.255')).toBe(4294967295)
    expect(ipv4ToInt('192.168.1.1')).toBe(3232235777)
  })

  it('rejects malformed input', () => {
    for (const bad of ['', '1.2.3', '1.2.3.4.5', '256.1.1.1', 'a.b.c.d', '1.2.3.-1', ' 1.2.3.4']) {
      expect(ipv4ToInt(bad)).toBeNull()
    }
  })

  it('rejects leading zeros, which some parsers read as octal', () => {
    // 010.1.1.1 is 8.1.1.1 in octal but 10.1.1.1 in decimal — refusing it
    // avoids disagreeing with whatever produced the range list.
    expect(ipv4ToInt('010.1.1.1')).toBeNull()
    expect(ipv4ToInt('01.2.3.4')).toBeNull()
  })
})

describe('ipv6ToBigInt', () => {
  it('parses full and compressed forms to the same value', () => {
    expect(ipv6ToBigInt('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe(
      ipv6ToBigInt('2001:db8::1')
    )
    expect(ipv6ToBigInt('::')).toBe(0n)
    expect(ipv6ToBigInt('::1')).toBe(1n)
  })

  it('parses IPv4-mapped addresses', () => {
    expect(ipv6ToBigInt('::ffff:192.168.1.1')).toBe(0xffffn * 2n ** 32n + 3232235777n)
  })

  it('strips zone indexes', () => {
    expect(ipv6ToBigInt('fe80::1%eth0')).toBe(ipv6ToBigInt('fe80::1'))
  })

  it('rejects malformed input', () => {
    for (const bad of ['', '1.2.3.4', '2001::db8::1', 'gggg::1', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9']) {
      expect(ipv6ToBigInt(bad)).toBeNull()
    }
  })
})

describe('ipInCidr', () => {
  it('matches IPv4 boundaries exactly', () => {
    // /28 spans .192 through .207 — the two adjacent addresses must miss.
    expect(ipInCidr('104.208.184.192', '104.208.184.192/28')).toBe(true)
    expect(ipInCidr('104.208.184.207', '104.208.184.192/28')).toBe(true)
    expect(ipInCidr('104.208.184.191', '104.208.184.192/28')).toBe(false)
    expect(ipInCidr('104.208.184.208', '104.208.184.192/28')).toBe(false)
  })

  it('handles /32 host routes and /0 catch-alls', () => {
    expect(ipInCidr('34.162.230.222', '34.162.230.222/32')).toBe(true)
    expect(ipInCidr('34.162.230.223', '34.162.230.222/32')).toBe(false)
    // /0 must match everything — `0xffffffff << 32` is a no-op in JS, so this
    // is the case a naive mask implementation gets wrong.
    expect(ipInCidr('8.8.8.8', '0.0.0.0/0')).toBe(true)
  })

  it('handles the high bit without sign errors', () => {
    // 255.x addresses overflow into negative territory under signed shifts.
    expect(ipInCidr('255.255.255.255', '255.255.255.0/24')).toBe(true)
    expect(ipInCidr('200.0.0.1', '128.0.0.0/1')).toBe(true)
    expect(ipInCidr('127.0.0.1', '128.0.0.0/1')).toBe(false)
  })

  it('matches IPv6 ranges', () => {
    expect(ipInCidr('2001:4860:4801:2008::1', '2001:4860:4801:2008::/64')).toBe(true)
    expect(ipInCidr('2001:4860:4801:2009::1', '2001:4860:4801:2008::/64')).toBe(false)
  })

  it('matches IPv4-mapped IPv6 against IPv4 ranges', () => {
    // Dual-stack edges hand us ::ffff:a.b.c.d; it must still match the v4 list.
    expect(ipInCidr('::ffff:104.208.184.200', '104.208.184.192/28')).toBe(true)
    expect(ipInCidr('::ffff:104.208.184.208', '104.208.184.192/28')).toBe(false)
  })

  it('returns false rather than throwing on junk', () => {
    for (const bad of ['', '   ', 'not-an-ip', '999.999.999.999']) {
      expect(ipInCidr(bad, '10.0.0.0/8')).toBe(false)
    }
    expect(ipInRanges('10.0.0.1', compileRanges(['garbage', '10.0.0.0/33']))).toBe(false)
  })
})

describe('verifyBotIdentity', () => {
  const CHATGPT_UA = 'Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)'
  // First prefix of OpenAI's published chatgpt-user feed.
  const REAL_OPENAI_IP = '104.208.184.193'

  it('verifies a real crawler from a published range', () => {
    const r = verifyBotIdentity(CHATGPT_UA, REAL_OPENAI_IP)
    expect(r.verdict).toBe('verified')
    expect(r.verified).toBe(true)
    expect(r.claimed).toBe('ChatGPT')
  })

  it('flags the same UA from an unpublished IP as spoofed', () => {
    // This is the whole point: `curl -A "ChatGPT-User"` from anywhere else.
    const r = verifyBotIdentity(CHATGPT_UA, '1.2.3.4')
    expect(r.verdict).toBe('spoofed')
    expect(r.verified).toBe(false)
    expect(r.claimed).toBe('ChatGPT')
  })

  it('verifies Anthropic, Perplexity, and Apple from their published ranges', () => {
    const cases: Array<[string, string, string]> = [
      ['ClaudeBot/1.0', '34.162.230.222', 'Claude'],
      ['Mozilla/5.0 (compatible; PerplexityBot/1.0)', '107.20.236.150', 'Perplexity'],
      ['Mozilla/5.0 (compatible; Applebot/0.1)', '17.22.237.5', 'Apple']
    ]
    for (const [ua, ip, label] of cases) {
      const r = verifyBotIdentity(ua, ip)
      expect(`${label}:${r.verdict}`).toBe(`${label}:verified`)
      expect(r.claimed).toBe(label)
    }
  })

  it('returns unverifiable — never spoofed — for vendors with no published feed', () => {
    // Branding Bytespider or Amazonbot an impostor just because we lack their
    // ranges would be a false accusation, so these must not be `false`.
    for (const ua of [
      'Mozilla/5.0 (compatible; Bytespider/1.0)',
      'Mozilla/5.0 (compatible; Amazonbot/0.1)',
      'meta-externalagent/1.1',
      'Mozilla/5.0 (compatible; SemrushBot/7~bl)'
    ]) {
      const r = verifyBotIdentity(ua, '1.2.3.4')
      expect(r.verdict).toBe('unverifiable')
      expect(r.verified).toBeNull()
    }
  })

  it('returns unverifiable when no IP is available', () => {
    for (const ip of ['', '   ', null, undefined]) {
      const r = verifyBotIdentity(CHATGPT_UA, ip)
      expect(r.verdict).toBe('unverifiable')
      expect(r.reason).toBe('no-client-ip')
      expect(r.verified).toBeNull()
    }
  })

  it('never accuses client-side agents that fetch from the user\'s own machine', () => {
    // Claude Code runs on a developer's laptop, so its IP is theirs and will
    // never be in Anthropic's ranges. Production data: 6,492 events across
    // 4,486 IPs, 0% in range — a naive vendor-level check brands every one of
    // them an impostor.
    const clientSide = [
      'Claude-User (claude-code/2.1.218; +https://support.anthropic.com/)',
      'Mozilla/5.0 (compatible; Perplexity-User/1.0)'
    ]
    for (const ua of clientSide) {
      const r = verifyBotIdentity(ua, '109.135.42.185')
      expect(`${ua.slice(0, 12)}:${r.verdict}`).toBe(`${ua.slice(0, 12)}:unverifiable`)
      expect(r.reason).toBe('client-side-agent')
      expect(r.verified).toBeNull()
    }
  })

  it('still verifies the server-side crawler from the same vendor', () => {
    // ClaudeBot proper fetches from Anthropic infra and verifies at ~96%.
    expect(verifyBotIdentity('ClaudeBot/1.0', '34.162.230.222').verdict).toBe('verified')
    // A `-User` suffix is not itself the signal: OpenAI fetches server-side.
    expect(verifyBotIdentity(CHATGPT_UA, REAL_OPENAI_IP).verdict).toBe('verified')
  })

  it('returns not-claimed for browsers and unknown UAs', () => {
    for (const ua of [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      '',
      null
    ]) {
      const r = verifyBotIdentity(ua, '1.2.3.4')
      expect(r.verdict).toBe('not-claimed')
      expect(r.verified).toBeNull()
      expect(r.claimed).toBeNull()
    }
  })

  it('reads the client IP from x-forwarded-for on a request', () => {
    const req = new Request('https://example.com/', {
      headers: {
        'user-agent': CHATGPT_UA,
        // Only the first hop is the client; the rest are proxies.
        'x-forwarded-for': `${REAL_OPENAI_IP}, 10.0.0.1, 10.0.0.2`
      }
    })
    expect(verifyRequest(req).verdict).toBe('verified')
  })
})

describe('bundled ranges', () => {
  it('covers the vendors that publish feeds', () => {
    expect(verifiableVendors()).toEqual(['ChatGPT', 'Claude', 'Perplexity', 'Apple'])
  })

  it('contains only parseable CIDRs', () => {
    for (const [vendor, cidrs] of Object.entries(BOT_IP_RANGES)) {
      expect(cidrs.length, `${vendor} has no ranges`).toBeGreaterThan(0)
      const compiled = compileRanges(cidrs)
      // Every entry must survive compilation — a silently dropped prefix means
      // real crawler traffic from that block gets marked spoofed.
      let v4Count = compiled.v4Wide.length
      for (const bucket of compiled.v4.values()) v4Count += bucket.length
      expect(v4Count + compiled.v6.length, `${vendor} dropped entries`).toBe(cidrs.length)
    }
  })
})

describe('bucketed IPv4 lookup', () => {
  it('agrees with a naive linear scan across every bundled prefix', () => {
    // The bucketing optimisation must be behaviour-preserving. Check every
    // published prefix plus the addresses either side of each boundary against
    // an independent brute-force implementation.
    const naive = (ip: string, cidrs: readonly string[]) =>
      cidrs.some((c) => {
        const [addr, bitsRaw] = c.split('/')
        if (addr!.includes(':')) return false
        const bits = Number(bitsRaw)
        const toInt = (s: string) =>
          s.split('.').reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0) >>> 0
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
        return ((toInt(ip) & mask) >>> 0) === ((toInt(addr!) & mask) >>> 0)
      })

    for (const [vendor, cidrs] of Object.entries(BOT_IP_RANGES)) {
      const compiled = compileRanges(cidrs)
      for (const cidr of cidrs) {
        const [addr, bitsRaw] = cidr.split('/')
        if (addr!.includes(':')) continue
        const bits = Number(bitsRaw)
        const base = addr!.split('.').reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0) >>> 0
        const size = bits === 32 ? 1 : 2 ** (32 - bits)
        const fmt = (n: number) =>
          [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
        // first inside, last inside, one below, one above
        for (const probe of [base, base + size - 1, base - 1, base + size]) {
          if (probe < 0 || probe > 0xffffffff) continue
          const ip = fmt(probe >>> 0)
          expect(ipInRanges(ip, compiled), `${vendor} ${cidr} probe ${ip}`).toBe(naive(ip, cidrs))
        }
      }
    }
  })

  it('still matches wide prefixes that span many buckets', () => {
    const wide = compileRanges(['10.0.0.0/7', '0.0.0.0/0'])
    expect(ipInRanges('10.255.255.255', wide)).toBe(true)
    expect(ipInRanges('11.0.0.1', wide)).toBe(true)
    expect(ipInRanges('8.8.8.8', wide)).toBe(true) // via /0
  })

  it('compiles lazily — repeated verification reuses the same tables', () => {
    // Regression guard for the module-load compilation this replaced.
    const first = verifyBotIdentity('ClaudeBot/1.0', '34.162.230.222')
    const second = verifyBotIdentity('ClaudeBot/1.0', '34.162.230.222')
    expect(first.verdict).toBe('verified')
    expect(second.verdict).toBe('verified')
  })
})

describe('client-side agent list has no dead entries', () => {
  it('only lists products whose vendor actually has published ranges', () => {
    // Cursor/Windsurf/Cline/Aider were listed but unreachable: their vendors
    // publish no feed, so they exit earlier as no-published-ranges.
    for (const ua of ['Cursor/1.0', 'Windsurf/1.0']) {
      expect(verifyBotIdentity(ua, '1.2.3.4').reason).toBe('no-published-ranges')
    }
    for (const ua of ['Claude-User (claude-code/2.1.218)', 'Perplexity-User/1.0']) {
      expect(verifyBotIdentity(ua, '1.2.3.4').reason).toBe('client-side-agent')
    }
  })
})
