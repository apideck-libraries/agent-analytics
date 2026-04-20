import { describe, expect, it, vi } from 'vitest'
import { webhookAnalytics } from '../src/adapters/webhook.js'
import type { CaptureEvent } from '../src/types.js'

function okFetch() {
  return vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
}

const sampleEvent: CaptureEvent = {
  event: 'doc_view',
  distinctId: 'anon_abc',
  timestamp: '2026-04-21T00:00:00.000Z',
  properties: { path: '/docs', source: 'ua-rewrite' }
}

describe('webhookAnalytics', () => {
  it('POSTs the event as JSON with keepalive', async () => {
    const fetchImpl = okFetch()
    const analytics = webhookAnalytics({ url: 'https://example.com/hook', fetchImpl })
    await analytics.capture(sampleEvent)

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://example.com/hook')
    expect(init).toMatchObject({ method: 'POST', keepalive: true })
    expect((init!.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(init!.body as string)).toEqual(sampleEvent)
  })

  it('merges extra headers onto the request', async () => {
    const fetchImpl = okFetch()
    const analytics = webhookAnalytics({
      url: 'https://example.com/hook',
      headers: { Authorization: 'Bearer secret', 'x-site': 'docs' },
      fetchImpl
    })
    await analytics.capture(sampleEvent)
    const headers = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer secret')
    expect(headers['x-site']).toBe('docs')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('lets user headers override Content-Type', async () => {
    const fetchImpl = okFetch()
    const analytics = webhookAnalytics({
      url: 'https://example.com/hook',
      headers: { 'Content-Type': 'application/x-ndjson' },
      fetchImpl
    })
    await analytics.capture(sampleEvent)
    const headers = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/x-ndjson')
  })

  it('runs the transform hook to shape the payload', async () => {
    const fetchImpl = okFetch()
    const analytics = webhookAnalytics({
      url: 'https://example.com/hook',
      transform: (e) => ({ type: e.event, id: e.distinctId, at: e.timestamp }),
      fetchImpl
    })
    await analytics.capture(sampleEvent)
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)
    expect(body).toEqual({ type: 'doc_view', id: 'anon_abc', at: '2026-04-21T00:00:00.000Z' })
  })

  it('falls back to global fetch when fetchImpl is omitted', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    try {
      const analytics = webhookAnalytics({ url: 'https://example.com/hook' })
      await analytics.capture(sampleEvent)
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      spy.mockRestore()
    }
  })

  it('surfaces fetch errors to the caller (trackVisit is what swallows them)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('destination offline')
    })
    const analytics = webhookAnalytics({ url: 'https://example.com/hook', fetchImpl })
    await expect(analytics.capture(sampleEvent)).rejects.toThrow('destination offline')
  })
})
