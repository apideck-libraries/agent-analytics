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
})
