import { describe, expect, it, vi } from 'vitest'
import { customAnalytics } from '../src/adapters/custom.js'
import type { CaptureEvent } from '../src/types.js'

const event: CaptureEvent = {
  event: 'doc_view',
  distinctId: 'anon_x',
  timestamp: '2026-04-21T00:00:00.000Z',
  properties: {}
}

describe('customAnalytics', () => {
  it('passes the event straight through to the callback', async () => {
    const spy = vi.fn()
    const analytics = customAnalytics(spy)
    await analytics.capture(event)
    expect(spy).toHaveBeenCalledWith(event)
  })

  it('awaits async callbacks', async () => {
    const seen: string[] = []
    const analytics = customAnalytics(async (e) => {
      await new Promise((r) => setTimeout(r, 1))
      seen.push(e.event)
    })
    await analytics.capture(event)
    expect(seen).toEqual(['doc_view'])
  })

  it('surfaces callback errors', async () => {
    const analytics = customAnalytics(() => {
      throw new Error('boom')
    })
    expect(() => analytics.capture(event)).toThrow('boom')
  })
})
