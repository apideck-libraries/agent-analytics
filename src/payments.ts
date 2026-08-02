/**
 * Charge for training crawls. **EXPERIMENTAL.**
 *
 * The protocols this speaks are weeks old and moving. x402 and MPP are both
 * live but their specs are unstable, MPP's settlement-confirmation header was
 * not pinned publicly at the time of writing, and no agent in our production
 * traffic has yet presented a payment credential. Expect this API to change
 * without a major version while that settles — everything else in the package
 * is stable, this is not.
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
 * Two protocols, one status code. Both settle at the HTTP layer and both use
 * 402, but the framing differs:
 *
 *   x402  PAYMENT-REQUIRED: <base64 JSON>      -> PAYMENT-SIGNATURE
 *   MPP   WWW-Authenticate: Payment id="…"     -> Authorization: Payment …
 *
 * MPP reuses standard HTTP authentication framing; x402 defines its own
 * headers. They do not collide, so a single 402 can advertise both and let the
 * agent pick — which is what {@link paymentRequired} does when given both.
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

/** Which settlement protocol a challenge speaks. */
export type PaymentProtocol = 'x402' | 'mpp'

/** x402: base64 JSON in a `PAYMENT-REQUIRED` header. */
export interface X402Challenge {
  protocol: 'x402'
  /** Accepted payment methods, in preference order. At least one. */
  accepts: readonly PaymentRequirements[]
  /** Protocol version. Defaults to 1. */
  x402Version?: number
}

/**
 * MPP: an RFC 9110 `WWW-Authenticate: Payment` challenge.
 *
 * Field values are yours. `request` carries the encoded challenge payload your
 * MPP provider generates — the library does not construct or price it.
 */
export interface MppChallenge {
  protocol: 'mpp'
  /** Challenge identifier. */
  id: string
  /** Authentication realm. */
  realm: string
  /** Payment method, e.g. `'tempo'`. */
  method: string
  /** Transaction intent, e.g. `'charge'`. */
  intent?: string
  /** Encoded challenge data from your provider. */
  request?: string
}

export type PaymentChallenge = X402Challenge | MppChallenge

export interface PaymentChallengeOptions {
  /**
   * Challenges to advertise. Supplying both an x402 and an MPP challenge is
   * valid and usually correct: they use non-colliding headers, so one 402 can
   * offer both and the agent takes whichever it speaks.
   */
  challenges: readonly PaymentChallenge[]
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

const X402_CHALLENGE = 'PAYMENT-REQUIRED'
const X402_SIGNATURE = 'PAYMENT-SIGNATURE'
const X402_SETTLEMENT = 'PAYMENT-RESPONSE'
const MPP_CHALLENGE = 'WWW-Authenticate'
const MPP_CREDENTIAL = 'Authorization'

/** Quote and escape a WWW-Authenticate auth-param value per RFC 9110. */
function quoted(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

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
 *     challenges: [
 *       {
 *         protocol: 'x402',
 *         accepts: [{
 *           scheme: 'exact',
 *           network: 'base',
 *           maxAmountRequired: '1000',     // your price, your units
 *           resource: req.url,
 *           payTo: process.env.WALLET!,
 *           asset: process.env.USDC!
 *         }]
 *       },
 *       { protocol: 'mpp', id: challengeId, realm: 'example.com', method: 'tempo', intent: 'charge' }
 *     ]
 *   })
 * }
 * ```
 */
export function paymentRequired(opts: PaymentChallengeOptions): Response {
  if (!opts.challenges.length) {
    throw new Error('paymentRequired needs at least one challenge')
  }

  const headers = new Headers({
    'content-type': 'text/plain; charset=utf-8',
    // Says the quiet part out loud: training is for sale, not forbidden.
    'content-signal': opts.contentSignal ?? 'search=yes, ai-input=yes, ai-train=paid'
  })

  for (const c of opts.challenges) {
    if (c.protocol === 'x402') {
      if (!c.accepts.length) {
        throw new Error('an x402 challenge needs at least one entry in `accepts`')
      }
      headers.set(X402_CHALLENGE, b64({ x402Version: c.x402Version ?? 1, accepts: c.accepts }))
    } else {
      const params = [
        `id=${quoted(c.id)}`,
        `realm=${quoted(c.realm)}`,
        `method=${quoted(c.method)}`,
        ...(c.intent ? [`intent=${quoted(c.intent)}`] : []),
        ...(c.request ? [`request=${quoted(c.request)}`] : [])
      ]
      // `append`, not `set`: WWW-Authenticate legitimately carries multiple
      // challenges, and a caller may already have added one.
      headers.append(MPP_CHALLENGE, `Payment ${params.join(', ')}`)
    }
  }

  for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v)

  return new Response(opts.body ?? 'Payment required for training access.\n', {
    status: 402,
    headers
  })
}

/** A payment credential the client sent back, and which protocol it speaks. */
export interface SubmittedPayment {
  protocol: PaymentProtocol
  /** Raw header value, for handing to a facilitator. */
  value: string
}

/**
 * Read the client's payment credential, whichever protocol it used.
 *
 * x402 sends `PAYMENT-SIGNATURE`; MPP sends `Authorization: Payment …`. The
 * `Payment` scheme check matters — a site behind normal auth will also have a
 * Bearer or Basic `Authorization` header, and mistaking that for a payment
 * would be a security-relevant confusion.
 */
export function paymentPayload(req: Request): SubmittedPayment | null {
  const x402 = req.headers.get(X402_SIGNATURE)
  if (x402) return { protocol: 'x402', value: x402 }

  const auth = req.headers.get(MPP_CREDENTIAL)
  if (auth) {
    const m = auth.match(/^Payment\s+(.*)$/i)
    if (m?.[1]) return { protocol: 'mpp', value: m[1] }
  }
  return null
}

/**
 * True when the client attached a payment credential — i.e. this is the retry
 * after a 402, not a fresh unpaid request.
 *
 * Presence is not proof. Hand the value to your facilitator to verify and
 * settle; only then serve the resource.
 */
export function hasPaymentPayload(req: Request): boolean {
  return paymentPayload(req) !== null
}

/**
 * Attach a facilitator's settlement result to a successful response.
 *
 * x402 defines `PAYMENT-RESPONSE` for this. MPP's public spec did not pin a
 * settlement-confirmation header at the time of writing, so pass `header` to
 * name whatever your provider expects rather than have the library guess.
 */
export function withSettlement(
  res: Response,
  settlement: unknown,
  opts: { header?: string } = {}
): Response {
  const headers = new Headers(res.headers)
  headers.set(opts.header ?? X402_SETTLEMENT, b64(settlement))
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
