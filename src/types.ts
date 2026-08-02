export interface CaptureEvent {
  event: string
  distinctId: string
  timestamp: string
  properties: Record<string, unknown>
}

export interface AnalyticsAdapter {
  capture(event: CaptureEvent): Promise<void> | void
}

export interface BotVerificationLike {
  verdict: string
  verified: boolean | null
  reason?: string
}

export interface TrackVisitOptions {
  analytics: AnalyticsAdapter
  /**
   * Secret used to key the `distinctId` HMAC. Falls back to
   * `AGENT_ANALYTICS_ID_SECRET`, then to a random per-instance value.
   *
   * Identifiers only correlate across instances and deploys when this is
   * stable, and only stay non-reversible while it stays secret — the user agent
   * ships in plaintext on the same event, so anyone holding the secret can
   * recover the client IP by brute force.
   */
  idSecret?: string
  /**
   * Called when capture fails — a rejected adapter, a non-2xx from the
   * analytics backend, a malformed request. Errors never propagate to the
   * response path, so without this a wrong API key is silent.
   */
  onError?: (error: Error) => void
  /**
   * Identity verifier. Import `verifyRequest` from
   * `@apideck/agent-analytics/verify` and pass it here to add
   * `bot_verification` to the event.
   *
   * Injected rather than imported so the published IP range tables — the
   * largest thing in the package — only reach bundles that use them.
   */
  verify?: (req: Request) => BotVerificationLike
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
  /**
   * When `true`, check the request's claimed crawler identity against the
   * vendor's published IP ranges and emit `bot_verified` (tri-state) plus
   * `bot_verification` (`verified` | `spoofed` | `unverifiable` |
   * `not-claimed`) on the event.
   *
   * UA strings are trivially forgeable — `curl -A "ChatGPT-User"` is
   * indistinguishable from the real thing without this check. Off by default
   * because it only means something when the client IP is trustworthy: on
   * Vercel and Cloudflare the edge overwrites `x-forwarded-for`, but behind a
   * proxy that passes the client-supplied header through, an attacker controls
   * the value and a `verified` verdict is worthless.
   *
   * Only vendors that publish a machine-readable range feed can be verified —
   * currently OpenAI, Anthropic, Perplexity, and Apple. Everything else yields
   * `unverifiable`, never `spoofed`.
   */
  /**
   * When `true`, emit `region`, `city`, `latitude`, `longitude`, and
   * `timezone` derived from Vercel's `x-vercel-ip-*` edge headers. Values
   * are URL-decoded (Vercel encodes city/region, e.g. `San%20Francisco`).
   * Missing headers are omitted rather than emitted as empty strings.
   *
   * Off by default — geo at city resolution is more identifying than country
   * alone. Pair with `captureCountry` for a full Peec.ai-style export.
   */
  captureGeo?: boolean
}
