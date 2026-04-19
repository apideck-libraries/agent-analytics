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
})
