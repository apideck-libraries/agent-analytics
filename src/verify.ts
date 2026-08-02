import { parseBotName } from './bots.js'
import { BOT_IP_RANGES, VERIFIABLE_VENDORS } from './bot-ranges.js'
import { compileRanges, ipInRanges, type CompiledRanges } from './cidr.js'

/**
 * Verdict on whether a request's claimed crawler identity holds up against the
 * vendor's published IP ranges.
 *
 * - `'verified'` — the UA claims a vendor we can check, and the client IP is
 *   inside that vendor's published ranges. High confidence.
 * - `'spoofed'` — the UA claims a vendor we can check, and the IP is **not**
 *   in its ranges. Someone is impersonating the crawler.
 * - `'unverifiable'` — the UA claims a vendor that publishes no feed we bundle
 *   (Bytespider, Amazon, Meta, …), or no usable client IP was available.
 * - `'not-claimed'` — the UA doesn't claim a verifiable crawler at all. This is
 *   the normal verdict for browsers and HTTP clients; it is *not* a negative
 *   finding.
 */
export type VerificationVerdict = 'verified' | 'spoofed' | 'unverifiable' | 'not-claimed'

/** Why a request could not be judged. Only set when verdict is 'unverifiable'. */
export type UnverifiableReason = 'no-published-ranges' | 'client-side-agent' | 'no-client-ip'

export interface BotVerification {
  verdict: VerificationVerdict
  reason?: UnverifiableReason
  /** Vendor label the UA claims, when it claims one. */
  claimed: string | null
  /**
   * Convenience boolean for filtering: `true` only for `'verified'`, `false`
   * only for `'spoofed'`, `null` when no judgement was possible. Deliberately
   * tri-state — collapsing "unverifiable" into `false` would brand every
   * Bytespider and Amazonbot hit an impostor.
   */
  verified: boolean | null
}

/**
 * Products that fetch from the **end user's own device**, not from the
 * vendor's infrastructure.
 *
 * A published range list only covers a vendor's server-side crawler fleet.
 * When the fetch originates on a developer's laptop, the client IP is theirs
 * and will never appear in the vendor's ranges — so a range check produces
 * 'spoofed' for entirely legitimate traffic.
 *
 * This is not cosmetic. Measured against 30 days of production data:
 *
 *   Claude-User (claude-code CLI)   6,492 events   4,486 IPs   0% in range
 *   Perplexity-User                   493 events     148 IPs   0% in range
 *   ClaudeBot                      13,671 events     236 IPs  96% in range
 *   PerplexityBot                   6,897 events     158 IPs  91% in range
 *
 * Treating the first two as impostors would have falsely accused ~7k real
 * fetches a month. The distinction is per *product*, not per vendor, and not
 * inferable from a `-User` suffix — OpenAI's ChatGPT-User fetches server-side
 * from Azure and verifies at ~99%.
 */
const CLIENT_SIDE_AGENT_PATTERN = /claude-code|perplexity-user|cursor|windsurf|cline|aider/i

/**
 * Products known to fetch server-side from ranges the vendor publishes. Only
 * these can earn a 'verified' or 'spoofed' verdict; anything else is reported
 * 'unverifiable' so the data never overstates what was actually checked.
 */
const SERVER_SIDE_CRAWLER_PATTERN =
  /ClaudeBot|Claude-SearchBot|GPTBot|OAI-SearchBot|ChatGPT-User|PerplexityBot|Applebot/i

// Compile each vendor's ranges once at module load rather than per request.
const COMPILED: Record<string, CompiledRanges> = {}
for (const vendor of VERIFIABLE_VENDORS) {
  COMPILED[vendor] = compileRanges(BOT_IP_RANGES[vendor] ?? [])
}

/** Vendor labels this build can produce a verified/spoofed verdict for. */
export function verifiableVendors(): readonly string[] {
  return VERIFIABLE_VENDORS
}

/**
 * Check a claimed crawler identity against the vendor's published IP ranges.
 *
 * Pass the client IP you already trust — on Vercel and Cloudflare that is the
 * first hop of `x-forwarded-for`. If your edge doesn't strip client-supplied
 * `X-Forwarded-For`, an attacker controls this value and a `'verified'` verdict
 * means nothing; verify your proxy's behaviour before relying on it.
 */
export function verifyBotIdentity(
  userAgent: string | null | undefined,
  ip: string | null | undefined
): BotVerification {
  const ua = userAgent ?? ''
  const claimed = parseBotName(userAgent)
  const ranges = COMPILED[claimed]

  if (!ranges) {
    // Either not a crawler at all, or a crawler with no published feed. Both
    // are "no judgement", but the caller may want to tell them apart.
    const isKnownCrawler = claimed !== 'Other' && claimed !== 'Browser'
    return {
      verdict: isKnownCrawler ? 'unverifiable' : 'not-claimed',
      ...(isKnownCrawler ? { reason: 'no-published-ranges' as const } : {}),
      claimed: isKnownCrawler ? claimed : null,
      verified: null
    }
  }

  // Order matters: a client-side agent must be excluded before the range check,
  // and the server-side allowlist gates everything else, so an unrecognised
  // product from a covered vendor is never accused on a partial range list.
  if (CLIENT_SIDE_AGENT_PATTERN.test(ua) || !SERVER_SIDE_CRAWLER_PATTERN.test(ua)) {
    return {
      verdict: 'unverifiable',
      reason: 'client-side-agent',
      claimed,
      verified: null
    }
  }

  const trimmed = (ip ?? '').trim()
  if (!trimmed) {
    return { verdict: 'unverifiable', reason: 'no-client-ip', claimed, verified: null }
  }

  const inRange = ipInRanges(trimmed, ranges)
  return {
    verdict: inRange ? 'verified' : 'spoofed',
    claimed,
    verified: inRange
  }
}

/**
 * Extract the client IP the way {@link trackVisit} does — first hop of
 * `x-forwarded-for`, falling back to the platform-specific headers.
 */
export function clientIpFromRequest(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for') || ''
  const first = forwarded.split(',')[0]?.trim()
  if (first) return first
  return (req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || '').trim()
}

/** Verify straight from a request object. */
export function verifyRequest(req: Request): BotVerification {
  return verifyBotIdentity(req.headers.get('user-agent'), clientIpFromRequest(req))
}
