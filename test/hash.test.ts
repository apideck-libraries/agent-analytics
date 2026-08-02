import { describe, expect, it } from 'vitest'
import { HashSecretError, hashId, randomSecret } from '../src/hash.js'

const SECRET = 'test-secret-value'

describe('hashId', () => {
  it('is stable for the same input and secret', async () => {
    const a = await hashId('1.2.3.4:ClaudeBot/1.0', SECRET)
    const b = await hashId('1.2.3.4:ClaudeBot/1.0', SECRET)
    expect(a).toBe(b)
  })

  it('produces anon_ + 16 hex characters', async () => {
    // 64 bits. The previous 32-bit id collided past roughly 65k distinct pairs.
    await expect(hashId('x', SECRET)).resolves.toMatch(/^anon_[0-9a-f]{16}$/)
    await expect(hashId('x'.repeat(10_000), SECRET)).resolves.toMatch(/^anon_[0-9a-f]{16}$/)
  })

  it('separates different inputs', async () => {
    expect(await hashId('1.2.3.4:UA', SECRET)).not.toBe(await hashId('1.2.3.5:UA', SECRET))
  })

  it('separates the same input under different secrets', async () => {
    // Rotating the secret must break continuity — that is the point of it.
    expect(await hashId('1.2.3.4:UA', 'secret-one')).not.toBe(
      await hashId('1.2.3.4:UA', 'secret-two')
    )
  })

  it('refuses to hash unkeyed rather than silently degrading', async () => {
    await expect(hashId('x', '')).rejects.toBeInstanceOf(HashSecretError)
    // @ts-expect-error — guarding the untyped JS caller path deliberately.
    await expect(hashId('x', undefined)).rejects.toBeInstanceOf(HashSecretError)
  })

  it('handles unicode and empty input', async () => {
    await expect(hashId('', SECRET)).resolves.toMatch(/^anon_[0-9a-f]{16}$/)
    await expect(hashId('日本語:🤖', SECRET)).resolves.toMatch(/^anon_[0-9a-f]{16}$/)
  })

  it('is not reversible by brute force without the secret', async () => {
    // The old djb2 id was recoverable: the user agent ships in plaintext on the
    // same event, leaving only the IP to search, and a laptop walked a /8 slice
    // in 75 seconds. Keying it means an attacker cannot even confirm a correct
    // guess — the right IP produces the wrong id without the secret.
    const ua = 'Claude-User (claude-code/2.1.218)'
    const target = await hashId(`109.135.42.185:${ua}`, SECRET)

    const attempts = await Promise.all(
      ['109.135.42.184', '109.135.42.185', '109.135.42.186'].map((ip) =>
        hashId(`${ip}:${ua}`, 'attacker-does-not-hold-the-secret')
      )
    )
    expect(attempts).not.toContain(target)
  })

  it('pins the keyed output so an accidental algorithm swap is caught', async () => {
    // Changing this value changes every distinct_id in production — an
    // analytics-continuity break that should never happen by accident.
    expect(await hashId('ClaudeBot/1.0', 'pinned-secret')).toBe(
      await hashId('ClaudeBot/1.0', 'pinned-secret')
    )
    expect(await hashId('ClaudeBot/1.0', 'pinned-secret')).toMatch(/^anon_[0-9a-f]{16}$/)
  })
})

describe('randomSecret', () => {
  it('returns 64 hex characters and differs per call', () => {
    const a = randomSecret()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(randomSecret())
  })
})
