import type { AnalyticsAdapter, CaptureEvent } from '../types.js'

export interface WebhookAdapterConfig {
  /** Destination URL that receives a POST for each event. */
  url: string
  /** Extra headers merged onto the POST (useful for shared-secret auth). */
  headers?: Record<string, string>
  /**
   * Transform the event into the exact JSON body the destination expects.
   * Defaults to sending the {@link CaptureEvent} as-is.
   */
  transform?: (event: CaptureEvent) => unknown
  /** Override the `fetch` implementation. */
  fetchImpl?: typeof fetch
}

/**
 * Adapter that POSTs each event to an arbitrary webhook URL. Keeps the
 * library analytics-backend-agnostic — use this when PostHog isn't your
 * analytics of record, or when you want to multiplex events through your
 * own ingestion layer.
 */
export function webhookAnalytics(config: WebhookAdapterConfig): AnalyticsAdapter {
  const fetchImpl = config.fetchImpl ?? fetch
  const transform = config.transform ?? ((e: CaptureEvent): unknown => e)

  return {
    async capture(event: CaptureEvent): Promise<void> {
      await fetchImpl(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.headers ?? {})
        },
        body: JSON.stringify(transform(event)),
        keepalive: true
      })
    }
  }
}
