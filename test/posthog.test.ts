import { describe, expect, it, vi } from 'vitest'
import { posthogAnalytics } from '../src/adapters/posthog.js'

function okFetch() {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ status: 'Ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
  )
}

describe('posthogAnalytics', () => {
  it('posts to the default US endpoint', async () => {
    const fetchImpl = okFetch()
    const analytics = posthogAnalytics({ apiKey: 'phc_test', fetchImpl })
    await analytics.capture({
      event: 'doc_view',
      distinctId: 'anon_deadbeef',
      timestamp: '2026-01-01T00:00:00.000Z',
      properties: { path: '/foo', source: 'md-suffix' }
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const call = fetchImpl.mock.calls[0]!
    const url = call[0]
    const init = call[1]!
    expect(url).toBe('https://us.i.posthog.com/i/v0/e/')
    expect(init).toMatchObject({ method: 'POST', keepalive: true })
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({
      api_key: 'phc_test',
      event: 'doc_view',
      distinct_id: 'anon_deadbeef',
      properties: { path: '/foo', source: 'md-suffix' }
    })
  })

  it('normalizes host with or without scheme and strips trailing slash', async () => {
    const fetchImpl = okFetch()
    const analytics = posthogAnalytics({
      apiKey: 'k',
      host: 'eu.i.posthog.com/',
      fetchImpl
    })
    await analytics.capture({
      event: 'doc_view',
      distinctId: 'id',
      timestamp: 't',
      properties: {}
    })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://eu.i.posthog.com/i/v0/e/')
  })

  it('respects a reverse-proxy host with explicit scheme', async () => {
    const fetchImpl = okFetch()
    const analytics = posthogAnalytics({
      apiKey: 'k',
      host: 'https://svc.example.com',
      fetchImpl
    })
    await analytics.capture({
      event: 'doc_view',
      distinctId: 'id',
      timestamp: 't',
      properties: {}
    })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://svc.example.com/i/v0/e/')
  })

  it('lets callers override the capture path', async () => {
    const fetchImpl = okFetch()
    const analytics = posthogAnalytics({
      apiKey: 'k',
      host: 'https://svc.example.com',
      path: '/batch',
      fetchImpl
    })
    await analytics.capture({
      event: 'doc_view',
      distinctId: 'id',
      timestamp: 't',
      properties: {}
    })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://svc.example.com/batch')
  })

  it('prepends a leading slash if the path is given without one', async () => {
    const fetchImpl = okFetch()
    const analytics = posthogAnalytics({
      apiKey: 'k',
      host: 'https://svc.example.com',
      path: 'batch',
      fetchImpl
    })
    await analytics.capture({
      event: 'doc_view',
      distinctId: 'id',
      timestamp: 't',
      properties: {}
    })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://svc.example.com/batch')
  })

  it('sets Content-Type: application/json and keepalive: true', async () => {
    const fetchImpl = okFetch()
    const analytics = posthogAnalytics({ apiKey: 'k', fetchImpl })
    await analytics.capture({
      event: 'doc_view',
      distinctId: 'id',
      timestamp: 't',
      properties: {}
    })
    const init = fetchImpl.mock.calls[0]![1]!
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(init.keepalive).toBe(true)
  })

  it('passes the event timestamp through unchanged', async () => {
    const fetchImpl = okFetch()
    const analytics = posthogAnalytics({ apiKey: 'k', fetchImpl })
    await analytics.capture({
      event: 'doc_view',
      distinctId: 'id',
      timestamp: '2026-04-21T12:34:56.000Z',
      properties: {}
    })
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)
    expect(body.timestamp).toBe('2026-04-21T12:34:56.000Z')
  })

  it('surfaces fetch errors so trackVisit can swallow them at the boundary', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('network down')
    })
    const analytics = posthogAnalytics({ apiKey: 'k', fetchImpl })
    await expect(
      analytics.capture({ event: 'doc_view', distinctId: 'id', timestamp: 't', properties: {} })
    ).rejects.toThrow('network down')
  })
})
