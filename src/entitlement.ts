/**
 * Quota and entitlements — the model that actually works for training crawls.
 * **EXPERIMENTAL**, like the rest of the payment surface.
 *
 * Per-request 402 is what x402 and MPP define, and it is the wrong shape for a
 * training sweep. On one production site training traffic is ~199,000 requests a
 * month. Charging each one means three times the traffic (402, pay, retry),
 * 199,000 settlements whose per-transaction cost exceeds any sane per-page
 * price, and — decisively — no crawler in the wild implements the retry, so a
 * per-request 402 is just blocking with extra steps.
 *
 * Two workable shapes instead, both supported here:
 *
 *   METER      Serve the request, count it, bill out of band. Needs no crawler
 *              cooperation and works today. This is the one to ship.
 *
 *   ENTITLEMENT  Challenge once with a bulk offer, take payment, issue a
 *              credential. Every later request presents it and is served
 *              directly, decrementing quota. One settlement per licence rather
 *              than per page.
 *
 * MPP's reusable `Authorization: Payment` credential fits entitlements better
 * than x402's per-resource signature, which proves payment for one URL.
 */

import { paymentRequired, paymentPayload, type PaymentChallengeOptions } from './payments.js'
import type { GatewayResult, PaymentGateway } from './gateway.js'

/** What a buyer holds after paying. */
export interface Entitlement {
  /** Opaque licence id, for your own accounting. */
  id: string
  /**
   * Units left. Omit for an unmetered licence — `consume` is still called, so
   * you can count without capping.
   */
  remaining?: number
  /** Expiry as epoch seconds. Omit for no expiry. */
  expiresAt?: number
}

/**
 * Where entitlements live. A KV namespace, Redis, your database — anything
 * reachable from the edge. The library deliberately ships no storage: quota
 * state is yours, and so is the money it represents.
 */
export interface EntitlementStore {
  /** Resolve the credential a client presented. Return null to challenge. */
  lookup(credential: string, req: Request): Promise<Entitlement | null> | Entitlement | null
  /**
   * Record consumption after a request is admitted. Called for every served
   * request, including unmetered licences, so this doubles as your meter.
   */
  consume?(entitlement: Entitlement, req: Request): Promise<void> | void
}

/**
 * What is for sale. Folded into the challenge so an agent sees a bulk product
 * rather than a price for the single page it happened to ask for.
 */
export interface BulkOffer {
  /** e.g. 1_000_000 */
  units: number
  /** e.g. `'pages'` */
  unit: string
  /** Licence lifetime in seconds. */
  validForSeconds: number
  /** Total price, in whatever units your challenge already uses. */
  price: string
  /** Summary surfaced to the agent. */
  description?: string
}

export interface EntitlementGatewayOptions extends PaymentChallengeOptions {
  store: EntitlementStore
  /** The bulk product the 402 advertises. */
  offer: BulkOffer
  /**
   * Emit `x-quota-remaining` on served responses so a paying crawler can see
   * its balance and slow down before running out.
   *
   * Off by default: this header is **not** part of x402 or MPP. It is a
   * convenience, and a crawler that does not know it will ignore it.
   */
  exposeRemaining?: boolean
}

function offerDescription(offer: BulkOffer): string {
  const days = Math.round(offer.validForSeconds / 86_400)
  const window = days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : `${offer.validForSeconds}s`
  return (
    offer.description ??
    `${offer.units.toLocaleString('en-US')} ${offer.unit} for ${window}, ${offer.price}`
  )
}

/**
 * Gateway that honours a bulk licence instead of charging per request.
 *
 * A request carrying a valid credential is served and its quota decremented —
 * no challenge, no round-trip. A request without one gets a single 402
 * advertising the bulk offer.
 *
 * @example
 * ```ts
 * const gateway = entitlementGateway({
 *   store: myKvStore,
 *   offer: { units: 1_000_000, unit: 'pages', validForSeconds: 2_592_000, price: '$400' },
 *   challenges: [{ protocol: 'mpp', id, realm: 'example.com', method: 'tempo' }]
 * })
 * ```
 */
export function entitlementGateway(opts: EntitlementGatewayOptions): PaymentGateway {
  const { store, offer, exposeRemaining, ...challenge } = opts

  return {
    async handle(req: Request): Promise<GatewayResult> {
      const submitted = paymentPayload(req)

      if (submitted) {
        const ent = await store.lookup(submitted.value, req)
        const now = Math.floor(Date.now() / 1000)

        const usable =
          ent !== null &&
          (ent.expiresAt === undefined || ent.expiresAt > now) &&
          // `undefined` remaining means unmetered, which is usable. Zero is not.
          (ent.remaining === undefined || ent.remaining > 0)

        if (usable && ent) {
          await store.consume?.(ent, req)
          const left = ent.remaining === undefined ? undefined : ent.remaining - 1
          return {
            status: 'paid',
            ...(exposeRemaining && left !== undefined
              ? {
                  receipt: (res: Response) => {
                    const h = new Headers(res.headers)
                    h.set('x-quota-remaining', String(Math.max(0, left)))
                    return new Response(res.body, {
                      status: res.status,
                      statusText: res.statusText,
                      headers: h
                    })
                  }
                }
              : {})
          }
        }
      }

      // No credential, expired, or exhausted — all get the same offer. Saying
      // which of the three it was would leak quota state to anyone probing.
      return {
        status: 'challenge',
        response: paymentRequired({
          ...challenge,
          body: `Payment required for training access.\nOffer: ${offerDescription(offer)}\n`,
          headers: {
            ...(challenge.headers ?? {}),
            'x-bulk-offer': offerDescription(offer)
          }
        })
      }
    }
  }
}

/**
 * In-memory store. For tests and local development only — an edge runtime
 * gives each instance its own memory, so quota would neither be shared nor
 * survive a deploy. Use KV, Redis, or your database in production.
 */
export function memoryEntitlementStore(
  seed: Record<string, Entitlement> = {}
): EntitlementStore & { entries(): Record<string, Entitlement> } {
  const map = new Map<string, Entitlement>(Object.entries(seed))
  return {
    lookup: (credential) => map.get(credential) ?? null,
    consume: (ent) => {
      if (ent.remaining !== undefined) {
        map.set(ent.id, { ...ent, remaining: ent.remaining - 1 })
      }
    },
    entries: () => Object.fromEntries(map)
  }
}
