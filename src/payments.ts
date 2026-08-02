/**
 * Charge for training crawls.
 *
 * Today the industry's answer to bulk AI crawling is `Disallow` — over 2.5
 * million sites block AI training in robots.txt. That leaves money on the
 * table and depends on the crawler's goodwill to work at all.
 *
 * The alternative is to let them train and price it. That only works if you
 * can tell training from retrieval, because they have opposite economics: a
 * `GPTBot` fetch is corpus collection you get nothing back for, while a
 * `ChatGPT-User` fetch is a person asking about you — charging for the second
 * is charging for your own distribution. {@link agentPolicy} draws that line;
 * this module turns a `'charge'` decision into the HTTP challenge.
 *
 * Scope: this emits the 402 and reads the client's payment header. It does not
 * settle anything. Settlement belongs to an x402 facilitator or Stripe's MPP —
 * a library that held money would inherit PCI scope and stop being something
 * you can drop into middleware.
 */

import type { AgentDecision } from './policy.js'

/**
 * One way a client may pay. Field names follow x402's `PaymentRequirements`;
 * values are yours — the library never invents an amount, network or asset.
 */
export interface PaymentRequirements {
  scheme: string
  network: string
  maxAmountRequired: string
  resource: string
  description?: string
  mimeType?: string
  payTo: string
  maxTimeoutSeconds?: number
  asset: string
  extra?: Record<string, unknown>
}

export interface PaymentChallengeOptions {
  /** Accepted payment methods, in preference order. At least one. */
  accepts: readonly PaymentRequirements[]
  /** x402 protocol version. Defaults to 1. */
  x402Version?: number
  /**
   * `Content-Signal` to send with the challenge. Defaults to
   * `search=yes, ai-input=yes, ai-train=paid` — the whole point being that
   * training is available rather than forbidden.
   */
  contentSignal?: string
  /** Extra response headers. */
  headers?: Record<string, string>
  /** Human-readable body. Agents read the header; people read logs. */
  body?: string
}

const HEADER_CHALLENGE = 'PAYMENT-REQUIRED'
const HEADER_SIGNATURE = 'PAYMENT-SIGNATURE'
const HEADER_SETTLEMENT = 'PAYMENT-RESPONSE'

function b64(json: unknown): string {
  const text = JSON.stringify(json)
  // btoa is Latin-1 only; encode first so non-ASCII descriptions survive.
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/**
 * Build a 402 challenge.
 *
 * @example
 * ```ts
 * const decision = agentPolicy(req, { onTraining: 'charge' })
 * if (decision.action === 'charge') {
 *   return paymentRequired({
 *     accepts: [{
 *       scheme: 'exact',
 *       network: 'base',
 *       maxAmountRequired: '1000',        // your price, your units
 *       resource: req.url,
 *       description: 'Training crawl of one page',
 *       payTo: process.env.WALLET,
 *       asset: process.env.USDC_ADDRESS
 *     }]
 *   })
 * }
 * ```
 */
export function paymentRequired(opts: PaymentChallengeOptions): Response {
  if (!opts.accepts.length) {
    throw new Error('paymentRequired needs at least one entry in `accepts`')
  }
  const challenge = {
    x402Version: opts.x402Version ?? 1,
    accepts: opts.accepts
  }
  return new Response(opts.body ?? 'Payment required for training access.\n', {
    status: 402,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      [HEADER_CHALLENGE]: b64(challenge),
      // Says the quiet part out loud: training is for sale, not forbidden.
      'content-signal': opts.contentSignal ?? 'search=yes, ai-input=yes, ai-train=paid',
      ...(opts.headers ?? {})
    }
  })
}

/**
 * True when the client attached a payment payload — i.e. this is the retry
 * after a 402, not a fresh unpaid request.
 *
 * Presence is not proof. Hand the value to your facilitator to verify and
 * settle; only then serve the resource.
 */
export function hasPaymentPayload(req: Request): boolean {
  return !!req.headers.get(HEADER_SIGNATURE)
}

/** Raw `PAYMENT-SIGNATURE` value, for handing to a facilitator. */
export function paymentPayload(req: Request): string | null {
  return req.headers.get(HEADER_SIGNATURE)
}

/** Attach a facilitator's settlement result to a successful response. */
export function withSettlement(res: Response, settlement: unknown): Response {
  const headers = new Headers(res.headers)
  headers.set(HEADER_SETTLEMENT, b64(settlement))
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

/**
 * Convenience: turn an {@link AgentDecision} straight into a response, or
 * `null` when the request should simply be served.
 *
 * Returns 403 for `'block'`, a 402 challenge for `'charge'`, and `null` for
 * `'allow'` and `'meter'` — metering is an accounting concern, not a gate, so
 * the request still gets served while `trackVisit` records it.
 */
export function respondToDecision(
  decision: AgentDecision,
  opts: PaymentChallengeOptions
): Response | null {
  if (decision.action === 'block') {
    return new Response('Forbidden: agent identity could not be verified.\n', { status: 403 })
  }
  if (decision.action === 'charge') {
    return paymentRequired({
      body: `Payment required: ${decision.label} — ${decision.reason}.\n`,
      ...opts
    })
  }
  return null
}
