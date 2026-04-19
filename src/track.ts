import { isAiBot, AI_BOT_PATTERN, parseBotName } from './bots.js'
import { hashId } from './hash.js'
import type { TrackDocViewOptions } from './types.js'

/**
 * Capture an event describing the incoming request. Fire-and-forget: awaits
 * the adapter but swallows errors so a downed analytics backend never breaks
 * the response path. Callers typically don't await the returned promise.
 *
 * When `onlyBots` is true (the default), skips capture unless the UA matches
 * {@link AI_BOT_PATTERN}. Set `onlyBots: false` to track every visit.
 */
export async function trackDocView(
  req: Request,
  opts: TrackDocViewOptions
): Promise<void> {
  const userAgent = req.headers.get('user-agent') || ''

  const onlyBots = opts.onlyBots ?? true
  if (onlyBots && !isAiBot(userAgent)) return

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

  const event = {
    event: opts.eventName ?? 'doc_view',
    distinctId: hashId(`${ip}:${userAgent}`),
    timestamp: new Date().toISOString(),
    properties: {
      $process_person_profile: false,
      $current_url: origin ? `${origin}${pathname}` : pathname,
      path: pathname,
      user_agent: userAgent,
      is_ai_bot: AI_BOT_PATTERN.test(userAgent),
      bot_name: parseBotName(userAgent),
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
