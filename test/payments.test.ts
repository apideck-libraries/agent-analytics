import { describe, expect, it } from 'vitest'
import { agentPolicy } from '../src/policy.js'
import {
  hasPaymentPayload,
  paymentPayload,
  paymentRequired,
  respondToDecision,
  withSettlement
} from '../src/payments.js'

const X402 = {
  protocol: 'x402' as const,
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: '1000',
      resource: 'https://example.com/docs/intro',
      description: 'Training crawl of one page',
      payTo: '0xabc',
      asset: '0xusdc'
    }
  ]
}

const MPP = {
  protocol: 'mpp' as const,
  id: 'chal_123',
  realm: 'example.com',
  method: 'tempo',
  intent: 'charge'
}

function decode(res: Response) {
  const raw = res.headers.get('PAYMENT-REQUIRED')!
  const bin = atob(raw)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

describe('paymentRequired', () => {
  it('emits a 402 carrying a base64 x402 challenge', () => {
    const res = paymentRequired({ challenges: [X402] })
    expect(res.status).toBe(402)
    const body = decode(res)
    expect(body.x402Version).toBe(1)
    expect(body.accepts).toHaveLength(1)
    expect(body.accepts[0]).toMatchObject({ scheme: 'exact', payTo: '0xabc', asset: '0xusdc' })
  })

  it('advertises training as for sale, not forbidden', () => {
    // The default Content-Signal elsewhere in the library is ai-train=no. The
    // entire premise here is the opposite.
    expect(paymentRequired({ challenges: [X402] }).headers.get('content-signal')).toBe(
      'search=yes, ai-input=yes, ai-train=paid'
    )
  })

  it('survives non-ASCII in the challenge', () => {
    // btoa is Latin-1 only; a naive implementation throws on this.
    const res = paymentRequired({
      challenges: [{ ...X402, accepts: [{ ...X402.accepts[0]!, description: 'Entraînement — 訓練 🤖' }] }]
    })
    expect(decode(res).accepts[0].description).toBe('Entraînement — 訓練 🤖')
  })

  it('refuses to emit a challenge with no way to pay', () => {
    expect(() => paymentRequired({ challenges: [] })).toThrow(/at least one/)
    expect(() => paymentRequired({ challenges: [{ protocol: 'x402', accepts: [] }] })).toThrow(
      /at least one/
    )
  })
})

describe('payment payload', () => {
  it('detects the retry that carries payment', () => {
    const bare = new Request('https://example.com/')
    const paid = new Request('https://example.com/', {
      headers: { 'PAYMENT-SIGNATURE': 'base64payload' }
    })
    expect(hasPaymentPayload(bare)).toBe(false)
    expect(hasPaymentPayload(paid)).toBe(true)
    expect(paymentPayload(paid)).toEqual({ protocol: 'x402', value: 'base64payload' })
  })

  it('attaches a settlement result without disturbing the body', async () => {
    const out = withSettlement(new Response('the goods', { status: 200 }), { success: true })
    expect(out.status).toBe(200)
    expect(await out.text()).toBe('the goods')
    expect(out.headers.get('PAYMENT-RESPONSE')).toBeTruthy()
  })
})

describe('respondToDecision', () => {
  const req = (ua: string) =>
    new Request('https://example.com/docs', { headers: { 'user-agent': ua } })

  it('charges training crawlers when configured to', () => {
    const d = agentPolicy(req('GPTBot/1.1'), { onTraining: 'charge' })
    const res = respondToDecision(d, { challenges: [X402] })
    expect(res?.status).toBe(402)
  })

  it('never charges retrieval, even under the same policy', async () => {
    // Charging a person's question is charging your own distribution channel.
    const d = agentPolicy(req('ChatGPT-User/1.0'), { onTraining: 'charge' })
    expect(respondToDecision(d, { challenges: [X402] })).toBeNull()
  })

  it('lets search crawlers through free', () => {
    const d = agentPolicy(req('Googlebot/2.1'), { onTraining: 'charge' })
    expect(respondToDecision(d, { challenges: [X402] })).toBeNull()
  })

  it('serves metered traffic rather than gating it', () => {
    // meter is an accounting concern; the request is still fulfilled.
    const d = agentPolicy(req('GPTBot/1.1'))
    expect(d.action).toBe('meter')
    expect(respondToDecision(d, { challenges: [X402] })).toBeNull()
  })

  it('blocks a failed identity check with 403, not a price', () => {
    const d = { action: 'block' as const, intent: 'training' as const, label: 'Claude', reason: 'spoofed' }
    expect(respondToDecision(d, { challenges: [X402] })?.status).toBe(403)
  })
})

describe('MPP', () => {
  it('emits a WWW-Authenticate Payment challenge', () => {
    const res = paymentRequired({ challenges: [MPP] })
    expect(res.status).toBe(402)
    const h = res.headers.get('WWW-Authenticate')!
    expect(h).toMatch(/^Payment /)
    expect(h).toContain('id="chal_123"')
    expect(h).toContain('realm="example.com"')
    expect(h).toContain('method="tempo"')
    expect(h).toContain('intent="charge"')
  })

  it('advertises x402 and MPP on the same 402', () => {
    // Non-colliding headers, so one response can offer both and the agent
    // takes whichever it speaks.
    const res = paymentRequired({ challenges: [X402, MPP] })
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeTruthy()
    expect(res.headers.get('WWW-Authenticate')).toMatch(/^Payment /)
  })

  it('reads an MPP credential from Authorization', () => {
    const req = new Request('https://example.com/', {
      headers: { Authorization: 'Payment cred=abc123' }
    })
    expect(paymentPayload(req)).toEqual({ protocol: 'mpp', value: 'cred=abc123' })
  })

  it('does not mistake ordinary auth for a payment', () => {
    // A site behind Bearer auth must not look like it already paid.
    for (const v of ['Bearer eyJhbGciOi', 'Basic dXNlcjpwYXNz']) {
      const req = new Request('https://example.com/', { headers: { Authorization: v } })
      expect(paymentPayload(req)).toBeNull()
      expect(hasPaymentPayload(req)).toBe(false)
    }
  })

  it('escapes quotes in auth-param values', () => {
    const res = paymentRequired({
      challenges: [{ ...MPP, realm: 'ex"ample' }]
    })
    expect(res.headers.get('WWW-Authenticate')).toContain('realm="ex\\"ample"')
  })

  it('lets the settlement header be named for the provider', () => {
    const out = withSettlement(new Response('ok'), { ok: true }, { header: 'Authentication-Info' })
    expect(out.headers.get('Authentication-Info')).toBeTruthy()
    expect(out.headers.get('PAYMENT-RESPONSE')).toBeNull()
  })
})
