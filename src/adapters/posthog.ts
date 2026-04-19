import type { AnalyticsAdapter, CaptureEvent } from '../types.js'

export interface PostHogAdapterConfig {
  /** PostHog project API key (the public one used by the JS SDK). */
  apiKey: string
  /**
   * PostHog host, with or without scheme. Defaults to `https://us.i.posthog.com`.
   * Use `https://eu.i.posthog.com` for EU cloud, or your own reverse-proxy
   * domain (e.g. `https://svc.example.com`).
   */
  host?: string
  /**
   * Path on the host that accepts single-event captures. Defaults to
   * `/i/v0/e/` which is PostHog's current endpoint for this.
   */
  path?: string
  /**
   * Override the `fetch` implementation (useful for tests or custom runtimes
   * that need a pinned fetch).
   */
  fetchImpl?: typeof fetch
}

/**
 * Adapter that posts each event to the PostHog capture endpoint. Uses
 * `keepalive: true` so the request survives after a serverless response
 * returns — events aren't guaranteed (fire-and-forget), but that's the
 * trade we want to keep the hot path fast.
 */
export function posthogAnalytics(config: PostHogAdapterConfig): AnalyticsAdapter {
  const hostRaw = config.host ?? 'https://us.i.posthog.com'
  const base = (/^https?:\/\//.test(hostRaw) ? hostRaw : `https://${hostRaw}`).replace(/\/$/, '')
  const path = (config.path ?? '/i/v0/e/').replace(/^(?!\/)/, '/')
  const endpoint = `${base}${path}`
  const fetchImpl = config.fetchImpl ?? fetch

  return {
    async capture(event: CaptureEvent): Promise<void> {
      const payload = {
        api_key: config.apiKey,
        event: event.event,
        distinct_id: event.distinctId,
        timestamp: event.timestamp,
        properties: event.properties
      }
      await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      })
    }
  }
}
