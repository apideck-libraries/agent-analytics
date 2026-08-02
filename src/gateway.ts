/**
 * The paid-access gate: policy decides *whether* to charge, a gateway decides
 * *how*. **EXPERIMENTAL** — see `payments.ts`. The classification and policy
 * layers underneath are stable; the payment surface is not.
 *
 * The split matters. We own classification — telling a training crawl from a
 * retrieval fetch, which is the part nobody else does and the part that makes
 * charging sane. Settlement is somebody else's job: Stripe's MPP SDK, an x402
 * facilitator, whatever comes next. A library that held money would inherit PCI
 * scope and stop being something you drop into middleware.
 *
 * So gateways are injected, exactly like analytics adapters, and this module
 * takes no dependency on Stripe or any chain.
 */

import { agentPolicy, type AgentDecision, type AgentPolicyOptions } from './policy.js'
import type { BotVerificationLike } from './types.js'
import { paymentRequired, type PaymentChallengeOptions } from './payments.js'

/**
 * Outcome of handing a request to a payment gateway.
 *
 * - `challenge` — respond with this. The client has not paid.
 * - `paid` — settled; serve the resource. `receipt` decorates the response with
 *   whatever proof the protocol expects.
 */
export type GatewayResult =
  | { status: 'challenge'; response: Response }
  | { status: 'paid'; receipt?: (res: Response) => Response }

export interface PaymentGateway {
  handle(req: Request): Promise<GatewayResult>
}

/**
 * Wrap Stripe's MPP SDK.
 *
 * `Mppx.compose(...)` returns a handler that either yields a 402 with a
 * `.challenge` response, or a settled result with `.withReceipt(res)`. This
 * adapts that shape without importing it — pass the composed handler in.
 *
 * @example
 * ```ts
 * const mppx = Mppx.create({ methods: [...], secretKey })
 * const handler = Mppx.compose(
 *   mppx.tempo.charge({ amount: '0.01', recipient }),
 *   mppx.stripe.charge({ amount: '0.50', currency: 'usd' })
 * )
 * const gateway = mppxGateway(handler)
 * ```
 */
export function mppxGateway(
  handler: (req: Request) => Promise<MppxResponse> | MppxResponse
): PaymentGateway {
  return {
    async handle(req: Request): Promise<GatewayResult> {
      const out = await handler(req)
      if (out.status === 402) {
        return { status: 'challenge', response: out.challenge }
      }
      return {
        status: 'paid',
        ...(out.withReceipt ? { receipt: (res: Response) => out.withReceipt!(res) } : {})
      }
    }
  }
}

/** The subset of Stripe's MPP response we rely on. Structural, not imported. */
export interface MppxResponse {
  status: number
  challenge: Response
  withReceipt?: (res: Response) => Response
}

export interface X402GatewayOptions extends PaymentChallengeOptions {
  /**
   * Verify and settle a `PAYMENT-SIGNATURE` payload with your facilitator.
   * Resolve truthy to serve the resource, falsy to re-challenge.
   */
  settle: (payload: string, req: Request) => Promise<boolean> | boolean
  /** Attach the facilitator's settlement result to the served response. */
  receipt?: (res: Response) => Response
}

/**
 * Gateway using this library's own challenge builder plus a facilitator you
 * supply. For x402, or for MPP if you are not using Stripe's SDK.
 */
export function x402Gateway(opts: X402GatewayOptions): PaymentGateway {
  const { settle, receipt, ...challenge } = opts
  return {
    async handle(req: Request): Promise<GatewayResult> {
      const sig = req.headers.get('PAYMENT-SIGNATURE')
      if (sig && (await settle(sig, req))) {
        return { status: 'paid', ...(receipt ? { receipt } : {}) }
      }
      return { status: 'challenge', response: paymentRequired(challenge) }
    }
  }
}

export interface PaymentGateOptions extends Omit<AgentPolicyOptions, 'verify'> {
  gateway: PaymentGateway
  /**
   * Identity verifier, sync or async. Unlike {@link agentPolicy}'s option this
   * accepts a promise, because `paymentGate` is already async and can await it.
   * That matters: `combinedVerifier()` and `webBotAuthVerifier()` are async by
   * necessity — Web Bot Auth fetches the signer's key directory — so without
   * this they could not be used with policy or payments at all.
   */
  verify?: (req: Request) => BotVerificationLike | Promise<BotVerificationLike>
  /**
   * Called for every decision, paid or not — wire it to your metering so
   * `'meter'` traffic is actually counted rather than merely allowed.
   */
  onDecision?: (decision: AgentDecision) => void
}

/**
 * Full gate: classify, decide, and either let the request through or return the
 * response it should get instead.
 *
 * Returns `null` when the request should be served normally. That covers
 * `'allow'`, `'meter'` (accounting, not a gate) and any request that has already
 * paid — in which case `receipt` is handed back so you can decorate the response
 * you were going to send anyway.
 *
 * @example
 * ```ts
 * const gate = await paymentGate(req, {
 *   onTraining: 'charge',
 *   verify: combinedVerifier(),
 *   gateway: mppxGateway(handler),
 *   onDecision: (d) => void trackVisit(req, { analytics, properties: { action: d.action } })
 * })
 * if (gate.response) return gate.response
 * return gate.decorate(await serve(req))
 * ```
 */
export async function paymentGate(
  req: Request,
  opts: PaymentGateOptions
): Promise<{
  decision: AgentDecision
  /** Respond with this instead of serving, when set. */
  response: Response | null
  /** Wrap the response you were going to send. Identity when nothing to add. */
  decorate: (res: Response) => Response
}> {
  const { gateway, onDecision, verify, ...policyOpts } = opts
  // Await here so an async verifier works. Passing the function straight into
  // agentPolicy would hand it a promise to read `.verdict` off — undefined at
  // runtime, and a type error at compile time.
  const verification = verify ? await verify(req) : undefined
  const decision = agentPolicy(req, {
    ...policyOpts,
    ...(verification ? { verification } : {})
  })
  onDecision?.(decision)

  const identity = (res: Response) => res

  if (decision.action === 'block') {
    return {
      decision,
      response: new Response('Forbidden: agent identity could not be verified.\n', {
        status: 403
      }),
      decorate: identity
    }
  }

  if (decision.action !== 'charge') {
    return { decision, response: null, decorate: identity }
  }

  const out = await gateway.handle(req)
  if (out.status === 'challenge') {
    return { decision, response: out.response, decorate: identity }
  }
  return { decision, response: null, decorate: out.receipt ?? identity }
}
