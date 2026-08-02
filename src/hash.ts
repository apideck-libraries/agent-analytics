/**
 * Keyed, non-reversible anonymous identifiers.
 *
 * The previous implementation was an unsalted 32-bit djb2 over `ip:userAgent`.
 * Because the user agent is emitted in plaintext on the same event, an attacker
 * held half the preimage and only had to search the IPv4 space — recovering a
 * residential IP took 75 seconds single-threaded. That is pseudonymisation, not
 * anonymisation, and it does not survive GDPR Recital 26.
 *
 * This uses HMAC-SHA-256 with a caller-supplied secret, truncated to 64 bits.
 * Web Crypto is available on Vercel Edge, Cloudflare Workers, Deno and Node 18+.
 */

/** Thrown when a secret is missing or unusable. */
export class HashSecretError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HashSecretError'
  }
}

/**
 * Web Crypto, or a clear error explaining why it is missing.
 *
 * `globalThis.crypto` is present by default from Node 19; on Node 18 it sat
 * behind `--experimental-global-webcrypto`. We require Node >= 20 rather than
 * shipping a `node:crypto` fallback, because a static import of a Node builtin
 * breaks bundling for the edge runtimes this library primarily targets — and
 * Node 18 reached end of life in April 2025.
 */
function subtle(): SubtleCrypto {
  const c = globalThis.crypto
  if (!c?.subtle) {
    throw new HashSecretError(
      'Web Crypto is unavailable. agent-analytics requires Node >= 20, or any ' +
        'runtime exposing globalThis.crypto.subtle (Vercel Edge, Cloudflare ' +
        'Workers, Deno, browsers).'
    )
  }
  return c.subtle
}

// Importing a CryptoKey costs more than the signature itself, so keep one per
// secret. Bounded by however many secrets a process configures — realistically
// one.
const KEYS = new Map<string, Promise<CryptoKey>>()

function keyFor(secret: string): Promise<CryptoKey> {
  let k = KEYS.get(secret)
  if (!k) {
    k = subtle().importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    KEYS.set(secret, k)
  }
  return k
}

/**
 * Hash `input` under `secret`, returning `anon_` followed by 16 hex characters
 * (64 bits — collision-free well past any realistic distinct-visitor count).
 *
 * The secret must be stable across instances for identifiers to be comparable
 * over time, and secret from anyone who can read your events: publishing it
 * makes the identifier exactly as reversible as the old implementation was.
 * Rotating it deliberately breaks continuity, which is correct behaviour for a
 * privacy-preserving id.
 */
export async function hashId(input: string, secret: string): Promise<string> {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new HashSecretError('hashId requires a non-empty secret')
  }
  const sig = await subtle().sign('HMAC', await keyFor(secret), new TextEncoder().encode(input))
  const bytes = new Uint8Array(sig, 0, 8)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return 'anon_' + out
}

/**
 * Generate a random secret. Used as the default when none is configured, so the
 * privacy-preserving path is the one you get by doing nothing. Identifiers are
 * then only stable within a single instance's lifetime — set a real secret when
 * you need them comparable across instances and over time.
 */
export function randomSecret(): string {
  const b = new Uint8Array(32)
  subtle() // surface the same clear error if Web Crypto is missing
  globalThis.crypto.getRandomValues(b)
  let out = ''
  for (const x of b) out += x.toString(16).padStart(2, '0')
  return out
}
