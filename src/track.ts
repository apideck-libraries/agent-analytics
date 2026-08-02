import { classifyRequest, detectHeadless, isAiBot, isHttpClient } from './bots.js'
import { hashId, randomSecret } from './hash.js'
import type { TrackVisitOptions } from './types.js'

/**
 * Fallback secret, generated once per instance. Keeps the default path
 * privacy-preserving rather than making callers opt in to safety, at the cost
 * of identifiers that only correlate within one instance's lifetime.
 */
let fallbackSecret: string | undefined
let warnedNoSecret = false

function resolveSecret(explicit: string | undefined): string {
  if (explicit) return explicit
  const fromEnv =
    typeof process !== 'undefined' ? process.env?.AGENT_ANALYTICS_ID_SECRET : undefined
  if (fromEnv) return fromEnv
  if (!fallbackSecret) {
    fallbackSecret = randomSecret()
    if (!warnedNoSecret) {
      warnedNoSecret = true
      // Once per instance, not once per request.
      console.warn(
        '[agent-analytics] No idSecret or AGENT_ANALYTICS_ID_SECRET set. ' +
          'Using a per-instance random secret: distinctIds will not correlate ' +
          'across instances or deploys.'
      )
    }
  }
  return fallbackSecret
}

/**
 * Capture an event describing the incoming request. Fire-and-forget: awaits the
 * adapter but routes errors to {@link TrackVisitOptions.onError} rather than
 * letting them reach the response path. Callers typically don't await it.
 *
 * By default, captures every request so coding-agent traffic (axios, curl,
 * Electron, …) shows up alongside branded crawlers. Set `onlyBots: true` to
 * restrict capture to UAs matching {@link AI_BOT_PATTERN}.
 */
export async function trackVisit(req: Request, opts: TrackVisitOptions): Promise<void> {
  const userAgent = req.headers.get('user-agent') || ''

  const onlyBots = opts.onlyBots ?? false
  const skipBrowsers = opts.skipBrowsers ?? false
  if (onlyBots && !isAiBot(userAgent)) return
  if (skipBrowsers && !isAiBot(userAgent) && !isHttpClient(userAgent)) {
    // Not a declared bot or HTTP client — check headless heuristics.
    // Playwright-based agents (Aider, OpenCode) will pass if they're missing
    // standard browser headers. Real browsers get skipped.
    if (!detectHeadless(req).likely) return
  }

  try {
    let pathname = '/'
    let originFromUrl = ''
    try {
      const url = new URL(req.url)
      pathname = url.pathname
      originFromUrl = url.origin
    } catch {
      // Some runtimes hand us a relative URL; fall back to the raw string.
      pathname = req.url || '/'
    }
    const origin = opts.origin ?? originFromUrl

    const forwardedFor = req.headers.get('x-forwarded-for') || ''
    const ip = forwardedFor.split(',')[0]?.trim() ?? ''
    const referer = req.headers.get('referer')
    const country = opts.captureCountry
      ? req.headers.get('x-vercel-ip-country') ||
        req.headers.get('cf-ipcountry') ||
        req.headers.get('x-country-code') ||
        null
      : null
    const geo = opts.captureGeo ? extractGeo(req) : null
    const classification = classifyRequest(req)

    // Verification is injected rather than imported, so the published IP range
    // tables only reach bundles that actually use them. Import `verifyRequest`
    // from `@apideck/agent-analytics/verify` and pass it as `verify`.
    // May be async: Web Bot Auth fetches a signer's key directory on first
    // sight of that origin, then serves from cache.
    const verification = opts.verify ? await opts.verify(req) : null

    // Headless scoring only discriminates for browser-shaped UAs. On a declared
    // crawler or an HTTP client it fires on nearly everything — measured true on
    // 99% of captured events — so it reads as signal when it is noise. Omitted
    // rather than emitted as a near-constant.
    const headlessMeaningful =
      classification.kind === 'headless-likely' || classification.kind === 'browser'

    const distinctId = await hashId(`${ip}:${userAgent}`, resolveSecret(opts.idSecret))

    const event = {
      event: opts.eventName ?? 'agent_visit',
      distinctId,
      timestamp: new Date().toISOString(),
      properties: {
        // Caller properties are spread FIRST so library-computed fields always
        // win. Spreading them last let a colliding key silently overwrite
        // bot_name or is_ai_bot — corrupting the very classification they were
        // meant to annotate.
        ...opts.properties,
        $process_person_profile: false,
        $current_url: origin ? `${origin}${pathname}` : pathname,
        path: pathname,
        method: req.method,
        ...(opts.captureCountry ? { country_code: country } : {}),
        ...(geo ?? {}),
        ...(opts.captureIp ? { client_ip: ip || null } : {}),
        user_agent: userAgent,
        is_ai_bot: classification.isAiBot,
        bot_name: classification.label,
        ua_category: classification.kind,
        coding_agent_hint: classification.codingAgentHint,
        ...(headlessMeaningful
          ? {
              headless_score: classification.headless?.score ?? 0,
              headless_likely: classification.headless?.likely ?? false
            }
          : {}),
        ...(verification
          ? {
              bot_verified: verification.verified,
              bot_verification: verification.verdict,
              ...(verification.reason ? { bot_verification_reason: verification.reason } : {})
            }
          : {}),
        referer,
        source: opts.source ?? null
      }
    }

    await opts.analytics.capture(event)
  } catch (err) {
    // Analytics must never affect the response — but silence is how a wrong API
    // key goes unnoticed for a week, so surface it when the caller asks.
    opts.onError?.(err instanceof Error ? err : new Error(String(err)))
  }
}

// Vercel edge URL-encodes city/region (e.g. `San%20Francisco`); decode so
// downstream consumers don't have to. Numeric fields (lat/lng) and timezone
// pass through untouched. Headers without a value are dropped rather than
// emitted as empty strings.
function extractGeo(req: Request): Record<string, string> {
  const decode = (v: string | null) => {
    if (!v) return ''
    try {
      return decodeURIComponent(v)
    } catch {
      return v
    }
  }
  const fields: Array<[string, string]> = [
    ['region', decode(req.headers.get('x-vercel-ip-country-region'))],
    ['city', decode(req.headers.get('x-vercel-ip-city'))],
    ['latitude', req.headers.get('x-vercel-ip-latitude') ?? ''],
    ['longitude', req.headers.get('x-vercel-ip-longitude') ?? ''],
    ['timezone', req.headers.get('x-vercel-ip-timezone') ?? '']
  ]
  const out: Record<string, string> = {}
  for (const [k, v] of fields) if (v) out[k] = v
  return out
}
