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
 *
 * Only products belonging to a vendor we hold ranges for need listing here.
 * Cursor, Windsurf, Cline and Aider were previously included but were dead
 * branches: their vendors publish no feed, so they exit earlier as
 * 'no-published-ranges' or 'not-claimed' and never reach this test.
 */
const CLIENT_SIDE_AGENT_PATTERN = /claude-code|perplexity-user/i

/**
 * Products known to fetch server-side from ranges the vendor publishes. Only
 * these can earn a 'verified' or 'spoofed' verdict; anything else is reported
 * 'unverifiable' so the data never overstates what was actually checked.
 */
const SERVER_SIDE_CRAWLER_PATTERN =
  /ClaudeBot|Claude-SearchBot|GPTBot|OAI-SearchBot|ChatGPT-User|PerplexityBot|Applebot/i

// Compiled on first use per vendor, not at module load. Eagerly parsing all
// 412 prefixes cost cold-start CPU on every request path that imported this
// module, including the majority that never verify anything.
const COMPILED = new Map<string, CompiledRanges>()

function rangesFor(vendor: string): CompiledRanges | undefined {
  if (!(vendor in BOT_IP_RANGES)) return undefined
  let c = COMPILED.get(vendor)
  if (!c) {
    c = compileRanges(BOT_IP_RANGES[vendor] ?? [])
    COMPILED.set(vendor, c)
  }
  return c
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
  const ranges = rangesFor(claimed)

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

export {
  clearKeyCache,
  jwkThumbprint,
  verifyWebBotAuth,
  webBotAuthVerifier
} from './webbotauth.js'
export type { WebBotAuthOptions, WebBotAuthResult, WebBotAuthVerdict } from './webbotauth.js'

import { verifyWebBotAuth, type WebBotAuthOptions } from './webbotauth.js'
import type { BotVerificationLike } from './types.js'

/**
 * Verifier that prefers a cryptographic signature and falls back to published
 * IP ranges.
 *
 * Ordering matters. Web Bot Auth proves control of a signing key, works for
 * any agent that adopts it, and cannot go stale. IP ranges cover four vendors,
 * rot between refreshes, and cannot see an agent running on a user's own
 * machine. So a signature — valid or invalid — is always the answer when one
 * is present; ranges only speak when the request is unsigned.
 *
 * As signing adoption grows this quietly shifts from mostly-ranges to
 * mostly-signatures with no change at the call site.
 */
export function combinedVerifier(
  opts: WebBotAuthOptions = {}
): (req: Request) => Promise<BotVerificationLike> {
  return async (req: Request): Promise<BotVerificationLike> => {
    const signed = await verifyWebBotAuth(req, opts)

    if (signed.verdict === 'verified') {
      return { verdict: 'verified', verified: true, reason: 'web-bot-auth' }
    }
    // A signature that is present and fails is decisive — do not let a lucky
    // IP-range hit launder a forged signature into 'verified'.
    if (signed.verdict === 'invalid-signature' || signed.verdict === 'expired') {
      return { verdict: 'spoofed', verified: false, reason: `web-bot-auth-${signed.verdict}` }
    }

    const byRange = verifyRequest(req)
    if (byRange.verdict !== 'not-claimed' && byRange.verdict !== 'unverifiable') {
      return { ...byRange, reason: byRange.reason ?? 'published-ip-range' }
    }
    return byRange
  }
}
