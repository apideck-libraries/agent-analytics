import { classifyRequest, isHttpClient } from './bots.js'
import type { BotVerificationLike } from './types.js'

/**
 * What to do with an agent request.
 *
 * - `'allow'`  — serve it, free. Humans, search crawlers, and the retrieval
 *   agents you *want* reading your site.
 * - `'meter'`  — serve it, but count it as billable. Bulk corpus collection.
 * - `'charge'` — don't serve it until it pays (HTTP 402).
 * - `'block'`  — refuse. Failed identity verification, mostly.
 */
export type AgentAction = 'allow' | 'meter' | 'charge' | 'block'

/**
 * Why an agent fetched the page. This is the distinction the whole module
 * exists for, and no other signal on the request carries it.
 *
 * - `'retrieval'` — a person asked a question and the assistant went to read
 *   the page for them. This is *demand*: the agent is a distribution channel,
 *   and charging for it is charging for your own marketing.
 * - `'training'`  — bulk corpus collection for model training. You get nothing
 *   back per fetch, which is where a price makes sense.
 * - `'search'`    — index crawlers, traditional and AI-native. Blocking these
 *   costs you organic traffic or citations in an assistant's answer.
 * - `'preview'`   — link unfurlers. Someone pasted your URL into Slack, iMessage
 *   or a tweet and the platform fetched it to render a card. No model involved,
 *   but blocking it means your links look broken wherever they get shared.
 * - `'tooling'`   — coding agents and HTTP clients. Usually developers using
 *   your docs; treat like retrieval unless you see abuse.
 * - `'unknown'`   — everything else, including real browsers.
 */
export type AgentIntent = 'retrieval' | 'training' | 'search' | 'preview' | 'tooling' | 'unknown'

/**
 * User agents where a human is waiting on the answer. Deliberately explicit
 * rather than pattern-guessed: `-User` is not a reliable marker (OpenAI's
 * ChatGPT-User fetches server-side; Claude Code's Claude-User runs on a
 * laptop), and getting this wrong means charging your own demand channel.
 */
const RETRIEVAL = /ChatGPT-User|OAI-SearchBot|Claude-User|Claude-SearchBot|Perplexity-User|claude-code|DuckAssistBot|MistralAI-User|Gemini-Deep-Research|Manus-User|YouBot/i

/** Bulk crawlers that collect corpora. No human is waiting on these. */
const TRAINING = /GPTBot|ClaudeBot|Claude-Web|CCBot|Bytespider|Amazonbot|Amzn-SearchBot|Meta-ExternalAgent|meta-externalfetcher|meta-webindexer|FacebookBot|Google-Extended|Applebot-Extended|AI2Bot|Diffbot|omgili|Webzio-Extended|Timpibot|PanguBot|cohere|DeepSeek|Grok|quillbot|MyCentralAIScraperBot|NovaAct|AzureAI-SearchBot|Google-CloudVertexBot/i

/**
 * Index crawlers — blocking these costs you organic traffic.
 *
 * `PerplexityBot` sits here rather than in TRAINING despite the `Bot` suffix:
 * Perplexity documents it as the crawler behind their *search results* and
 * states it does not feed foundation-model training. Blocking it costs you
 * citations, which is the same shape of loss as blocking Googlebot. It was
 * previously in no list at all, so it classified as `unknown` and fell through
 * both the protective bypass and the training rate limit — a live gap found in
 * production traffic, not in review.
 */
const SEARCH = /bingbot|Googlebot|DuckDuckBot|YandexBot|Baiduspider|PetalBot|Sogou|PerplexityBot|Bravebot|Applebot(?!-Extended)/i

/**
 * Link unfurlers. A human shared the URL and a platform fetched it to build a
 * preview card — one request, no crawl, and the payoff is a rendered link in a
 * conversation. They get their own intent rather than being folded into
 * `retrieval` because retrieval is the library's demand signal: counting
 * Slackbot as "an assistant went to read this for someone" would inflate the
 * one number the split exists to measure.
 *
 * These tokens are trivially spoofable — `facebookexternalhit` is among the
 * most-forged strings on the web. Treat this as a routing hint, never as
 * identity, and note that {@link recommendFirewallRules} proposes them as a
 * separate, higher-risk rule for exactly that reason.
 */
const PREVIEW = /facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|Discordbot|TelegramBot|WhatsApp|redditbot|Pinterest|SkypeUriPreview|Iframely|Embedly|vkShare|Mastodon|Bluesky/i

export interface AgentDecision {
  action: AgentAction
  intent: AgentIntent
  /** Vendor label, same string `parseBotName` returns. */
  label: string
  /** Identity verdict, when a verifier was supplied. */
  verification?: string
  /** Short human-readable justification — log it, don't parse it. */
  reason: string
}

export interface AgentPolicyOptions {
  /**
   * Identity verifier. Import `verifyRequest` from
   * `@apideck/agent-analytics/verify` and pass it here to have a `spoofed`
   * verdict produce `'block'`.
   *
   * Injected rather than imported so the published IP range tables only reach
   * bundles that use them. Only meaningful when your edge controls
   * `x-forwarded-for`: behind a proxy that forwards a client-supplied header,
   * an attacker picks their own verdict.
   */
  verify?: (req: Request) => BotVerificationLike
  /**
   * A verification already computed elsewhere. Use this when your verifier is
   * async — {@link verifyWebBotAuth} fetches a key directory, so the natural
   * verifier from `@apideck/agent-analytics/verify` returns a promise and
   * cannot be passed to `verify` on this synchronous function.
   *
   * {@link paymentGate} does this for you: it awaits the verifier and forwards
   * the result here.
   */
  verification?: BotVerificationLike
  /** What to do with bulk training crawlers. Defaults to `'meter'`. */
  onTraining?: AgentAction
  /** What to do with retrieval agents. Defaults to `'allow'` — see AgentIntent. */
  onRetrieval?: AgentAction
  /** What to do with search indexers. Defaults to `'allow'`. */
  onSearch?: AgentAction
  /**
   * What to do with link unfurlers. Defaults to `'allow'` — gating these does
   * not earn you anything, it just makes your links render as bare URLs.
   */
  onPreview?: AgentAction
  /** What to do with coding agents and HTTP clients. Defaults to `'allow'`. */
  onTooling?: AgentAction
  /** Vendor labels or UA substrings always allowed, whatever the intent. */
  allowList?: readonly string[]
}

/**
 * Classify why an agent is here, from its user agent alone.
 *
 * This must return exactly what {@link agentPolicy} reports for the same UA.
 * It previously did not: the `tooling` promotion for HTTP-library UAs lived
 * only inside `agentPolicy`, so `agentIntent('curl/8.4.0')` said `'unknown'`
 * while the policy said `'tooling'` — two exported functions disagreeing on
 * every HTTP client, with no way for a caller to know which was right. The
 * invariant is pinned by a test.
 */
export function agentIntent(userAgent: string | null | undefined): AgentIntent {
  const ua = userAgent ?? ''
  if (!ua) return 'unknown'
  // Retrieval is checked first: several vendors ship both a bulk crawler and a
  // user-facing fetcher whose tokens overlap (ClaudeBot vs Claude-User).
  if (RETRIEVAL.test(ua)) return 'retrieval'
  if (TRAINING.test(ua)) return 'training'
  if (SEARCH.test(ua)) return 'search'
  // After SEARCH so Applebot stays a search crawler rather than an iMessage
  // unfurler — Apple uses the same token for both.
  if (PREVIEW.test(ua)) return 'preview'
  // An HTTP-library UA that matched no vendor is a coding agent or a script.
  if (isHttpClient(ua)) return 'tooling'
  return 'unknown'
}

/**
 * Decide what to do with a request. Pure classification plus policy — no
 * payment rails, no network calls, nothing to configure beyond the four
 * intent knobs.
 *
 * @example
 * ```ts
 * const decision = agentPolicy(req, { verify: true, onTraining: 'charge' })
 * if (decision.action === 'block') return new Response(null, { status: 403 })
 * if (decision.action === 'charge') return paymentRequired(decision)
 * ```
 */
export function agentPolicy(req: Request, opts: AgentPolicyOptions = {}): AgentDecision {
  const ua = req.headers.get('user-agent') || ''
  const classification = classifyRequest(req)
  const label = classification.label

  // Single source of truth — the promotion that used to live here now lives in
  // agentIntent, so the two can no longer drift apart.
  const intent = agentIntent(ua)

  const allowed = opts.allowList?.some(
    (entry) => entry === label || ua.toLowerCase().includes(entry.toLowerCase())
  )
  if (allowed) {
    return { action: 'allow', intent, label, reason: 'on allowList' }
  }

  // A pre-resolved verification wins: it is the only way an async verifier can
  // reach this synchronous function.
  const resolved = opts.verification ?? (opts.verify ? opts.verify(req) : undefined)
  let verification: string | undefined
  if (resolved) {
    verification = resolved.verdict
    // Only 'spoofed' is actionable. 'unverifiable' means we couldn't check —
    // blocking on it would refuse every vendor without a published feed and
    // every coding agent running on someone's own machine.
    if (verification === 'spoofed') {
      return {
        action: 'block',
        intent,
        label,
        verification,
        reason: `${label} claimed but client IP is outside its published ranges`
      }
    }
  }

  const action: AgentAction =
    intent === 'training'
      ? (opts.onTraining ?? 'meter')
      : intent === 'retrieval'
        ? (opts.onRetrieval ?? 'allow')
        : intent === 'search'
          ? (opts.onSearch ?? 'allow')
          : intent === 'preview'
            ? (opts.onPreview ?? 'allow')
            : intent === 'tooling'
              ? (opts.onTooling ?? 'allow')
              : 'allow'

  const REASONS: Record<AgentIntent, string> = {
    retrieval: 'a person is waiting on this answer',
    training: 'bulk corpus collection',
    search: 'search index crawler',
    preview: 'link unfurler building a preview card',
    tooling: 'coding agent or HTTP client',
    unknown: 'not a recognised agent'
  }

  return {
    action,
    intent,
    label,
    // Spread rather than assign: `exactOptionalPropertyTypes` distinguishes an
    // absent key from one explicitly set to undefined.
    ...(verification ? { verification } : {}),
    reason: REASONS[intent]
  }
}
