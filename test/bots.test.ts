import { describe, expect, it } from 'vitest'
import {
  AI_BOT_PATTERN,
  HTTP_CLIENT_PATTERN,
  classifyAgent,
  firstUserAgentProduct,
  isAiBot,
  isHttpClient,
  parseBotName
} from '../src/bots.js'

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
    expect(parseBotName('some-unknown-tool/1.0')).toBe('Other')
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

describe('isHttpClient', () => {
  it('matches coding-agent HTTP library UAs', () => {
    // From Addy Osmani's observed signatures
    expect(isHttpClient('axios/1.8.4')).toBe(true) // Claude Code
    expect(isHttpClient('curl/8.4.0')).toBe(true) // Cline, Junie
    expect(isHttpClient('got (sindresorhus/got)')).toBe(true) // Cursor
    expect(isHttpClient('colly - https://github.com/gocolly/colly')).toBe(true) // Windsurf
    expect(
      isHttpClient('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Electron/28.0.0 Safari/537.36')
    ).toBe(true) // VS Code
  })

  it('matches other common automation UAs', () => {
    expect(isHttpClient('node-fetch/2.6.1')).toBe(true)
    expect(isHttpClient('python-requests/2.31.0')).toBe(true)
    expect(isHttpClient('Go-http-client/1.1')).toBe(true)
    expect(isHttpClient('okhttp/4.11.0')).toBe(true)
    expect(isHttpClient('aiohttp/3.9.0')).toBe(true)
    expect(isHttpClient('Deno/1.40.0')).toBe(true)
  })

  it('does not match real browsers or declared AI crawlers', () => {
    expect(isHttpClient('Mozilla/5.0 (Macintosh) Chrome/120.0.0.0 Safari/537.36')).toBe(false)
    expect(isHttpClient('ClaudeBot/1.0')).toBe(false)
    expect(isHttpClient('')).toBe(false)
    expect(isHttpClient(null)).toBe(false)
  })
})

describe('parseBotName — HTTP-library labels', () => {
  it('labels coding-agent library UAs distinctly', () => {
    expect(parseBotName('axios/1.8.4')).toBe('axios')
    expect(parseBotName('curl/8.4.0')).toBe('curl')
    expect(parseBotName('got (sindresorhus/got)')).toBe('got')
    expect(parseBotName('colly - https://github.com/gocolly/colly')).toBe('colly')
    expect(
      parseBotName('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Electron/28.0.0')
    ).toBe('Electron')
  })

  it('returns branded bot name when UA matches a crawler first', () => {
    // A hypothetical UA with both "ClaudeBot" and "axios/" — branded bot wins
    expect(parseBotName('ClaudeBot/1.0 (axios/1.8.4)')).toBe('Claude')
  })
})

describe('classifyAgent', () => {
  it('marks declared crawlers as declared-crawler', () => {
    expect(classifyAgent('ClaudeBot/1.0')).toEqual({
      kind: 'declared-crawler',
      label: 'Claude',
      isAiBot: true,
      codingAgentHint: false
    })
  })

  it('marks HTTP-library UAs as coding-agent-hint', () => {
    expect(classifyAgent('curl/8.4.0')).toEqual({
      kind: 'coding-agent-hint',
      label: 'curl',
      isAiBot: false,
      codingAgentHint: true
    })
    expect(classifyAgent('axios/1.8.4')).toMatchObject({
      kind: 'coding-agent-hint',
      label: 'axios',
      codingAgentHint: true
    })
  })

  it('marks plain browsers as browser', () => {
    expect(classifyAgent('Mozilla/5.0 (Macintosh) Chrome/120 Safari/537.36')).toEqual({
      kind: 'browser',
      label: 'Browser',
      isAiBot: false,
      codingAgentHint: false
    })
  })

  it('returns other for empty or unrecognised UAs', () => {
    expect(classifyAgent(null)).toMatchObject({ kind: 'other', label: 'Other' })
    expect(classifyAgent('some-random-tool/1.0')).toMatchObject({ kind: 'other', label: 'Other' })
  })

  it('classifies Electron UAs as coding-agent-hint (not browser) despite Chrome/Safari tokens', () => {
    const vsCode =
      'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Electron/28.0.0 Safari/537.36'
    const result = classifyAgent(vsCode)
    expect(result.kind).toBe('coding-agent-hint')
    expect(result.label).toBe('Electron')
  })
})

describe('HTTP_CLIENT_PATTERN', () => {
  it('is case-insensitive', () => {
    expect(HTTP_CLIENT_PATTERN.flags).toContain('i')
    expect(HTTP_CLIENT_PATTERN.test('CURL/8.4.0')).toBe(true)
  })
})
