import { describe, expect, it } from 'vitest'
import { hashId } from '../src/hash.js'

describe('hashId', () => {
  it('returns a stable anon_ prefix hex string', () => {
    const h = hashId('1.2.3.4:ClaudeBot/1.0')
    expect(h).toMatch(/^anon_[0-9a-f]+$/)
  })

  it('produces identical output for identical input', () => {
    expect(hashId('foo')).toBe(hashId('foo'))
  })

  it('produces different output for different input', () => {
    expect(hashId('foo')).not.toBe(hashId('bar'))
  })

  it('handles empty input', () => {
    expect(hashId('')).toMatch(/^anon_[0-9a-f]+$/)
  })

  it('handles unicode input without throwing', () => {
    expect(hashId('🤖:ClaudeBot')).toMatch(/^anon_[0-9a-f]+$/)
  })

  it('produces a bounded-width hex suffix for very long input', () => {
    const h = hashId('x'.repeat(10_000))
    expect(h).toMatch(/^anon_[0-9a-f]{1,8}$/)
  })

  it('is stable — pinning a known-good output so an accidental hash swap gets caught', () => {
    // djb2 over 'ClaudeBot/1.0' should always produce this value.
    // If this test fails, trackVisit's distinct_id changed, which is a privacy
    // and analytics-continuity regression.
    expect(hashId('ClaudeBot/1.0')).toBe('anon_d4ce5816')
  })
})
