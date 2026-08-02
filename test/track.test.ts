import { describe, expect, it, vi } from 'vitest'
import { customAnalytics } from '../src/adapters/custom.js'
import { trackVisit } from '../src/track.js'
import { verifyRequest } from '../src/verify.js'
import type { CaptureEvent } from '../src/types.js'

function makeRequest(
  url: string,
  headers: Record<string, string> = {}
): Request {
  return new Request(url, { headers })
}

describe('trackVisit', () => {
  it('captures when the UA is a known AI bot', async () => {
    const captured: CaptureEvent[] = []
    const analytics = customAnalytics((e) => {
      captured.push(e)
    })

    await trackVisit(
      makeRequest('https://example.com/docs/intro', {
        'user-agent': 'ClaudeBot/1.0',
        'x-forwarded-for': '1.2.3.4',
        referer: 'https://claude.ai/'
      }),
      { analytics, source: 'ua-rewrite', properties: { site: 'docs' } }
    )

    expect(captured).toHaveLength(1)
    const event = captured[0]!
    expect(event.event).toBe('agent_visit')
    expect(event.distinctId).toMatch(/^anon_[0-9a-f]+$/)
    expect(event.properties).toMatchObject({
      $current_url: 'https://example.com/docs/intro',
      path: '/docs/intro',
      user_agent: 'ClaudeBot/1.0',
      is_ai_bot: true,
      bot_name: 'Claude',
      ua_category: 'declared-crawler',
      coding_agent_hint: false,
      referer: 'https://claude.ai/',
      source: 'ua-rewrite',
      site: 'docs'
    })
  })

  it('sets bot_name to Browser for real browser traffic', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/page', {
        'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/120',
        'accept-language': 'en-US,en;q=0.9',
        'sec-fetch-mode': 'navigate',
        'sec-ch-ua': '"Chromium";v="120"',
        accept: 'text/html,application/xhtml+xml'
      }),
      { analytics: customAnalytics(spy), onlyBots: false }
    )
    const event = spy.mock.calls[0]![0] as CaptureEvent
    expect(event.properties.is_ai_bot).toBe(false)
    expect(event.properties.bot_name).toBe('Browser')
    expect(event.properties.ua_category).toBe('browser')
    expect(event.properties.coding_agent_hint).toBe(false)
    expect(event.properties.headless_likely).toBe(false)
  })

  it('sets coding_agent_hint and ua_category for HTTP-library UAs (onlyBots: false)', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/docs/intro', { 'user-agent': 'curl/8.4.0' }),
      { analytics: customAnalytics(spy), onlyBots: false }
    )
    const event = spy.mock.calls[0]![0] as CaptureEvent
    expect(event.properties).toMatchObject({
      is_ai_bot: false,
      bot_name: 'curl',
      ua_category: 'coding-agent-hint',
      coding_agent_hint: true
    })
  })

  it('skips capture when UA is not a bot and onlyBots is true', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/page', {
        'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/120'
      }),
      { analytics: customAnalytics(spy), onlyBots: true }
    )
    expect(spy).not.toHaveBeenCalled()
  })

  it('captures non-bot traffic by default (onlyBots defaults to false)', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/page', {
        'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/120'
      }),
      { analytics: customAnalytics(spy) }
    )
    expect(spy).toHaveBeenCalledOnce()
  })

  it('captures every request when onlyBots is false', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/page', {
        'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/120'
      }),
      { analytics: customAnalytics(spy), onlyBots: false }
    )
    expect(spy).toHaveBeenCalledOnce()
    const event = spy.mock.calls[0]![0] as CaptureEvent
    expect(event.properties.is_ai_bot).toBe(false)
  })

  it('skipBrowsers captures AI bots', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/page', { 'user-agent': 'ClaudeBot/1.0' }),
      { analytics: customAnalytics(spy), skipBrowsers: true }
    )
    expect(spy).toHaveBeenCalledOnce()
  })

  it('skipBrowsers captures coding agents (HTTP clients)', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/page', { 'user-agent': 'axios/1.6.0' }),
      { analytics: customAnalytics(spy), skipBrowsers: true }
    )
    expect(spy).toHaveBeenCalledOnce()
    const event = spy.mock.calls[0]![0] as CaptureEvent
    expect(event.properties.coding_agent_hint).toBe(true)
  })

  it('skipBrowsers skips real browsers (with standard headers)', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/page', {
        'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/120',
        'accept-language': 'en-US,en;q=0.9',
        'sec-fetch-mode': 'navigate',
        'sec-ch-ua': '"Chromium";v="120", "Google Chrome";v="120"',
        accept: 'text/html,application/xhtml+xml'
      }),
      { analytics: customAnalytics(spy), skipBrowsers: true }
    )
    expect(spy).not.toHaveBeenCalled()
  })

  it('skipBrowsers captures headless browsers (missing standard headers)', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/page', {
        'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/120'
        // Missing: accept-language, sec-fetch-mode, sec-ch-ua, proper accept
      }),
      { analytics: customAnalytics(spy), skipBrowsers: true }
    )
    expect(spy).toHaveBeenCalledOnce()
    const event = spy.mock.calls[0]![0] as CaptureEvent
    expect(event.properties.ua_category).toBe('headless-likely')
    expect(event.properties.headless_likely).toBe(true)
    expect(event.properties.headless_score).toBeGreaterThanOrEqual(2)
  })

  it('honours a custom event name', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/page', { 'user-agent': 'ClaudeBot/1.0' }),
      { analytics: customAnalytics(spy), eventName: 'agent_fetch' }
    )
    const event = spy.mock.calls[0]![0] as CaptureEvent
    expect(event.event).toBe('agent_fetch')
  })

  it('does not throw if the adapter throws', async () => {
    const analytics = customAnalytics(() => {
      throw new Error('downstream offline')
    })
    await expect(
      trackVisit(
        makeRequest('https://example.com/page', { 'user-agent': 'ClaudeBot' }),
        { analytics }
      )
    ).resolves.toBeUndefined()
  })

  it('emits $process_person_profile: false and an ISO timestamp', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/page', { 'user-agent': 'ClaudeBot' }),
      { analytics: customAnalytics(spy) }
    )
    const event = spy.mock.calls[0]![0] as CaptureEvent
    expect(event.properties.$process_person_profile).toBe(false)
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/)
  })

  it('defaults source to null when not provided', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/page', { 'user-agent': 'ClaudeBot' }),
      { analytics: customAnalytics(spy) }
    )
    const event = spy.mock.calls[0]![0] as CaptureEvent
    expect(event.properties.source).toBeNull()
  })

  it('defaults referer to null when header is missing', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/page', { 'user-agent': 'ClaudeBot' }),
      { analytics: customAnalytics(spy) }
    )
    const event = spy.mock.calls[0]![0] as CaptureEvent
    expect(event.properties.referer).toBeNull()
  })

  it('respects an explicit origin override in $current_url', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://internal.example/docs/intro', { 'user-agent': 'ClaudeBot' }),
      { analytics: customAnalytics(spy), origin: 'https://public.example.com' }
    )
    const event = spy.mock.calls[0]![0] as CaptureEvent
    expect(event.properties.$current_url).toBe('https://public.example.com/docs/intro')
    expect(event.properties.path).toBe('/docs/intro')
  })

  it('does not let user-supplied properties clobber computed fields', async () => {
    // This previously asserted the opposite. Caller properties were spread
    // last, so a colliding key silently corrupted the very classification it
    // was meant to annotate — an event could claim is_ai_bot: 'custom' on a
    // request the library had positively identified as ClaudeBot.
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/original', { 'user-agent': 'ClaudeBot' }),
      {
        analytics: customAnalytics(spy),
        properties: { path: '/overridden', site: 'docs', is_ai_bot: 'custom' }
      }
    )
    const event = spy.mock.calls[0]![0] as CaptureEvent
    expect(event.properties.path).toBe('/original')
    expect(event.properties.is_ai_bot).toBe(true)
    expect(event.properties.bot_name).toBe('Claude')
    // Non-colliding caller properties still come through.
    expect(event.properties.site).toBe('docs')
  })

  it('produces the same distinct_id for identical ip+ua across calls', async () => {
    const spy = vi.fn()
    const headers = { 'user-agent': 'ClaudeBot', 'x-forwarded-for': '203.0.113.1' }
    await trackVisit(
      makeRequest('https://example.com/a', headers),
      { analytics: customAnalytics(spy) }
    )
    await trackVisit(
      makeRequest('https://example.com/b', headers),
      { analytics: customAnalytics(spy) }
    )
    const a = spy.mock.calls[0]![0] as CaptureEvent
    const b = spy.mock.calls[1]![0] as CaptureEvent
    expect(a.distinctId).toBe(b.distinctId)
  })

  it('produces different distinct_ids for different UAs from the same IP', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/p', {
        'user-agent': 'ClaudeBot',
        'x-forwarded-for': '203.0.113.1'
      }),
      { analytics: customAnalytics(spy) }
    )
    await trackVisit(
      makeRequest('https://example.com/p', {
        'user-agent': 'GPTBot',
        'x-forwarded-for': '203.0.113.1'
      }),
      { analytics: customAnalytics(spy) }
    )
    const a = spy.mock.calls[0]![0] as CaptureEvent
    const b = spy.mock.calls[1]![0] as CaptureEvent
    expect(a.distinctId).not.toBe(b.distinctId)
  })

  it('captures method by default and omits country_code/client_ip', async () => {
    const spy = vi.fn()
    await trackVisit(
      new Request('https://example.com/page', {
        method: 'POST',
        headers: {
          'user-agent': 'ClaudeBot',
          'x-forwarded-for': '203.0.113.1',
          'x-vercel-ip-country': 'NL'
        }
      }),
      { analytics: customAnalytics(spy) }
    )
    const event = spy.mock.calls[0]![0] as CaptureEvent
    expect(event.properties.method).toBe('POST')
    expect(event.properties).not.toHaveProperty('country_code')
    expect(event.properties).not.toHaveProperty('client_ip')
  })

  it('emits country_code from x-vercel-ip-country when captureCountry is true', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/page', {
        'user-agent': 'ClaudeBot',
        'x-vercel-ip-country': 'NL'
      }),
      { analytics: customAnalytics(spy), captureCountry: true }
    )
    const event = spy.mock.calls[0]![0] as CaptureEvent
    expect(event.properties.country_code).toBe('NL')
  })

  it('emits decoded geo fields when captureGeo is true', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/page', {
        'user-agent': 'ClaudeBot',
        'x-vercel-ip-country-region': 'CA',
        'x-vercel-ip-city': 'San%20Francisco',
        'x-vercel-ip-latitude': '37.7749',
        'x-vercel-ip-longitude': '-122.4194',
        'x-vercel-ip-timezone': 'America/Los_Angeles'
      }),
      { analytics: customAnalytics(spy), captureGeo: true }
    )
    const event = spy.mock.calls[0]![0] as CaptureEvent
    expect(event.properties.region).toBe('CA')
    expect(event.properties.city).toBe('San Francisco')
    expect(event.properties.latitude).toBe('37.7749')
    expect(event.properties.longitude).toBe('-122.4194')
    expect(event.properties.timezone).toBe('America/Los_Angeles')
  })

  it('omits geo fields whose headers are missing', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/page', {
        'user-agent': 'ClaudeBot',
        'x-vercel-ip-city': 'Amsterdam'
      }),
      { analytics: customAnalytics(spy), captureGeo: true }
    )
    const event = spy.mock.calls[0]![0] as CaptureEvent
    expect(event.properties.city).toBe('Amsterdam')
    expect(event.properties).not.toHaveProperty('region')
    expect(event.properties).not.toHaveProperty('latitude')
    expect(event.properties).not.toHaveProperty('timezone')
  })

  it('omits geo fields when captureGeo is not set', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/page', {
        'user-agent': 'ClaudeBot',
        'x-vercel-ip-city': 'Amsterdam',
        'x-vercel-ip-timezone': 'Europe/Amsterdam'
      }),
      { analytics: customAnalytics(spy) }
    )
    const event = spy.mock.calls[0]![0] as CaptureEvent
    expect(event.properties).not.toHaveProperty('city')
    expect(event.properties).not.toHaveProperty('timezone')
  })

  it('falls back to cf-ipcountry for country_code', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/page', {
        'user-agent': 'ClaudeBot',
        'cf-ipcountry': 'US'
      }),
      { analytics: customAnalytics(spy), captureCountry: true }
    )
    const event = spy.mock.calls[0]![0] as CaptureEvent
    expect(event.properties.country_code).toBe('US')
  })

  it('emits client_ip when captureIp is true', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/page', {
        'user-agent': 'ClaudeBot',
        'x-forwarded-for': '203.0.113.1, 10.0.0.1'
      }),
      { analytics: customAnalytics(spy), captureIp: true }
    )
    const event = spy.mock.calls[0]![0] as CaptureEvent
    expect(event.properties.client_ip).toBe('203.0.113.1')
  })

  it('uses the first x-forwarded-for value when multiple are present', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/page', {
        'user-agent': 'ClaudeBot',
        'x-forwarded-for': '203.0.113.1, 10.0.0.1'
      }),
      { analytics: customAnalytics(spy) }
    )
    const a = spy.mock.calls[0]![0] as CaptureEvent
    const b = (
      await (async () => {
        const spy2 = vi.fn()
        await trackVisit(
          makeRequest('https://example.com/page', {
            'user-agent': 'ClaudeBot',
            'x-forwarded-for': '203.0.113.1, 10.0.0.2'
          }),
          { analytics: customAnalytics(spy2) }
        )
        return spy2.mock.calls[0]![0] as CaptureEvent
      })()
    )
    // Same first hop → same distinct id even with different trailing hops.
    expect(a.distinctId).toBe(b.distinctId)
  })
})

describe('trackVisit — injected verifier', () => {
  const CHATGPT_UA = 'Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)'
  const REAL_OPENAI_IP = '104.208.184.193'

  async function capture(headers: Record<string, string>, opts: Record<string, unknown> = {}) {
    const spy = vi.fn()
    await trackVisit(makeRequest('https://example.com/page', headers), {
      analytics: customAnalytics(spy),
      ...opts
    })
    return spy.mock.calls[0]![0] as CaptureEvent
  }

  it('omits the verification properties entirely when not opted in', () => {
    // Absent, not null — so existing dashboards don't gain a column of nulls.
    return capture({ 'user-agent': CHATGPT_UA, 'x-forwarded-for': REAL_OPENAI_IP }).then((e) => {
      expect('bot_verified' in e.properties).toBe(false)
      expect('bot_verification' in e.properties).toBe(false)
    })
  })

  it('marks a real crawler verified', async () => {
    const e = await capture(
      { 'user-agent': CHATGPT_UA, 'x-forwarded-for': REAL_OPENAI_IP },
      { verify: verifyRequest }
    )
    expect(e.properties.bot_verified).toBe(true)
    expect(e.properties.bot_verification).toBe('verified')
    expect(e.properties.bot_name).toBe('ChatGPT')
  })

  it('marks the same UA from another IP spoofed', async () => {
    const e = await capture(
      { 'user-agent': CHATGPT_UA, 'x-forwarded-for': '1.2.3.4' },
      { verify: verifyRequest }
    )
    expect(e.properties.bot_verified).toBe(false)
    expect(e.properties.bot_verification).toBe('spoofed')
    // Still labelled ChatGPT and still is_ai_bot — the verdict is the extra
    // dimension, it does not rewrite the classification.
    expect(e.properties.bot_name).toBe('ChatGPT')
    expect(e.properties.is_ai_bot).toBe(true)
  })

  it('uses the first x-forwarded-for hop, not a trailing proxy', async () => {
    const e = await capture(
      { 'user-agent': CHATGPT_UA, 'x-forwarded-for': `${REAL_OPENAI_IP}, 10.0.0.1` },
      { verify: verifyRequest }
    )
    expect(e.properties.bot_verification).toBe('verified')
  })

  it('reports unverifiable for vendors without a published feed', async () => {
    const e = await capture(
      { 'user-agent': 'Mozilla/5.0 (compatible; Bytespider/1.0)', 'x-forwarded-for': '1.2.3.4' },
      { verify: verifyRequest }
    )
    expect(e.properties.bot_verified).toBeNull()
    expect(e.properties.bot_verification).toBe('unverifiable')
  })
})

describe('trackVisit — error surfacing', () => {
  it('reports a non-2xx from the analytics backend instead of swallowing it', async () => {
    // A mistyped API key used to be indistinguishable from success. That is how
    // an integration stays broken for a week.
    const errors: Error[] = []
    const { posthogAnalytics } = await import('../src/adapters/posthog.js')
    await trackVisit(makeRequest('https://example.com/', { 'user-agent': 'ClaudeBot' }), {
      analytics: posthogAnalytics({
        apiKey: 'wrong',
        fetchImpl: async () => new Response('{"error":"invalid key"}', { status: 401 })
      }),
      onError: (e) => errors.push(e)
    })
    expect(errors).toHaveLength(1)
    expect(errors[0]!.name).toBe('CaptureTransportError')
    expect(errors[0]!.message).toContain('401')
  })

  it('still never throws into the response path', async () => {
    const boom = { capture: () => Promise.reject(new Error('backend down')) }
    // No onError supplied: must resolve quietly rather than reject.
    await expect(
      trackVisit(makeRequest('https://example.com/', { 'user-agent': 'ClaudeBot' }), {
        analytics: boom
      })
    ).resolves.toBeUndefined()
  })

  it('routes a thrown adapter error to onError', async () => {
    const errors: Error[] = []
    await trackVisit(makeRequest('https://example.com/', { 'user-agent': 'ClaudeBot' }), {
      analytics: { capture: () => Promise.reject(new Error('backend down')) },
      onError: (e) => errors.push(e)
    })
    expect(errors[0]?.message).toBe('backend down')
  })

  it('passes an abort signal so a hung backend cannot pend forever', async () => {
    let sawSignal = false
    const { posthogAnalytics } = await import('../src/adapters/posthog.js')
    await trackVisit(makeRequest('https://example.com/', { 'user-agent': 'ClaudeBot' }), {
      analytics: posthogAnalytics({
        apiKey: 'k',
        fetchImpl: (_u, init) => {
          sawSignal = !!init?.signal
          return Promise.resolve(new Response('ok'))
        }
      })
    })
    expect(sawSignal).toBe(true)
  })
})

describe('trackVisit — identifier', () => {
  it('is stable for a fixed secret and changes when the secret rotates', async () => {
    const cap = async (idSecret: string) => {
      const spy = vi.fn()
      await trackVisit(
        makeRequest('https://example.com/', {
          'user-agent': 'ClaudeBot',
          'x-forwarded-for': '1.2.3.4'
        }),
        { analytics: customAnalytics(spy), idSecret }
      )
      return (spy.mock.calls[0]![0] as CaptureEvent).distinctId
    }
    expect(await cap('secret-a')).toBe(await cap('secret-a'))
    expect(await cap('secret-a')).not.toBe(await cap('secret-b'))
    expect(await cap('secret-a')).toMatch(/^anon_[0-9a-f]{16}$/)
  })

  it('never emits the raw IP unless captureIp is set', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/', {
        'user-agent': 'ClaudeBot',
        'x-forwarded-for': '203.0.113.9'
      }),
      { analytics: customAnalytics(spy), idSecret: 's' }
    )
    const e = spy.mock.calls[0]![0] as CaptureEvent
    expect(JSON.stringify(e)).not.toContain('203.0.113.9')
  })
})

describe('trackVisit — headless fields', () => {
  async function capture(ua: string) {
    const spy = vi.fn()
    await trackVisit(makeRequest('https://example.com/', { 'user-agent': ua }), {
      analytics: customAnalytics(spy),
      idSecret: 's'
    })
    return (spy.mock.calls[0]![0] as CaptureEvent).properties
  }

  it('omits headless fields for declared crawlers, where they are noise', async () => {
    // Measured true on 99% of captured events, which made the property read as
    // signal when it carried none.
    const p = await capture('Mozilla/5.0 (compatible; ClaudeBot/1.0)')
    expect('headless_likely' in p).toBe(false)
    expect('headless_score' in p).toBe(false)
  })

  it('keeps them for browser-shaped UAs, where they discriminate', async () => {
    const p = await capture(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    )
    expect('headless_likely' in p).toBe(true)
  })

  it('labels headless automation as Headless, not Browser', async () => {
    // 79% of one production site's agent traffic carried a browser UA with
    // headless headers. Calling it 'Browser' hid it behind the obvious
    // `bot_name != 'Browser'` filter.
    const p = await capture(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    )
    expect(p.ua_category).toBe('headless-likely')
    expect(p.bot_name).toBe('Headless')
  })
})
