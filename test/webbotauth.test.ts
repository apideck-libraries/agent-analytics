import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildSignatureBase,
  clearKeyCache,
  jwkThumbprint,
  parseSignatureInput,
  verifyWebBotAuth,
  webBotAuthVerifier
} from '../src/webbotauth.js'
import { combinedVerifier } from '../src/verify.js'

/* ---------------------------------------------------------------------------
 * A real signer. Generating a keypair and signing the RFC 9421 signature base
 * end-to-end is the only test that proves this works — hand-rolled fixtures
 * would just encode whatever my parser happens to do.
 * ------------------------------------------------------------------------ */

const SIGNER = 'https://operator.example.com'

async function makeSigner() {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify'
  ])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey)
  const kid = await jwkThumbprint(jwk)
  const directory = { keys: [{ ...jwk, kid }] }

  const fetchImpl = (async (url: string | URL) => {
    if (String(url) === `${SIGNER}/.well-known/http-message-signatures-directory`) {
      return new Response(JSON.stringify(directory), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch

  async function sign(
    req: Request,
    { created = Math.floor(Date.now() / 1000), expires }: { created?: number; expires?: number } = {}
  ) {
    const components = ['"@authority"', '"@path"', '"signature-agent"']
    const params =
      `;created=${created}` +
      (expires !== undefined ? `;expires=${expires}` : '') +
      `;keyid="${kid}";alg="ed25519";tag="web-bot-auth"`
    const raw = `(${components.join(' ')})${params}`
    const input = parseSignatureInput(`sig=${raw}`)!
    const base = buildSignatureBase(req, input)!
    const sig = await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, new TextEncoder().encode(base))
    let bin = ''
    for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b)
    const headers = new Headers(req.headers)
    headers.set('signature-input', `sig=${raw}`)
    headers.set('signature', `sig=:${btoa(bin)}:`)
    return new Request(req.url, { method: req.method, headers })
  }

  return { fetchImpl, sign, kid }
}

function baseRequest(path = '/docs/intro') {
  return new Request(`https://example.com${path}`, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; ExampleBot/1.0)',
      'signature-agent': `"${SIGNER}"`
    }
  })
}

describe('verifyWebBotAuth', () => {
  beforeEach(() => clearKeyCache())

  it('verifies a genuinely signed request', async () => {
    const { fetchImpl, sign, kid } = await makeSigner()
    const signed = await sign(baseRequest())
    const r = await verifyWebBotAuth(signed, { fetchImpl })
    expect(r.verdict).toBe('verified')
    expect(r.signerOrigin).toBe(SIGNER)
    expect(r.keyId).toBe(kid)
  })

  it('rejects a signature over a different path', async () => {
    // Replaying a valid signature onto another URL must fail: @path is covered.
    const { fetchImpl, sign } = await makeSigner()
    const signed = await sign(baseRequest('/docs/intro'))
    const replayed = new Request('https://example.com/admin', {
      method: signed.method,
      headers: signed.headers
    })
    expect((await verifyWebBotAuth(replayed, { fetchImpl })).verdict).toBe('invalid-signature')
  })

  it('rejects a tampered signature', async () => {
    const { fetchImpl, sign } = await makeSigner()
    const signed = await sign(baseRequest())
    const headers = new Headers(signed.headers)
    const raw = headers.get('signature')!
    // Flip a byte inside the base64 payload.
    headers.set('signature', raw.replace(/:(.)/, (_m, c: string) => ':' + (c === 'A' ? 'B' : 'A')))
    const tampered = new Request(signed.url, { headers })
    expect((await verifyWebBotAuth(tampered, { fetchImpl })).verdict).toBe('invalid-signature')
  })

  it('rejects a signature signed by a key the directory does not publish', async () => {
    const a = await makeSigner()
    const b = await makeSigner()
    // Signed by b, but verified against a's directory.
    const signed = await b.sign(baseRequest())
    expect((await verifyWebBotAuth(signed, { fetchImpl: a.fetchImpl })).verdict).toBe('unknown-key')
  })

  it('rejects an expired signature', async () => {
    const { fetchImpl, sign } = await makeSigner()
    const past = Math.floor(Date.now() / 1000) - 600
    const signed = await sign(baseRequest(), { created: past, expires: past + 60 })
    expect((await verifyWebBotAuth(signed, { fetchImpl })).verdict).toBe('expired')
  })

  it('rejects a signature older than maxAgeSeconds even without expires', async () => {
    const { fetchImpl, sign } = await makeSigner()
    const signed = await sign(baseRequest(), { created: Math.floor(Date.now() / 1000) - 3600 })
    expect((await verifyWebBotAuth(signed, { fetchImpl })).verdict).toBe('expired')
  })

  it('honours allowedSigners', async () => {
    const { fetchImpl, sign } = await makeSigner()
    const signed = await sign(baseRequest())
    const r = await verifyWebBotAuth(signed, { fetchImpl, allowedSigners: ['https://other.example'] })
    expect(r.verdict).toBe('unknown-key')
  })

  it('reports not-signed without any network call', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response('{}')
    }) as unknown as typeof fetch
    const r = await verifyWebBotAuth(baseRequest(), { fetchImpl })
    expect(r.verdict).toBe('not-signed')
    // The common path today is unsigned traffic; it must cost nothing.
    expect(called).toBe(false)
  })

  it('treats an unreachable key directory as unverifiable, not invalid', async () => {
    const { sign } = await makeSigner()
    const signed = await sign(baseRequest())
    const dead = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    expect((await verifyWebBotAuth(signed, { fetchImpl: dead })).verdict).toBe('unknown-key')
  })

  it('rejects a non-https signer origin', async () => {
    const { fetchImpl, sign } = await makeSigner()
    const signed = await sign(baseRequest())
    const headers = new Headers(signed.headers)
    headers.set('signature-agent', '"http://operator.example.com"')
    expect(
      (await verifyWebBotAuth(new Request(signed.url, { headers }), { fetchImpl })).verdict
    ).toBe('malformed')
  })

  it('caches the key directory across requests', async () => {
    const { fetchImpl, sign } = await makeSigner()
    let fetches = 0
    const counting = (async (u: string | URL) => {
      fetches++
      return fetchImpl(u as string)
    }) as unknown as typeof fetch
    const a = await sign(baseRequest('/a'))
    const b = await sign(baseRequest('/b'))
    await verifyWebBotAuth(a, { fetchImpl: counting })
    await verifyWebBotAuth(b, { fetchImpl: counting })
    expect(fetches).toBe(1)
  })
})

describe('webBotAuthVerifier adapter', () => {
  beforeEach(() => clearKeyCache())

  it('maps a valid signature to verified', async () => {
    const { fetchImpl, sign } = await makeSigner()
    const v = webBotAuthVerifier({ fetchImpl })
    expect(await v(await sign(baseRequest()))).toMatchObject({ verdict: 'verified', verified: true })
  })

  it('maps unsigned traffic to unverifiable, never spoofed', async () => {
    // Most agents do not sign yet. Calling silence forgery would mislabel
    // nearly all real traffic.
    const v = webBotAuthVerifier()
    expect(await v(baseRequest())).toMatchObject({ verdict: 'unverifiable', verified: null })
  })
})

describe('combinedVerifier', () => {
  beforeEach(() => clearKeyCache())

  it('prefers a valid signature over the IP range check', async () => {
    const { fetchImpl, sign } = await makeSigner()
    // A UA claiming nothing, from an IP in no published range — the range check
    // alone could never call this verified.
    const v = combinedVerifier({ fetchImpl })
    const r = await v(await sign(baseRequest()))
    expect(r).toMatchObject({ verdict: 'verified', reason: 'web-bot-auth' })
  })

  it('lets a failed signature win over a matching IP range', async () => {
    // Anti-laundering: a forged signature from a genuine crawler IP must not be
    // rescued by the weaker check.
    const a = await makeSigner()
    const b = await makeSigner()
    const req = new Request('https://example.com/', {
      headers: {
        'user-agent': 'ClaudeBot/1.0',
        'x-forwarded-for': '34.162.230.222', // really is in Anthropic's range
        'signature-agent': `"${SIGNER}"`
      }
    })
    const signed = await b.sign(req)
    // b's key is not in a's directory -> unknown-key -> falls through to ranges
    const unknown = await combinedVerifier({ fetchImpl: a.fetchImpl })(signed)
    expect(unknown.verdict).toBe('verified') // range check still applies

    // Same signer origin, different directory: clear the cache, which is
    // correctly keyed by origin and would otherwise serve a's keys for b.
    clearKeyCache()

    // An actually-invalid signature is decisive.
    const headers = new Headers(signed.headers)
    headers.set('signature-input', signed.headers.get('signature-input')!)
    const tampered = new Request('https://example.com/other', { headers })
    const bad = await combinedVerifier({ fetchImpl: b.fetchImpl })(tampered)
    expect(bad.verdict).toBe('spoofed')
  })

  it('falls back to published ranges for unsigned traffic', async () => {
    const v = combinedVerifier()
    const req = new Request('https://example.com/', {
      headers: { 'user-agent': 'ClaudeBot/1.0', 'x-forwarded-for': '34.162.230.222' }
    })
    expect(await v(req)).toMatchObject({ verdict: 'verified' })
  })
})
