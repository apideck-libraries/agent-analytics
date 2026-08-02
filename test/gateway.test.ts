import { describe, expect, it, vi } from 'vitest'
import { mppxGateway, paymentGate, x402Gateway, type MppxResponse } from '../src/gateway.js'

const X402 = {
  protocol: 'x402' as const,
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: '1000',
      resource: 'https://example.com/docs',
      payTo: '0xabc',
      asset: '0xusdc'
    }
  ]
}

const req = (ua: string, headers: Record<string, string> = {}) =>
  new Request('https://example.com/docs', { headers: { 'user-agent': ua, ...headers } })

const GPTBOT = 'Mozilla/5.0 (compatible; GPTBot/1.1)'
const CHATGPT_USER = 'Mozilla/5.0 (compatible; ChatGPT-User/1.0)'

describe('x402Gateway', () => {
  it('challenges an unpaid request', async () => {
    const g = x402Gateway({ challenges: [X402], settle: () => true })
    const out = await g.handle(req(GPTBOT))
    expect(out.status).toBe('challenge')
    if (out.status === 'challenge') expect(out.response.status).toBe(402)
  })

  it('serves once the facilitator settles', async () => {
    const settle = vi.fn().mockResolvedValue(true)
    const g = x402Gateway({ challenges: [X402], settle })
    const out = await g.handle(req(GPTBOT, { 'PAYMENT-SIGNATURE': 'sig' }))
    expect(out.status).toBe('paid')
    expect(settle).toHaveBeenCalledWith('sig', expect.anything())
  })

  it('re-challenges when the facilitator rejects the payload', async () => {
    // Presence of a header is not proof of payment.
    const g = x402Gateway({ challenges: [X402], settle: () => false })
    const out = await g.handle(req(GPTBOT, { 'PAYMENT-SIGNATURE': 'forged' }))
    expect(out.status).toBe('challenge')
  })
})

describe('mppxGateway', () => {
  it('passes through Stripe MPP challenges', async () => {
    const handler = (): MppxResponse => ({
      status: 402,
      challenge: new Response('pay up', { status: 402 })
    })
    const out = await mppxGateway(handler).handle(req(GPTBOT))
    expect(out.status).toBe('challenge')
  })

  it('returns the receipt decorator once settled', async () => {
    const handler = (): MppxResponse => ({
      status: 200,
      challenge: new Response(null, { status: 402 }),
      withReceipt: (res) => {
        const h = new Headers(res.headers)
        h.set('x-mpp-receipt', 'rcpt_1')
        return new Response(res.body, { status: res.status, headers: h })
      }
    })
    const out = await mppxGateway(handler).handle(req(GPTBOT))
    expect(out.status).toBe('paid')
    if (out.status === 'paid') {
      const decorated = out.receipt!(new Response('the goods'))
      expect(decorated.headers.get('x-mpp-receipt')).toBe('rcpt_1')
      expect(await decorated.text()).toBe('the goods')
    }
  })
})

describe('paymentGate', () => {
  const gateway = x402Gateway({ challenges: [X402], settle: (s) => s === 'good' })

  it('charges training crawls', async () => {
    const g = await paymentGate(req(GPTBOT), { gateway, onTraining: 'charge' })
    expect(g.decision.intent).toBe('training')
    expect(g.response?.status).toBe(402)
  })

  it('never gates retrieval', async () => {
    // The whole thesis: a person is waiting on this answer.
    const g = await paymentGate(req(CHATGPT_USER), { gateway, onTraining: 'charge' })
    expect(g.decision.intent).toBe('retrieval')
    expect(g.response).toBeNull()
  })

  it('serves metered traffic rather than gating it', async () => {
    const g = await paymentGate(req(GPTBOT), { gateway })
    expect(g.decision.action).toBe('meter')
    expect(g.response).toBeNull()
  })

  it('serves a paid retry and hands back the decorator', async () => {
    const g = await paymentGate(req(GPTBOT, { 'PAYMENT-SIGNATURE': 'good' }), {
      gateway,
      onTraining: 'charge'
    })
    expect(g.response).toBeNull()
    expect(g.decorate(new Response('ok'))).toBeInstanceOf(Response)
  })

  it('reports every decision so metering can count it', async () => {
    const seen: string[] = []
    for (const ua of [GPTBOT, CHATGPT_USER, 'Googlebot/2.1']) {
      await paymentGate(req(ua), { gateway, onDecision: (d) => seen.push(d.action) })
    }
    expect(seen).toEqual(['meter', 'allow', 'allow'])
  })

  it('blocks a spoofed identity with 403 rather than a price', async () => {
    const g = await paymentGate(req(CHATGPT_USER, { 'x-forwarded-for': '1.2.3.4' }), {
      gateway,
      onTraining: 'charge',
      verify: () => ({ verdict: 'spoofed', verified: false })
    })
    expect(g.response?.status).toBe(403)
  })
})
