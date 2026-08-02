import type { AnalyticsAdapter, CaptureEvent } from '../types.js'
import { CaptureTransportError } from '../errors.js'


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
  /**
   * Abort the capture after this many milliseconds. Defaults to 3000. Without
   * a bound, a hung backend leaves a pending promise for the lifetime of an
   * edge invocation.
   */
  timeoutMs?: number
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
      // A 401 from a mistyped key used to look identical to success. Surface
      // it: `trackVisit` routes it to `onError` and still never throws into
      // the response path.
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
        signal: AbortSignal.timeout(config.timeoutMs ?? 3000)
      })
      if (!res.ok) {
        throw new CaptureTransportError(
          `PostHog capture failed: ${res.status} ${res.statusText}`,
          res.status,
          await res.text().catch(() => undefined)
        )
      }
    }
  }
}
