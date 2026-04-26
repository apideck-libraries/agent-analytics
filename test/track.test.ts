import { describe, expect, it, vi } from 'vitest'
import { customAnalytics } from '../src/adapters/custom.js'
import { trackVisit } from '../src/track.js'
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

  it('lets user-supplied properties override built-in event properties', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/original', { 'user-agent': 'ClaudeBot' }),
      {
        analytics: customAnalytics(spy),
        properties: { path: '/overridden', site: 'docs', is_ai_bot: 'custom' }
      }
    )
    const event = spy.mock.calls[0]![0] as CaptureEvent
    expect(event.properties.path).toBe('/overridden')
    expect(event.properties.site).toBe('docs')
    expect(event.properties.is_ai_bot).toBe('custom')
    // Unrelated built-ins still present.
    expect(event.properties.bot_name).toBe('Claude')
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

  it('captures method, country_code, and omits client_ip by default', async () => {
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
    expect(event.properties.country_code).toBe('NL')
    expect(event.properties).not.toHaveProperty('client_ip')
  })

  it('falls back to cf-ipcountry for country_code', async () => {
    const spy = vi.fn()
    await trackVisit(
      makeRequest('https://example.com/page', {
        'user-agent': 'ClaudeBot',
        'cf-ipcountry': 'US'
      }),
      { analytics: customAnalytics(spy) }
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
