export interface CaptureEvent {
  event: string
  distinctId: string
  timestamp: string
  properties: Record<string, unknown>
}

export interface AnalyticsAdapter {
  capture(event: CaptureEvent): Promise<void> | void
}

export interface TrackVisitOptions {
  analytics: AnalyticsAdapter
  /**
   * Label describing how the request arrived (e.g. `'page-view'`, `'md-suffix'`,
   * `'ua-rewrite'`). Emitted as a `source` property on the captured event so
   * you can segment by channel.
   */
  source?: string
  /**
   * Event name. Defaults to `'doc_view'`.
   */
  eventName?: string
  /**
   * When `true` (default), skip capture unless the request UA matches the
   * built-in AI bot pattern. Set to `false` to capture every request.
   */
  onlyBots?: boolean
  /**
   * Extra properties merged into the captured event. Useful for tagging the
   * site (`{ site: 'docs' }`) or any other dimension.
   */
  properties?: Record<string, unknown>
  /**
   * Override the origin used for `$current_url`. Defaults to the request URL's
   * origin.
   */
  origin?: string
}
