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
   * When `true`, skip capture unless the request UA matches the built-in AI
   * bot pattern. Defaults to `false`, which captures every request (including
   * coding-agent traffic that uses HTTP-library UAs like axios or curl).
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
