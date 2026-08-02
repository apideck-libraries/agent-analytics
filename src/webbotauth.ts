/**
 * Web Bot Auth — cryptographic agent verification.
 *
 * An RFC 9421 HTTP Message Signatures profile, backed by Cloudflare, Amazon,
 * Akamai and OpenAI, with an IETF working group chartered in 2026. An agent
 * signs each request with Ed25519 and publishes its public keys at a
 * well-known JWKS directory, so a site can verify the claim without knowing
 * anything about the agent in advance.
 *
 * This strictly dominates the published-IP-range check in `verify.ts`:
 *
 *   published ranges          Web Bot Auth
 *   4 vendors                 any agent that signs
 *   rots, needs refresh CI    no freshness problem
 *   stale list -> false       cannot produce a false 'spoofed'
 *     'spoofed' on real bots
 *   can't cover agents on     signable from anywhere
 *     the user's own machine
 *
 * Ranges remain the fallback for vendors that have not adopted signing yet.
 *
 * Three headers carry the proof:
 *   Signature-Agent: "https://operator.example.com"   <- key directory origin
 *   Signature-Input: sig=(...);keyid="...";tag="web-bot-auth";created=...
 *   Signature:       sig=:base64:
 */

import type { BotVerificationLike } from './types.js'

/** Where a signer publishes its keys, per the profile. */
const DIRECTORY_PATH = '/.well-known/http-message-signatures-directory'

export type WebBotAuthVerdict =
  | 'verified'
  | 'invalid-signature'
  | 'unknown-key'
  | 'expired'
  | 'malformed'
  | 'not-signed'

export interface WebBotAuthResult {
  verdict: WebBotAuthVerdict
  /** Origin from `Signature-Agent`, when the request carried one. */
  signerOrigin?: string
  /** JWK thumbprint the signature claimed. */
  keyId?: string
}

export interface WebBotAuthOptions {
  /** Override `fetch` (tests, pinned runtimes). */
  fetchImpl?: typeof fetch
  /** How long to cache a signer's key directory. Defaults to 1 hour. */
  keyTtlMs?: number
  /** Reject signatures older than this, independent of `expires`. Default 5 min. */
  maxAgeSeconds?: number
  /**
   * Restrict which origins may sign. Anything else is `unknown-key`. Leave
   * unset to accept any signer that presents a valid signature over keys it
   * publishes — the signature proves control of the origin, not that you want
   * to hear from it.
   */
  allowedSigners?: readonly string[]
}

interface CachedKeys {
  keys: Map<string, CryptoKey>
  expiresAt: number
}

const KEY_CACHE = new Map<string, Promise<CachedKeys>>()

/* -------------------------------------------------------------------------
 * Structured-field parsing
 *
 * A full RFC 8941 parser is far more than this profile needs. These handle the
 * shapes Web Bot Auth actually emits, and return null rather than guessing on
 * anything else — a malformed header must never read as a valid signature.
 * ---------------------------------------------------------------------- */

/** `"https://example.com"` -> `https://example.com` */
function parseSfString(raw: string | null): string | null {
  if (!raw) return null
  const m = raw.trim().match(/^"([^"]*)"$/)
  return m ? (m[1] ?? null) : null
}

export interface SignatureInput {
  label: string
  /** Covered component identifiers, in signing order. */
  components: string[]
  keyid?: string
  alg?: string
  tag?: string
  created?: number
  expires?: number
  /** The raw inner-list + params text, needed verbatim for the signature base. */
  raw: string
}

/** Parse `label=("a" "b");keyid="k";tag="web-bot-auth"`. */
export function parseSignatureInput(header: string | null): SignatureInput | null {
  if (!header) return null
  const m = header.trim().match(/^([A-Za-z0-9_-]+)=(\((.*?)\)(.*))$/)
  if (!m) return null
  const [, label, raw, inner, paramText] = m
  if (!label || raw === undefined) return null

  const components = (inner ?? '').match(/"[^"]*"(?:;[^ )]*)?/g)?.map((s) => s) ?? []

  const out: SignatureInput = { label, components, raw }
  for (const p of (paramText ?? '').split(';')) {
    const kv = p.match(/^([a-z]+)=(.*)$/)
    if (!kv) continue
    const [, k, vRaw] = kv
    const v = vRaw ?? ''
    const str = v.startsWith('"') ? v.slice(1, -1) : v
    if (k === 'keyid') out.keyid = str
    else if (k === 'alg') out.alg = str
    else if (k === 'tag') out.tag = str
    else if (k === 'created') out.created = Number(str)
    else if (k === 'expires') out.expires = Number(str)
  }
  return out
}

/** Parse `label=:base64:` into raw signature bytes. */
export function parseSignature(header: string | null, label: string): ArrayBuffer | null {
  if (!header) return null
  const m = header.match(new RegExp(`(?:^|,)\\s*${label}=:([A-Za-z0-9+/=]+):`))
  if (!m?.[1]) return null
  try {
    const bin = atob(m[1])
    const buf = new ArrayBuffer(bin.length)
    const out = new Uint8Array(buf)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return buf
  } catch {
    return null
  }
}

/**
 * Rebuild the RFC 9421 signature base: one line per covered component, then
 * the `@signature-params` line carrying the inner list verbatim.
 */
export function buildSignatureBase(req: Request, input: SignatureInput): string | null {
  const url = new URL(req.url)
  const lines: string[] = []

  for (const component of input.components) {
    const name = component.match(/^"([^"]*)"/)?.[1]
    if (name === undefined) return null
    let value: string | null

    switch (name) {
      case '@method':
        value = req.method.toUpperCase()
        break
      case '@authority':
        value = url.host
        break
      case '@scheme':
        value = url.protocol.replace(':', '')
        break
      case '@target-uri':
        value = url.toString()
        break
      case '@path':
        value = url.pathname
        break
      case '@query':
        value = url.search || '?'
        break
      default:
        // Anything else is a header name, lowercase per the spec.
        if (name.startsWith('@')) return null // derived component we don't model
        value = req.headers.get(name)
        break
    }

    // A covered component the request doesn't carry makes the base
    // unreconstructable — that is a verification failure, not a skip.
    if (value === null) return null
    lines.push(`${component}: ${value.trim()}`)
  }

  lines.push(`"@signature-params": ${input.raw}`)
  return lines.join('\n')
}

/* ------------------------------------------------------------------------ */

async function loadKeys(
  origin: string,
  opts: WebBotAuthOptions
): Promise<CachedKeys> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const ttl = opts.keyTtlMs ?? 3_600_000
  const res = await fetchImpl(`${origin}${DIRECTORY_PATH}`, {
    headers: { accept: 'application/http-message-signatures-directory+json, application/json' }
  })
  if (!res.ok) throw new Error(`key directory ${res.status}`)
  const body = (await res.json()) as { keys?: unknown[] }
  const keys = new Map<string, CryptoKey>()

  for (const raw of body.keys ?? []) {
    const jwk = raw as JsonWebKey & { kid?: string }
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') continue
    try {
      const key = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['verify'])
      // Index by both the advertised kid and the RFC 7638 thumbprint, since
      // the profile identifies keys by thumbprint but directories often also
      // publish a kid.
      if (jwk.kid) keys.set(jwk.kid, key)
      keys.set(await jwkThumbprint(jwk), key)
    } catch {
      // A single unusable key must not poison the whole directory.
    }
  }
  return { keys, expiresAt: Date.now() + ttl }
}

/** RFC 7638 JWK thumbprint, base64url of SHA-256 over the canonical members. */
export async function jwkThumbprint(jwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  let bin = ''
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function cachedKeys(origin: string, opts: WebBotAuthOptions): Promise<CachedKeys> {
  const hit = KEY_CACHE.get(origin)
  if (hit) {
    // Re-check expiry once resolved; a rejected or stale entry is dropped.
    return hit
      .then((c) => {
        if (c.expiresAt > Date.now()) return c
        KEY_CACHE.delete(origin)
        return cachedKeys(origin, opts)
      })
      .catch(() => {
        KEY_CACHE.delete(origin)
        return loadKeys(origin, opts)
      })
  }
  const p = loadKeys(origin, opts)
  KEY_CACHE.set(origin, p)
  // Don't cache a failed fetch.
  p.catch(() => KEY_CACHE.delete(origin))
  return p
}

/** Drop cached signer keys. Exposed for tests and key-rotation handling. */
export function clearKeyCache(): void {
  KEY_CACHE.clear()
}

/**
 * Verify a request's Web Bot Auth signature.
 *
 * Requires a network fetch the first time a signer is seen; keys are then
 * cached per origin for `keyTtlMs`. Unsigned requests return `'not-signed'`
 * immediately with no I/O, which is the overwhelmingly common path today.
 */
export async function verifyWebBotAuth(
  req: Request,
  opts: WebBotAuthOptions = {}
): Promise<WebBotAuthResult> {
  const agentHeader = req.headers.get('signature-agent')
  const inputHeader = req.headers.get('signature-input')
  const sigHeader = req.headers.get('signature')
  if (!inputHeader || !sigHeader) return { verdict: 'not-signed' }

  const input = parseSignatureInput(inputHeader)
  if (!input) return { verdict: 'malformed' }
  // The tag scopes a signature to bot authentication. Without it, this is some
  // other RFC 9421 use and not ours to judge.
  if (input.tag && input.tag !== 'web-bot-auth') return { verdict: 'not-signed' }

  const signerOrigin = parseSfString(agentHeader)
  if (!signerOrigin) return { verdict: 'malformed' }
  let origin: string
  try {
    const u = new URL(signerOrigin)
    if (u.protocol !== 'https:') return { verdict: 'malformed' }
    origin = u.origin
  } catch {
    return { verdict: 'malformed' }
  }

  if (opts.allowedSigners && !opts.allowedSigners.includes(origin)) {
    return { verdict: 'unknown-key', signerOrigin: origin, ...(input.keyid ? { keyId: input.keyid } : {}) }
  }

  const now = Math.floor(Date.now() / 1000)
  const maxAge = opts.maxAgeSeconds ?? 300
  if (input.expires !== undefined && input.expires < now) {
    return { verdict: 'expired', signerOrigin: origin }
  }
  if (input.created !== undefined && now - input.created > maxAge) {
    return { verdict: 'expired', signerOrigin: origin }
  }

  const base = buildSignatureBase(req, input)
  if (!base) return { verdict: 'malformed', signerOrigin: origin }

  const sig = parseSignature(sigHeader, input.label)
  if (!sig) return { verdict: 'malformed', signerOrigin: origin }

  let keys: CachedKeys
  try {
    keys = await cachedKeys(origin, opts)
  } catch {
    // Directory unreachable — we cannot judge, and must not call it invalid.
    return { verdict: 'unknown-key', signerOrigin: origin }
  }

  const key = input.keyid ? keys.keys.get(input.keyid) : undefined
  if (!key) {
    return { verdict: 'unknown-key', signerOrigin: origin, ...(input.keyid ? { keyId: input.keyid } : {}) }
  }

  const ok = await crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    sig,
    new TextEncoder().encode(base)
  )
  return {
    verdict: ok ? 'verified' : 'invalid-signature',
    signerOrigin: origin,
    ...(input.keyid ? { keyId: input.keyid } : {})
  }
}

/**
 * Adapter to the shared verdict shape used by `trackVisit` and `agentPolicy`.
 *
 * Deliberately conservative about `spoofed`: only a signature that is present
 * and fails cryptographically earns it. A missing signature is `unverifiable`,
 * because most agents do not sign yet and treating silence as forgery would
 * mislabel nearly all real traffic.
 */
export function webBotAuthVerifier(
  opts: WebBotAuthOptions = {}
): (req: Request) => Promise<BotVerificationLike> {
  return async (req: Request): Promise<BotVerificationLike> => {
    const r = await verifyWebBotAuth(req, opts)
    switch (r.verdict) {
      case 'verified':
        return { verdict: 'verified', verified: true, reason: 'web-bot-auth' }
      case 'invalid-signature':
        return { verdict: 'spoofed', verified: false, reason: 'web-bot-auth-signature-invalid' }
      case 'expired':
        return { verdict: 'spoofed', verified: false, reason: 'web-bot-auth-expired' }
      case 'malformed':
      case 'unknown-key':
        return { verdict: 'unverifiable', verified: null, reason: `web-bot-auth-${r.verdict}` }
      default:
        return { verdict: 'unverifiable', verified: null, reason: 'not-signed' }
    }
  }
}
