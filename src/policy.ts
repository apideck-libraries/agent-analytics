import { classifyRequest } from './bots.js'
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
 * - `'search'`    — classic index crawlers. Blocking these costs you SEO.
 * - `'tooling'`   — coding agents and HTTP clients. Usually developers using
 *   your docs; treat like retrieval unless you see abuse.
 * - `'unknown'`   — everything else, including real browsers.
 */
export type AgentIntent = 'retrieval' | 'training' | 'search' | 'tooling' | 'unknown'

/**
 * User agents where a human is waiting on the answer. Deliberately explicit
 * rather than pattern-guessed: `-User` is not a reliable marker (OpenAI's
 * ChatGPT-User fetches server-side; Claude Code's Claude-User runs on a
 * laptop), and getting this wrong means charging your own demand channel.
 */
const RETRIEVAL = /ChatGPT-User|OAI-SearchBot|Claude-User|Claude-SearchBot|Perplexity-User|claude-code|DuckAssistBot|MistralAI-User|Gemini-Deep-Research|Manus-User|YouBot/i

/** Bulk crawlers that collect corpora. No human is waiting on these. */
const TRAINING = /GPTBot|ClaudeBot|Claude-Web|CCBot|Bytespider|Amazonbot|Amzn-SearchBot|Meta-ExternalAgent|meta-externalfetcher|meta-webindexer|FacebookBot|Google-Extended|Applebot-Extended|AI2Bot|Diffbot|omgili|Webzio-Extended|Timpibot|PanguBot|cohere|DeepSeek|Grok|quillbot|MyCentralAIScraperBot|NovaAct|AzureAI-SearchBot|Google-CloudVertexBot/i

/** Classic search indexers — blocking these costs you organic traffic. */
const SEARCH = /bingbot|Googlebot|DuckDuckBot|YandexBot|Baiduspider|PetalBot|Sogou|Applebot(?!-Extended)/i

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
  /** What to do with bulk training crawlers. Defaults to `'meter'`. */
  onTraining?: AgentAction
  /** What to do with retrieval agents. Defaults to `'allow'` — see AgentIntent. */
  onRetrieval?: AgentAction
  /** What to do with search indexers. Defaults to `'allow'`. */
  onSearch?: AgentAction
  /** What to do with coding agents and HTTP clients. Defaults to `'allow'`. */
  onTooling?: AgentAction
  /** Vendor labels or UA substrings always allowed, whatever the intent. */
  allowList?: readonly string[]
}

/** Classify why an agent is here, from its user agent alone. */
export function agentIntent(userAgent: string | null | undefined): AgentIntent {
  const ua = userAgent ?? ''
  if (!ua) return 'unknown'
  // Retrieval is checked first: several vendors ship both a bulk crawler and a
  // user-facing fetcher whose tokens overlap (ClaudeBot vs Claude-User).
  if (RETRIEVAL.test(ua)) return 'retrieval'
  if (TRAINING.test(ua)) return 'training'
  if (SEARCH.test(ua)) return 'search'
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

  let intent = agentIntent(ua)
  // An HTTP-library UA that matched no vendor is a coding agent or a script.
  if (intent === 'unknown' && classification.codingAgentHint) intent = 'tooling'

  const allowed = opts.allowList?.some(
    (entry) => entry === label || ua.toLowerCase().includes(entry.toLowerCase())
  )
  if (allowed) {
    return { action: 'allow', intent, label, reason: 'on allowList' }
  }

  let verification: string | undefined
  if (opts.verify) {
    verification = opts.verify(req).verdict
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
          : intent === 'tooling'
            ? (opts.onTooling ?? 'allow')
            : 'allow'

  const REASONS: Record<AgentIntent, string> = {
    retrieval: 'a person is waiting on this answer',
    training: 'bulk corpus collection',
    search: 'search index crawler',
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
