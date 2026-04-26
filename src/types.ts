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
   * Event name. Defaults to `'agent_visit'`.
   */
  eventName?: string
  /**
   * When `true`, skip capture unless the request UA matches the built-in AI
   * bot pattern. Defaults to `false`, which captures every request (including
   * coding-agent traffic that uses HTTP-library UAs like axios or curl).
   */
  onlyBots?: boolean
  /**
   * When `true`, capture AI bots and coding agents (HTTP clients like axios,
   * curl, node-fetch) but skip regular browsers. Use this when client-side
   * analytics already handles browser traffic. Defaults to `false`.
   */
  skipBrowsers?: boolean
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
  /**
   * When `true`, emit the raw `client_ip` (first hop of `x-forwarded-for`) on
   * the event. Off by default — the IP is always hashed into `distinctId`,
   * but the raw value is only useful for log-style exports (e.g. Peec.ai's
   * crawl-insights CSV) and carries privacy implications.
   */
  captureIp?: boolean
  /**
   * When `true`, emit `country_code` derived from `x-vercel-ip-country`,
   * `cf-ipcountry`, or `x-country-code`. Off by default to keep the event
   * payload PII-free — coarse country is low-risk but still user-derived.
   * Enable for log-style exports (e.g. Peec.ai's crawl-insights CSV).
   */
  captureCountry?: boolean
}
