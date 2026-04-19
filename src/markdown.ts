import { isAiBot } from './bots.js'

export type MarkdownServeReason =
  | 'ua-rewrite'
  | 'md-suffix'
  | 'accept-header'

export interface MarkdownDecision {
  /** Why this request should be served Markdown. */
  reason: MarkdownServeReason
  /**
   * The request's original logical path, with any trailing `.md` stripped.
   * Use this when mapping to a mirror file.
   */
  strippedPath: string
}

/**
 * Decide whether the request should be served Markdown instead of HTML.
 * Returns `null` when the request should go through your normal handler.
 *
 * Covers three triggers:
 * - Known AI-bot UA on any URL (`ua-rewrite`)
 * - Explicit `.md` suffix on the URL (`md-suffix`)
 * - `Accept: text/markdown` header (`accept-header`)
 *
 * This helper intentionally does not perform the rewrite itself — routing is
 * framework-specific (NextResponse.rewrite for Next.js, ctx.rewrite for
 * Hono, etc.). Use the returned decision to build the appropriate response.
 */
export function markdownServeDecision(req: Request): MarkdownDecision | null {
  let pathname = '/'
  try {
    pathname = new URL(req.url).pathname
  } catch {
    pathname = req.url || '/'
  }

  const ua = req.headers.get('user-agent') || ''
  if (isAiBot(ua)) {
    return { reason: 'ua-rewrite', strippedPath: pathname }
  }

  if (pathname.endsWith('.md')) {
    return { reason: 'md-suffix', strippedPath: pathname.replace(/\.md$/, '') }
  }

  const accept = req.headers.get('accept') || ''
  if (accept.includes('text/markdown')) {
    return { reason: 'accept-header', strippedPath: pathname }
  }

  return null
}

export interface MarkdownHeadersInput {
  /**
   * If provided, rendered as `x-markdown-tokens` so agents can budget context
   * before parsing the body. Typically `Math.ceil(body.length / 4)`.
   */
  tokens?: number
  /**
   * Content-Signal directive (see contentsignals.org). Defaults to
   * `'search=yes, ai-input=yes, ai-train=no'` — change if you want to permit
   * training or restrict indexing.
   */
  contentSignal?: string
}

/**
 * Build the set of response headers to attach to a Markdown response. Safe
 * defaults: UTF-8 text/markdown, Vary: accept, and a Content-Signal directive
 * that permits search + agent input but denies training.
 */
export function markdownHeaders(input: MarkdownHeadersInput = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Signal': input.contentSignal ?? 'search=yes, ai-input=yes, ai-train=no',
    Vary: 'accept'
  }
  if (typeof input.tokens === 'number' && input.tokens > 0) {
    headers['x-markdown-tokens'] = Math.max(1, Math.ceil(input.tokens)).toString()
  }
  return headers
}

export interface SynthesizePointerInput {
  origin: string
  pathname: string
  /** URL of the site's curated index, usually `/llms.txt`. */
  llmsTxtUrl?: string
  /** URL of the full enumerated index, usually `/llms-full.txt`. */
  llmsFullTxtUrl?: string
  /** URL of the machine-readable path manifest, usually `/md/index.json`. */
  markdownIndexUrl?: string
  /** Site name to title the pointer document. Defaults to the origin hostname. */
  siteName?: string
}

/**
 * Generate a minimal pointer Markdown document for URLs that don't have a
 * pre-built mirror. Keeps the `Accept: text/markdown` contract intact
 * site-wide — agents always get *something* parseable, not a 404.
 */
export function synthesizeMarkdownPointer(input: SynthesizePointerInput): string {
  const site =
    input.siteName ??
    (() => {
      try {
        return new URL(input.origin).hostname
      } catch {
        return input.origin
      }
    })()
  const url = `${input.origin}${input.pathname}`
  const lines: string[] = [`# ${site}`, '', `This page (${url}) does not have a dedicated Markdown mirror yet.`, '']
  const links: string[] = []
  if (input.llmsTxtUrl) links.push(`- [${input.llmsTxtUrl}](${input.llmsTxtUrl}) — curated index of docs`)
  if (input.llmsFullTxtUrl)
    links.push(`- [${input.llmsFullTxtUrl}](${input.llmsFullTxtUrl}) — full enumerated index`)
  if (input.markdownIndexUrl)
    links.push(`- [${input.markdownIndexUrl}](${input.markdownIndexUrl}) — JSON index of all Markdown paths`)
  if (links.length) {
    lines.push('For machine-readable documentation, see:', '', ...links, '')
  }
  return lines.join('\n')
}
