/**
 * User-agent substrings that identify known AI crawlers and coding agents.
 * Maintained by hand; add new entries as they appear in the wild.
 *
 * Sources consulted when updating: darkvisitors.com, official docs from OpenAI,
 * Anthropic, Google, Perplexity, Cohere, Apple, Bytedance, cursor, windsurf.
 */
export const AI_BOT_PATTERN =
  /ClaudeBot|Claude-User|Anthropic|ChatGPT-User|GPTBot|OAI-SearchBot|PerplexityBot|Perplexity-User|Google-Extended|Applebot-Extended|cohere-ai|Bytespider|CCBot|Amazonbot|Meta-ExternalAgent|FacebookBot|DuckAssistBot|MistralAI-User|YouBot|AI2Bot|Diffbot|Cursor|Windsurf/i

export function isAiBot(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false
  return AI_BOT_PATTERN.test(userAgent)
}

/**
 * Map a user-agent string to a coarse, human-readable bot label. Returns
 * `'Browser'` for typical desktop browsers and `'Other'` for anything we
 * don't recognise — don't treat a non-`'Other'` result as "definitely a bot";
 * pair with {@link isAiBot} when that distinction matters.
 */
export function parseBotName(userAgent: string | null | undefined): string {
  if (!userAgent || typeof userAgent !== 'string') return 'Other'
  const s = userAgent.toLowerCase()
  if (s.includes('chatgpt-user') || s.includes('gptbot') || s.includes('oai-searchbot') || s.includes('openai'))
    return 'ChatGPT'
  if (s.includes('claudebot') || s.includes('claude-user') || s.includes('anthropic')) return 'Claude'
  if (s.includes('perplexitybot') || s.includes('perplexity-user')) return 'Perplexity'
  if (s.includes('ccbot')) return 'Common Crawl'
  if (s.includes('google-extended') || s.includes('googlebot')) return 'Google'
  if (s.includes('applebot-extended') || s.includes('applebot')) return 'Apple'
  if (s.includes('bingbot')) return 'Bing'
  if (s.includes('bytespider')) return 'Bytespider'
  if (s.includes('amazonbot')) return 'Amazon'
  if (s.includes('meta-externalagent') || s.includes('facebookbot')) return 'Meta'
  if (s.includes('mistralai-user')) return 'Mistral'
  if (s.includes('duckassistbot')) return 'DuckDuckGo'
  if (s.includes('youbot')) return 'You.com'
  if (s.includes('diffbot')) return 'Diffbot'
  if (s.includes('ai2bot')) return 'AI2'
  if (s.includes('cohere')) return 'Cohere'
  if (s.includes('cursor')) return 'Cursor'
  if (s.includes('windsurf')) return 'Windsurf'
  if (s.includes('petalbot')) return 'PetalBot'
  if (s.includes('mozilla') || s.includes('chrome') || s.includes('safari') || s.includes('firefox'))
    return 'Browser'
  return 'Other'
}

/**
 * Return the first product token from a UA header, useful for segmenting by
 * client without hard-coding every bot name. Falls back to `'Other'` for empty
 * input.
 */
export function firstUserAgentProduct(userAgent: string | null | undefined): string {
  if (!userAgent || typeof userAgent !== 'string') return 'Other'
  const compatibleMatch = userAgent.match(/compatible;\s*([^/;\s]+)(?:\/[^\s;]*)?/i)
  if (compatibleMatch && compatibleMatch[1]) return compatibleMatch[1].trim()
  const first = userAgent.trim().split('/')[0]?.trim().split(/\s+/)[0]?.trim()
  return first || 'Other'
}
