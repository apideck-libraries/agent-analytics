import { classifyRequest, detectHeadless, isAiBot, isHttpClient } from './bots.js'
import { hashId } from './hash.js'
import type { TrackVisitOptions } from './types.js'

/**
 * Capture an event describing the incoming request. Fire-and-forget: awaits
 * the adapter but swallows errors so a downed analytics backend never breaks
 * the response path. Callers typically don't await the returned promise.
 *
 * By default, captures every request so coding-agent traffic (axios, curl,
 * Electron, …) shows up alongside branded crawlers. Set `onlyBots: true` to
 * restrict capture to UAs matching {@link AI_BOT_PATTERN}.
 */
export async function trackVisit(
  req: Request,
  opts: TrackVisitOptions
): Promise<void> {
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
  const country =
    req.headers.get('x-vercel-ip-country') ||
    req.headers.get('cf-ipcountry') ||
    req.headers.get('x-country-code') ||
    null
  const classification = classifyRequest(req)

  const event = {
    event: opts.eventName ?? 'agent_visit',
    distinctId: hashId(`${ip}:${userAgent}`),
    timestamp: new Date().toISOString(),
    properties: {
      $process_person_profile: false,
      $current_url: origin ? `${origin}${pathname}` : pathname,
      path: pathname,
      method: req.method,
      country_code: country,
      ...(opts.captureIp ? { client_ip: ip || null } : {}),
      user_agent: userAgent,
      is_ai_bot: classification.isAiBot,
      bot_name: classification.label,
      ua_category: classification.kind,
      coding_agent_hint: classification.codingAgentHint,
      headless_score: classification.headless?.score ?? 0,
      headless_likely: classification.headless?.likely ?? false,
      referer,
      source: opts.source ?? null,
      ...opts.properties
    }
  }

  try {
    await opts.analytics.capture(event)
  } catch {
    // Intentional swallow — analytics failures must not affect the response.
  }
}
