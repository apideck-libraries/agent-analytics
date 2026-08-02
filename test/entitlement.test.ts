import { describe, expect, it, vi } from 'vitest'
import { entitlementGateway, memoryEntitlementStore } from '../src/entitlement.js'
import { paymentGate, type Meter } from '../src/gateway.js'

const CHALLENGES = [
  { protocol: 'mpp' as const, id: 'c1', realm: 'example.com', method: 'tempo', intent: 'charge' }
]
const OFFER = {
  units: 1_000_000,
  unit: 'pages',
  validForSeconds: 2_592_000,
  price: '$400'
}

const GPTBOT = 'Mozilla/5.0 (compatible; GPTBot/1.1)'
const req = (ua: string, headers: Record<string, string> = {}) =>
  new Request('https://example.com/docs/intro', { headers: { 'user-agent': ua, ...headers } })

/** x402 and MPP present credentials in different headers. */
const withX402 = (cred: string) => ({ 'PAYMENT-SIGNATURE': cred })
const withMpp = (cred: string) => ({ Authorization: `Payment ${cred}` })

describe('entitlementGateway', () => {
  it('challenges once, advertising the bulk offer rather than a page price', async () => {
    const g = entitlementGateway({
      store: memoryEntitlementStore(),
      offer: OFFER,
      challenges: CHALLENGES
    })
    const out = await g.handle(req(GPTBOT))
    expect(out.status).toBe('challenge')
    if (out.status === 'challenge') {
      expect(out.response.status).toBe(402)
      // The whole point: a sweep should be sold a licence, not one page.
      expect(out.response.headers.get('x-bulk-offer')).toContain('1,000,000 pages')
      expect(out.response.headers.get('x-bulk-offer')).toContain('30 days')
      expect(await out.response.text()).toContain('$400')
    }
  })

  it('serves a request holding a valid licence, with no round trip', async () => {
    const store = memoryEntitlementStore({ lic_1: { id: 'lic_1', remaining: 10 } })
    const g = entitlementGateway({ store, offer: OFFER, challenges: CHALLENGES })
    expect((await g.handle(req(GPTBOT, withX402('lic_1')))).status).toBe('paid')
    expect((await g.handle(req(GPTBOT, withMpp('lic_1')))).status).toBe('paid')
  })

  it('decrements quota as it serves', async () => {
    const store = memoryEntitlementStore({ lic_1: { id: 'lic_1', remaining: 3 } })
    const g = entitlementGateway({ store, offer: OFFER, challenges: CHALLENGES })
    for (let i = 0; i < 3; i++) await g.handle(req(GPTBOT, withX402('lic_1')))
    expect(store.entries().lic_1!.remaining).toBe(0)
    // Exhausted licences go back to the offer.
    expect((await g.handle(req(GPTBOT, withX402('lic_1')))).status).toBe('challenge')
  })

  it('treats an unmetered licence as usable and still counts it', async () => {
    const consume = vi.fn()
    const g = entitlementGateway({
      store: { lookup: () => ({ id: 'unlimited' }), consume },
      offer: OFFER,
      challenges: CHALLENGES
    })
    expect((await g.handle(req(GPTBOT, withX402('unlimited')))).status).toBe('paid')
    // No cap, but you still get the number — metering without gating.
    expect(consume).toHaveBeenCalledOnce()
  })

  it('rejects an expired licence', async () => {
    const past = Math.floor(Date.now() / 1000) - 60
    const g = entitlementGateway({
      store: { lookup: () => ({ id: 'old', remaining: 100, expiresAt: past }) },
      offer: OFFER,
      challenges: CHALLENGES
    })
    expect((await g.handle(req(GPTBOT, withX402('old')))).status).toBe('challenge')
  })

  it('rejects an unknown credential', async () => {
    const g = entitlementGateway({
      store: memoryEntitlementStore({ lic_1: { id: 'lic_1', remaining: 5 } }),
      offer: OFFER,
      challenges: CHALLENGES
    })
    expect((await g.handle(req(GPTBOT, withX402('forged')))).status).toBe('challenge')
  })

  it('does not leak why a credential failed', async () => {
    // Unknown, expired and exhausted must be indistinguishable, or the endpoint
    // becomes an oracle for probing quota state.
    const past = Math.floor(Date.now() / 1000) - 60
    const cases = [
      { lookup: () => null },
      { lookup: () => ({ id: 'x', remaining: 0 }) },
      { lookup: () => ({ id: 'x', remaining: 9, expiresAt: past }) }
    ]
    const bodies = new Set<string>()
    for (const store of cases) {
      const out = await entitlementGateway({ store, offer: OFFER, challenges: CHALLENGES }).handle(
        req(GPTBOT, withX402('c'))
      )
      if (out.status === 'challenge') bodies.add(await out.response.text())
    }
    expect(bodies.size).toBe(1)
  })

  it('exposes remaining quota only when asked', async () => {
    const store = memoryEntitlementStore({ lic_1: { id: 'lic_1', remaining: 7 } })
    const off = await entitlementGateway({ store, offer: OFFER, challenges: CHALLENGES }).handle(
      req(GPTBOT, withX402('lic_1'))
    )
    expect(off.status === 'paid' && off.receipt).toBeUndefined()

    const on = await entitlementGateway({
      store: memoryEntitlementStore({ lic_2: { id: 'lic_2', remaining: 7 } }),
      offer: OFFER,
      challenges: CHALLENGES,
      exposeRemaining: true
    }).handle(req(GPTBOT, withX402('lic_2')))
    expect(on.status).toBe('paid')
    if (on.status === 'paid') {
      expect(on.receipt!(new Response('ok')).headers.get('x-quota-remaining')).toBe('6')
    }
  })
})

describe('metering through paymentGate', () => {
  function meter() {
    const entries: Array<{ action: string; intent: string; path: string; units: number }> = []
    const m: Meter = {
      record: (e) =>
        void entries.push({
          action: e.decision.action,
          intent: e.decision.intent,
          path: e.path,
          units: e.units
        })
    }
    return { m, entries }
  }

  const gateway = entitlementGateway({
    store: memoryEntitlementStore(),
    offer: OFFER,
    challenges: CHALLENGES
  })

  it('counts training traffic and still serves it', async () => {
    const { m, entries } = meter()
    const g = await paymentGate(req(GPTBOT), { gateway, meter: m })
    expect(g.decision.action).toBe('meter')
    expect(g.response).toBeNull() // served, not gated
    expect(entries).toEqual([
      { action: 'meter', intent: 'training', path: '/docs/intro', units: 1 }
    ])
  })

  it('does not meter retrieval or search', async () => {
    const { m, entries } = meter()
    for (const ua of [
      'Mozilla/5.0 (compatible; ChatGPT-User/1.0)',
      'Mozilla/5.0 (compatible; Googlebot/2.1)'
    ]) {
      await paymentGate(req(ua), { gateway, meter: m })
    }
    expect(entries).toHaveLength(0)
  })

  it('does not meter a charged request — that is the gateway"s job', async () => {
    const { m, entries } = meter()
    const g = await paymentGate(req(GPTBOT), { gateway, meter: m, onTraining: 'charge' })
    expect(g.response?.status).toBe(402)
    expect(entries).toHaveLength(0)
  })

  it('survives a meter that throws', async () => {
    // A metering failure must not become a failed response.
    const g = await paymentGate(req(GPTBOT), {
      gateway,
      meter: { record: () => Promise.reject(new Error('warehouse down')) }
    })
    expect(g.response).toBeNull()
  })
})
