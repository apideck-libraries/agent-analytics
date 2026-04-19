import { describe, expect, it, vi } from 'vitest'
import { customAnalytics } from '../src/adapters/custom.js'
import { trackDocView } from '../src/track.js'
import type { CaptureEvent } from '../src/types.js'

function makeRequest(
  url: string,
  headers: Record<string, string> = {}
): Request {
  return new Request(url, { headers })
}

describe('trackDocView', () => {
  it('captures when the UA is a known AI bot', async () => {
    const captured: CaptureEvent[] = []
    const analytics = customAnalytics((e) => {
      captured.push(e)
    })

    await trackDocView(
      makeRequest('https://example.com/docs/intro', {
        'user-agent': 'ClaudeBot/1.0',
        'x-forwarded-for': '1.2.3.4',
        referer: 'https://claude.ai/'
      }),
      { analytics, source: 'ua-rewrite', properties: { site: 'docs' } }
    )

    expect(captured).toHaveLength(1)
    const event = captured[0]!
    expect(event.event).toBe('doc_view')
    expect(event.distinctId).toMatch(/^anon_[0-9a-f]+$/)
    expect(event.properties).toMatchObject({
      $current_url: 'https://example.com/docs/intro',
      path: '/docs/intro',
      user_agent: 'ClaudeBot/1.0',
      is_ai_bot: true,
      bot_name: 'Claude',
      referer: 'https://claude.ai/',
      source: 'ua-rewrite',
      site: 'docs'
    })
  })

  it('sets bot_name to Browser for human traffic when onlyBots is false', async () => {
    const spy = vi.fn()
    await trackDocView(
      makeRequest('https://example.com/page', {
        'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/120'
      }),
      { analytics: customAnalytics(spy), onlyBots: false }
    )
    const event = spy.mock.calls[0]![0] as CaptureEvent
    expect(event.properties.is_ai_bot).toBe(false)
    expect(event.properties.bot_name).toBe('Browser')
  })

  it('skips capture when UA is not a bot and onlyBots is on (default)', async () => {
    const spy = vi.fn()
    await trackDocView(
      makeRequest('https://example.com/page', {
        'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/120'
      }),
      { analytics: customAnalytics(spy) }
    )
    expect(spy).not.toHaveBeenCalled()
  })

  it('captures every request when onlyBots is false', async () => {
    const spy = vi.fn()
    await trackDocView(
      makeRequest('https://example.com/page', {
        'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/120'
      }),
      { analytics: customAnalytics(spy), onlyBots: false }
    )
    expect(spy).toHaveBeenCalledOnce()
    const event = spy.mock.calls[0]![0] as CaptureEvent
    expect(event.properties.is_ai_bot).toBe(false)
  })

  it('honours a custom event name', async () => {
    const spy = vi.fn()
    await trackDocView(
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
      trackDocView(
        makeRequest('https://example.com/page', { 'user-agent': 'ClaudeBot' }),
        { analytics }
      )
    ).resolves.toBeUndefined()
  })

  it('uses the first x-forwarded-for value when multiple are present', async () => {
    const spy = vi.fn()
    await trackDocView(
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
        await trackDocView(
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
