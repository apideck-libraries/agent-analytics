/**
 * User-agent substrings that identify **publicly declared** AI crawlers — the
 * branded bots that identify themselves by name (OpenAI's GPTBot, Anthropic's
 * ClaudeBot, Perplexity-User, Google-Extended, etc.). High-confidence: when
 * this matches, the request almost certainly comes from that vendor's crawler
 * fleet.
 *
 * Does NOT include **coding-agent traffic** (Claude Code, Cline, Cursor,
 * Windsurf, Aider, OpenCode, VS Code). Those tools use generic HTTP library
 * UAs (axios, curl, got, colly, Electron) or spoof full browser UAs — they
 * can't be distinguished from non-AI traffic by UA alone. See
 * {@link HTTP_CLIENT_PATTERN} for the loose heuristic layer.
 *
 * Sources consulted when updating: darkvisitors.com, vendor docs from OpenAI,
 * Anthropic, Google, Perplexity, Cohere, Apple, Bytedance.
 */
export const AI_BOT_PATTERN =
  /ClaudeBot|Claude-User|Anthropic|ChatGPT-User|GPTBot|OAI-SearchBot|PerplexityBot|Perplexity-User|Google-Extended|Applebot-Extended|cohere-ai|Bytespider|CCBot|Amazonbot|Meta-ExternalAgent|FacebookBot|DuckAssistBot|MistralAI-User|YouBot|AI2Bot|Diffbot|Cursor|Windsurf/i

/**
 * HTTP library / runtime signatures frequently used by coding agents. Matching
 * any of these is a **loose** signal — legitimate curl scripts, CI jobs, and
 * server-to-server traffic use the same libraries. Use this for the wider
 * net (`coding_agent_hint: true`) and pair with other signals (request
 * shape, JA4 fingerprint, path patterns) for higher confidence.
 *
 * Based on behavioural signatures observed by Addy Osmani:
 *   Claude Code  → axios/1.8.4
 *   Cline, Junie → curl/8.4.0
 *   Cursor       → got (sindresorhus/got)
 *   Windsurf     → colly
 *   VS Code      → Electron / Chromium
 *
 * Aider and OpenCode use Playwright-driven full Mozilla/Safari UAs and are
 * indistinguishable from real browsers at the UA layer.
 */
export const HTTP_CLIENT_PATTERN =
  /axios\/|curl\/|(?:^|[\s(])got(?:\/|[\s(])|\bcolly\b|Electron\/|node-fetch\/|python-requests\/|Go-http-client\/|okhttp\/|aiohttp\/|Deno\//i

export function isAiBot(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false
  return AI_BOT_PATTERN.test(userAgent)
}

export function isHttpClient(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false
  return HTTP_CLIENT_PATTERN.test(userAgent)
}

/**
 * Map a user-agent string to a coarse, human-readable label. Returns one of:
 *
 * - A branded-crawler name (`'Claude'`, `'ChatGPT'`, …) — pair with
 *   {@link isAiBot} for `is_ai_bot: true` segmentation.
 * - An HTTP-library name (`'curl'`, `'axios'`, `'got'`, `'colly'`,
 *   `'Electron'`, …) — hint of a coding agent or automation; not
 *   conclusive. Pair with {@link isHttpClient}.
 * - `'Browser'` for typical desktop browsers (possibly spoofed by
 *   Playwright-based agents like Aider/OpenCode — this label alone can't
 *   tell you).
 * - `'Other'` for anything unrecognised or empty input.
 */
export function parseBotName(userAgent: string | null | undefined): string {
  if (!userAgent || typeof userAgent !== 'string') return 'Other'
  const s = userAgent.toLowerCase()

  // Publicly declared AI crawlers (high confidence).
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

  // SEO crawlers and monitoring bots.
  if (s.includes('ahrefsbot')) return 'Ahrefs'
  if (s.includes('semrushbot')) return 'Semrush'
  if (s.includes('mj12bot')) return 'Majestic'
  if (s.includes('dotbot')) return 'Moz'
  if (s.includes('rogerbot')) return 'Moz'
  if (s.includes('screaming frog')) return 'Screaming Frog'
  if (s.includes('sitebulb')) return 'Sitebulb'
  if (s.includes('linkfluence')) return 'Linkfluence'
  if (s.includes('dataforseo')) return 'DataForSEO'
  if (s.includes('serpstatbot')) return 'Serpstat'

  // Monitoring and feed bots.
  if (s.includes('uptimerobot')) return 'UptimeRobot'
  if (s.includes('pingdom')) return 'Pingdom'
  if (s.includes('statuscake')) return 'StatusCake'
  if (s.includes('newrelicpinger')) return 'New Relic'
  if (s.includes('datadogagent') || s.includes('datadog')) return 'Datadog'
  if (s.includes('slackbot')) return 'Slack'
  if (s.includes('twitterbot')) return 'Twitter'
  if (s.includes('linkedinbot')) return 'LinkedIn'
  if (s.includes('discordbot')) return 'Discord'
  if (s.includes('telegrambot')) return 'Telegram'
  if (s.includes('whatsapp')) return 'WhatsApp'

  // Generic scrapers.
  if (s.includes('scrapy')) return 'Scrapy'
  if (s.includes('headlesschrome')) return 'Headless Chrome'
  if (s.includes('phantomjs')) return 'PhantomJS'
  if (s.includes('wget')) return 'wget'
  if (s.includes('httpie')) return 'HTTPie'

  // HTTP library / runtime signatures (loose — coding agent or automation).
  // Check Electron before Browser since Electron UAs contain Chrome/Safari.
  if (s.includes('electron/')) return 'Electron'
  if (/curl\//.test(s)) return 'curl'
  if (/axios\//.test(s)) return 'axios'
  if (/(?:^|[\s(])got(?:\/|[\s(])/.test(s)) return 'got'
  if (/\bcolly\b/.test(s)) return 'colly'
  if (/node-fetch\//.test(s)) return 'node-fetch'
  if (/python-requests\//.test(s)) return 'python-requests'
  if (/go-http-client\//.test(s)) return 'Go http client'
  if (/okhttp\//.test(s)) return 'OkHttp'
  if (/aiohttp\//.test(s)) return 'aiohttp'
  if (/deno\//.test(s)) return 'Deno'

  // Real browsers (or UAs spoofed to look like them — see Aider/OpenCode note).
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

export type AgentKind =
  | 'declared-crawler'
  | 'coding-agent-hint'
  | 'browser'
  | 'other'

export interface AgentClassification {
  /**
   * Categorical tag for the UA:
   *
   * - `'declared-crawler'` — {@link AI_BOT_PATTERN} matched. High confidence.
   * - `'coding-agent-hint'` — {@link HTTP_CLIENT_PATTERN} matched. Loose
   *   signal; could be a coding agent, a curl script, or any automation.
   * - `'browser'` — looks like a real browser. Could be a genuine user or
   *   a Playwright-based agent (Aider, OpenCode) that can't be distinguished
   *   at the UA layer.
   * - `'other'` — unrecognised or empty.
   */
  kind: AgentKind
  /** Human-readable label, same string {@link parseBotName} returns. */
  label: string
  /** Strict: `true` only when the UA matches a branded AI crawler. */
  isAiBot: boolean
  /** Loose: `true` for known HTTP-library / automation UAs. */
  codingAgentHint: boolean
}

/**
 * One-stop classification of a user-agent. Combines {@link isAiBot},
 * {@link isHttpClient}, and {@link parseBotName} into a single structured
 * result. Used internally by `trackVisit` to populate event properties;
 * useful in consumer code when you need all signals at once.
 */
export function classifyAgent(userAgent: string | null | undefined): AgentClassification {
  const label = parseBotName(userAgent)
  const aiBot = isAiBot(userAgent)
  const httpClient = isHttpClient(userAgent)

  let kind: AgentKind
  if (aiBot) kind = 'declared-crawler'
  else if (httpClient) kind = 'coding-agent-hint'
  else if (label === 'Browser') kind = 'browser'
  else kind = 'other'

  return { kind, label, isAiBot: aiBot, codingAgentHint: httpClient }
}
