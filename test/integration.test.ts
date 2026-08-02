import { describe, expect, it, vi } from 'vitest'
import { customAnalytics } from '../src/adapters/custom.js'
import { classifyRequest } from '../src/bots.js'
import { paymentGate, x402Gateway } from '../src/gateway.js'
import { agentIntent, agentPolicy } from '../src/policy.js'
import { trackVisit } from '../src/track.js'
import type { CaptureEvent } from '../src/types.js'
import { combinedVerifier, verifyRequest } from '../src/verify.js'

/* ===========================================================================
 * Integration: the composed stack, not the pieces.
 *
 * Every bug found in this library after its unit suite went green was a
 * composition bug — each layer correct alone, contradicting the next:
 *
 *   - `agentIntent` returned 'unknown' where `agentPolicy` returned 'tooling',
 *     for every HTTP-library UA. Both exported, both "passing".
 *   - `paymentGate` silently ignored an async verifier, so a spoofed ClaudeBot
 *     was charged (402) instead of blocked (403). Every unit test passed.
 *
 * So these tests assert two things unit tests structurally cannot:
 *
 *   1. End-to-end outcomes for realistic requests — one table, request in,
 *      HTTP status and emitted event out.
 *   2. Cross-layer invariants — properties that must hold between layers,
 *      whatever each layer does internally.
 * ======================================================================== */

const ANTHROPIC_IP = '34.162.230.222' // in Anthropic's published range
const OPENAI_IP = '104.208.184.193' // in OpenAI's published range
const DATACENTRE_IP = '45.55.50.205' // DigitalOcean, in nobody's range

const ACCEPTS = [
  {
    scheme: 'exact',
    network: 'base',
    maxAmountRequired: '1000',
    resource: 'https://example.com/docs',
    payTo: '0xabc',
    asset: '0xusdc'
  }
]

const BROWSER_HEADERS = {
  'accept-language': 'en-GB,en;q=0.9',
  'sec-fetch-mode': 'navigate',
  'sec-ch-ua': '"Chromium";v="120"',
  accept: 'text/html,application/xhtml+xml'
}

function request(ua: string, headers: Record<string, string> = {}) {
  return new Request('https://example.com/docs', { headers: { 'user-agent': ua, ...headers } })
}

function gateway(settleWith: (sig: string) => boolean = (s) => s === 'paid') {
  return x402Gateway({
    challenges: [{ protocol: 'x402', accepts: ACCEPTS }],
    settle: settleWith
  })
}

/** Run the whole path a real middleware would: gate, then record. */
async function handle(
  req: Request,
  opts: { onTraining?: 'meter' | 'charge'; verify?: boolean } = {}
) {
  const spy = vi.fn()
  const gate = await paymentGate(req, {
    gateway: gateway(),
    ...(opts.onTraining ? { onTraining: opts.onTraining } : {}),
    ...(opts.verify ? { verify: combinedVerifier() } : {})
  })
  await trackVisit(req, {
    analytics: customAnalytics(spy),
    idSecret: 'integration-secret',
    properties: { action: gate.decision.action, intent: gate.decision.intent }
  })
  const event = spy.mock.calls[0]?.[0] as CaptureEvent | undefined
  return { gate, event, status: gate.response?.status ?? 200 }
}

/* --------------------------------------------------------------------------
 * 1. End-to-end table
 * ----------------------------------------------------------------------- */

interface Row {
  name: string
  ua: string
  headers?: Record<string, string>
  charge?: boolean
  verify?: boolean
  status: number
  intent: string
  action: string
  botName: string
}

const MATRIX: Row[] = [
  {
    name: 'training crawl, metering only',
    ua: 'Mozilla/5.0 (compatible; GPTBot/1.1)',
    status: 200,
    intent: 'training',
    action: 'meter',
    botName: 'ChatGPT'
  },
  {
    name: 'training crawl, charging',
    ua: 'Mozilla/5.0 (compatible; GPTBot/1.1)',
    charge: true,
    status: 402,
    intent: 'training',
    action: 'charge',
    botName: 'ChatGPT'
  },
  {
    name: 'training crawl that already paid',
    ua: 'Mozilla/5.0 (compatible; GPTBot/1.1)',
    headers: { 'PAYMENT-SIGNATURE': 'paid' },
    charge: true,
    status: 200,
    intent: 'training',
    action: 'charge',
    botName: 'ChatGPT'
  },
  {
    name: 'retrieval is never charged',
    ua: 'Mozilla/5.0 (compatible; ChatGPT-User/1.0)',
    headers: { 'x-forwarded-for': OPENAI_IP },
    charge: true,
    verify: true,
    status: 200,
    intent: 'retrieval',
    action: 'allow',
    botName: 'ChatGPT'
  },
  {
    name: 'verified crawler is charged, not blocked',
    ua: 'Mozilla/5.0 (compatible; ClaudeBot/1.0)',
    headers: { 'x-forwarded-for': ANTHROPIC_IP },
    charge: true,
    verify: true,
    status: 402,
    intent: 'training',
    action: 'charge',
    botName: 'Claude'
  },
  {
    name: 'spoofed crawler is blocked, not charged',
    ua: 'Mozilla/5.0 (compatible; ClaudeBot/1.0)',
    headers: { 'x-forwarded-for': DATACENTRE_IP },
    charge: true,
    verify: true,
    status: 403,
    intent: 'training',
    action: 'block',
    botName: 'Claude'
  },
  {
    name: 'coding agent on a laptop is not accused',
    ua: 'Claude-User (claude-code/2.1.218)',
    headers: { 'x-forwarded-for': '109.135.42.185' },
    charge: true,
    verify: true,
    status: 200,
    intent: 'retrieval',
    action: 'allow',
    botName: 'Claude'
  },
  {
    name: 'search crawler stays free',
    ua: 'Mozilla/5.0 (compatible; Googlebot/2.1)',
    charge: true,
    status: 200,
    intent: 'search',
    action: 'allow',
    botName: 'Google'
  },
  {
    name: 'vendor with no published feed is not blocked',
    ua: 'Mozilla/5.0 (compatible; Bytespider/1.0)',
    headers: { 'x-forwarded-for': DATACENTRE_IP },
    charge: true,
    verify: true,
    status: 402,
    intent: 'training',
    action: 'charge',
    botName: 'Bytespider'
  },
  {
    name: 'real browser passes through untouched',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    headers: BROWSER_HEADERS,
    charge: true,
    status: 200,
    intent: 'unknown',
    action: 'allow',
    botName: 'Browser'
  },
  {
    name: 'headless automation is labelled Headless, not Browser',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    charge: true,
    status: 200,
    intent: 'unknown',
    action: 'allow',
    botName: 'Headless'
  },
  {
    name: 'bare HTTP client is tooling',
    ua: 'curl/8.4.0',
    charge: true,
    status: 200,
    intent: 'tooling',
    action: 'allow',
    botName: 'curl'
  }
]

describe('end-to-end: request in, status and event out', () => {
  it.each(MATRIX)('$name', async (row) => {
    const { status, gate, event } = await handle(request(row.ua, row.headers), {
      ...(row.charge ? { onTraining: 'charge' as const } : {}),
      ...(row.verify ? { verify: true } : {})
    })
    expect({
      status,
      intent: gate.decision.intent,
      action: gate.decision.action,
      botName: event?.properties.bot_name
    }).toEqual({
      status: row.status,
      intent: row.intent,
      action: row.action,
      botName: row.botName
    })
  })
})

/* --------------------------------------------------------------------------
 * 2. Cross-layer invariants
 *
 * Each of these can hold inside every layer and still be violated between
 * them. That is the class of bug this file exists for.
 * ----------------------------------------------------------------------- */

const EXTRA: Array<[string, Record<string, string>]> = [
  ['axios/1.8.4', {}],
  ['python-requests/2.31.0', {}],
  ['Mozilla/5.0 (compatible; Applebot/0.1)', {}],
  ['Mozilla/5.0 (compatible; Applebot-Extended/0.1)', {}],
  ['Mozilla/5.0 (compatible; PerplexityBot/1.0)', { 'x-forwarded-for': '107.20.236.150' }],
  ['Mozilla/5.0 (compatible; Perplexity-User/1.0)', {}],
  ['meta-externalagent/1.1', {}],
  ['', {}]
]

/** Everything in the matrix, plus shapes worth holding to the invariants. */
const CORPUS: Array<[string, Record<string, string>]> = [
  ...MATRIX.map((r): [string, Record<string, string>] => [r.ua, r.headers ?? {}]),
  ...EXTRA
]

describe('cross-layer invariants', () => {
  it('agentIntent agrees with the intent agentPolicy reports', async () => {
    // The exact divergence that shipped: two exported functions, same question.
    for (const [ua, headers] of CORPUS) {
      const req = request(ua, headers)
      expect(agentIntent(ua), `intent mismatch for ${ua || '(empty)'}`).toBe(
        agentPolicy(req).intent
      )
    }
  })

  it('the emitted event never contradicts the classifier', async () => {
    for (const [ua, headers] of CORPUS) {
      const req = request(ua, headers)
      const c = classifyRequest(req)
      const spy = vi.fn()
      await trackVisit(req, { analytics: customAnalytics(spy), idSecret: 's' })
      const p = (spy.mock.calls[0]![0] as CaptureEvent).properties
      expect({ n: p.bot_name, k: p.ua_category, ai: p.is_ai_bot }, `event vs classifier: ${ua}`).toEqual(
        { n: c.label, k: c.kind, ai: c.isAiBot }
      )
    }
  })

  it('an async verifier actually reaches the decision', async () => {
    // paymentGate once accepted a verifier and dropped it on the floor, so a
    // spoofed identity was priced instead of refused.
    const spoofed = request('Mozilla/5.0 (compatible; ClaudeBot/1.0)', {
      'x-forwarded-for': DATACENTRE_IP
    })
    const withVerify = await paymentGate(spoofed, {
      gateway: gateway(),
      onTraining: 'charge',
      verify: combinedVerifier()
    })
    const withoutVerify = await paymentGate(spoofed, {
      gateway: gateway(),
      onTraining: 'charge'
    })
    expect(withVerify.decision.action).toBe('block')
    expect(withVerify.response?.status).toBe(403)
    // Without verification the same request is merely charged — proving the
    // verifier changed the outcome rather than being ignored.
    expect(withoutVerify.decision.action).toBe('charge')
    expect(withoutVerify.response?.status).toBe(402)
  })

  it('a spoofed verdict always blocks, and never merely prices', async () => {
    for (const action of ['meter', 'charge'] as const) {
      const g = await paymentGate(
        request('Mozilla/5.0 (compatible; ChatGPT-User/1.0)', {
          'x-forwarded-for': DATACENTRE_IP
        }),
        { gateway: gateway(), onTraining: action, verify: combinedVerifier() }
      )
      expect(g.decision.verification).toBe('spoofed')
      expect(g.decision.action).toBe('block')
      expect(g.response?.status).toBe(403)
    }
  })

  it('retrieval is never gated, under any policy configuration', async () => {
    // Charging the channel that sends you readers is the one outcome the whole
    // design exists to prevent, so it is asserted against every knob.
    const retrieval = [
      'Mozilla/5.0 (compatible; ChatGPT-User/1.0)',
      'Claude-User (claude-code/2.1.218)',
      'Mozilla/5.0 (compatible; Perplexity-User/1.0)'
    ]
    for (const ua of retrieval) {
      for (const onTraining of ['meter', 'charge'] as const) {
        for (const verify of [false, true]) {
          const g = await paymentGate(request(ua, { 'x-forwarded-for': OPENAI_IP }), {
            gateway: gateway(),
            onTraining,
            ...(verify ? { verify: combinedVerifier() } : {})
          })
          expect(g.decision.intent, `${ua} verify=${verify}`).toBe('retrieval')
          expect(g.response, `${ua} onTraining=${onTraining} verify=${verify}`).toBeNull()
        }
      }
    }
  })

  it('unverifiable never becomes spoofed anywhere in the stack', async () => {
    // Vendors with no published feed, and agents on a user's own machine, must
    // not be refused just because we cannot check them.
    const unknowable: Array<[string, string]> = [
      ['Mozilla/5.0 (compatible; Bytespider/1.0)', DATACENTRE_IP],
      ['Mozilla/5.0 (compatible; Amazonbot/0.1)', DATACENTRE_IP],
      ['Claude-User (claude-code/2.1.218)', '109.135.42.185']
    ]
    for (const [ua, ip] of unknowable) {
      const req = request(ua, { 'x-forwarded-for': ip })
      expect(verifyRequest(req).verdict).not.toBe('spoofed')
      const g = await paymentGate(req, {
        gateway: gateway(),
        onTraining: 'charge',
        verify: combinedVerifier()
      })
      expect(g.decision.action, ua).not.toBe('block')
    }
  })

  it('never emits a raw IP unless captureIp is set, whatever else is on', async () => {
    for (const [ua] of CORPUS) {
      const spy = vi.fn()
      await trackVisit(request(ua, { 'x-forwarded-for': '203.0.113.9' }), {
        analytics: customAnalytics(spy),
        idSecret: 's',
        captureCountry: true,
        captureGeo: true,
        verify: verifyRequest
      })
      const e = spy.mock.calls[0]?.[0]
      if (e) expect(JSON.stringify(e), ua).not.toContain('203.0.113.9')
    }
  })
})
