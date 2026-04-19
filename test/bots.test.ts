import { describe, expect, it } from 'vitest'
import { AI_BOT_PATTERN, firstUserAgentProduct, isAiBot, parseBotName } from '../src/bots.js'

describe('isAiBot', () => {
  it('matches known AI bots', () => {
    expect(isAiBot('ClaudeBot/1.0')).toBe(true)
    expect(isAiBot('Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)')).toBe(true)
    expect(isAiBot('PerplexityBot/1.0')).toBe(true)
    expect(isAiBot('ChatGPT-User/1.0')).toBe(true)
    expect(isAiBot('Mozilla/5.0 (compatible; Google-Extended)')).toBe(true)
  })

  it('does not match regular browsers', () => {
    expect(
      isAiBot('Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605 Safari/605')
    ).toBe(false)
  })

  it('handles null / empty / undefined safely', () => {
    expect(isAiBot(null)).toBe(false)
    expect(isAiBot(undefined)).toBe(false)
    expect(isAiBot('')).toBe(false)
  })
})

describe('parseBotName', () => {
  it('labels common bots', () => {
    expect(parseBotName('ClaudeBot/1.0')).toBe('Claude')
    expect(parseBotName('ChatGPT-User')).toBe('ChatGPT')
    expect(parseBotName('Mozilla/5.0 (compatible; GPTBot/1.1)')).toBe('ChatGPT')
    expect(parseBotName('PerplexityBot')).toBe('Perplexity')
    expect(parseBotName('CCBot')).toBe('Common Crawl')
    expect(parseBotName('Applebot-Extended')).toBe('Apple')
    expect(parseBotName('Meta-ExternalAgent')).toBe('Meta')
  })

  it('labels browsers', () => {
    expect(
      parseBotName('Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120.0.0.0')
    ).toBe('Browser')
  })

  it('falls back to Other for unknown', () => {
    expect(parseBotName('curl/8.0')).toBe('Other')
    expect(parseBotName(null)).toBe('Other')
  })
})

describe('firstUserAgentProduct', () => {
  it('extracts the product name before the slash', () => {
    expect(firstUserAgentProduct('ClaudeBot/1.0 (+https://claude.ai/bot)')).toBe('ClaudeBot')
    expect(firstUserAgentProduct('curl/8.4.0')).toBe('curl')
  })

  it('handles "compatible;" wrapped UAs', () => {
    expect(
      firstUserAgentProduct('Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)')
    ).toBe('GPTBot')
  })

  it('returns Other for empty input', () => {
    expect(firstUserAgentProduct(null)).toBe('Other')
    expect(firstUserAgentProduct('')).toBe('Other')
  })
})

describe('AI_BOT_PATTERN', () => {
  it('is a case-insensitive RegExp', () => {
    expect(AI_BOT_PATTERN.flags).toContain('i')
    expect(AI_BOT_PATTERN.test('claudebot')).toBe(true)
    expect(AI_BOT_PATTERN.test('CLAUDEBOT')).toBe(true)
  })
})
