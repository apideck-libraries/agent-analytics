import { describe, expect, it } from 'vitest'
import {
  markdownHeaders,
  markdownServeDecision,
  synthesizeMarkdownPointer
} from '../src/markdown.js'

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers })
}

describe('markdownServeDecision', () => {
  it('detects AI-bot UA on any URL', () => {
    const d = markdownServeDecision(
      req('https://example.com/docs/intro', { 'user-agent': 'ClaudeBot/1.0' })
    )
    expect(d).toEqual({ reason: 'ua-rewrite', strippedPath: '/docs/intro' })
  })

  it('detects .md suffix', () => {
    const d = markdownServeDecision(req('https://example.com/docs/intro.md'))
    expect(d).toEqual({ reason: 'md-suffix', strippedPath: '/docs/intro' })
  })

  it('detects Accept: text/markdown', () => {
    const d = markdownServeDecision(
      req('https://example.com/docs/intro', { accept: 'text/markdown' })
    )
    expect(d).toEqual({ reason: 'accept-header', strippedPath: '/docs/intro' })
  })

  it('returns null for plain browser requests', () => {
    expect(
      markdownServeDecision(
        req('https://example.com/docs/intro', {
          'user-agent': 'Mozilla/5.0 Chrome/120',
          accept: 'text/html'
        })
      )
    ).toBeNull()
  })

  it('prefers ua-rewrite over md-suffix when both match', () => {
    const d = markdownServeDecision(
      req('https://example.com/docs/intro.md', { 'user-agent': 'ClaudeBot/1.0' })
    )
    expect(d?.reason).toBe('ua-rewrite')
    // UA branch doesn't strip the suffix — the strippedPath is the raw pathname.
    expect(d?.strippedPath).toBe('/docs/intro.md')
  })

  it('detects Accept: text/markdown even when other media types are listed', () => {
    const d = markdownServeDecision(
      req('https://example.com/docs/intro', {
        accept: 'text/html, application/xhtml+xml, text/markdown;q=0.9, */*;q=0.8'
      })
    )
    expect(d?.reason).toBe('accept-header')
  })

  it('ignores `.md` inside the query string', () => {
    expect(
      markdownServeDecision(req('https://example.com/docs/intro?ref=foo.md'))
    ).toBeNull()
  })
})

describe('markdownHeaders', () => {
  it('returns sensible defaults', () => {
    const h = markdownHeaders()
    expect(h['Content-Type']).toBe('text/markdown; charset=utf-8')
    expect(h['Content-Signal']).toBe('search=yes, ai-input=yes, ai-train=no')
    expect(h.Vary).toBe('accept')
  })

  it('includes x-markdown-tokens when tokens is positive', () => {
    const h = markdownHeaders({ tokens: 1234 })
    expect(h['x-markdown-tokens']).toBe('1234')
  })

  it('omits x-markdown-tokens when tokens is zero or missing', () => {
    expect(markdownHeaders({ tokens: 0 })['x-markdown-tokens']).toBeUndefined()
    expect(markdownHeaders()['x-markdown-tokens']).toBeUndefined()
  })

  it('omits x-markdown-tokens for negative values', () => {
    expect(markdownHeaders({ tokens: -5 })['x-markdown-tokens']).toBeUndefined()
  })

  it('rounds fractional tokens up', () => {
    expect(markdownHeaders({ tokens: 100.2 })['x-markdown-tokens']).toBe('101')
  })

  it('honours a custom Content-Signal directive', () => {
    expect(markdownHeaders({ contentSignal: 'search=yes, ai-train=yes' })['Content-Signal']).toBe(
      'search=yes, ai-train=yes'
    )
  })
})

describe('synthesizeMarkdownPointer', () => {
  it('renders a minimal pointer document', () => {
    const body = synthesizeMarkdownPointer({
      origin: 'https://example.com',
      pathname: '/about',
      llmsTxtUrl: 'https://example.com/llms.txt'
    })
    expect(body).toContain('# example.com')
    expect(body).toContain('https://example.com/about')
    expect(body).toContain('https://example.com/llms.txt')
  })

  it('uses a provided site name', () => {
    const body = synthesizeMarkdownPointer({
      origin: 'https://example.com',
      pathname: '/',
      siteName: 'Example Inc.'
    })
    expect(body).toContain('# Example Inc.')
  })

  it('renders all three link types when provided', () => {
    const body = synthesizeMarkdownPointer({
      origin: 'https://example.com',
      pathname: '/about',
      llmsTxtUrl: 'https://example.com/llms.txt',
      llmsFullTxtUrl: 'https://example.com/llms-full.txt',
      markdownIndexUrl: 'https://example.com/md/index.json'
    })
    expect(body).toContain('https://example.com/llms.txt')
    expect(body).toContain('https://example.com/llms-full.txt')
    expect(body).toContain('https://example.com/md/index.json')
    expect(body).toContain('For machine-readable documentation')
  })

  it('omits the links section when no link URLs are supplied', () => {
    const body = synthesizeMarkdownPointer({
      origin: 'https://example.com',
      pathname: '/about'
    })
    expect(body).not.toContain('For machine-readable documentation')
  })

  it('falls back to the raw origin string when it cannot be parsed as a URL', () => {
    const body = synthesizeMarkdownPointer({
      origin: 'not-a-url',
      pathname: '/x'
    })
    expect(body.startsWith('# not-a-url')).toBe(true)
  })
})
