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
  /ClaudeBot|Claude-User|Claude-SearchBot|Claude-Web|Anthropic|GPTBot|ChatGPT-User|OAI-SearchBot|PerplexityBot|Perplexity-User|Google-Extended|Google-CloudVertexBot|Google-Agent|GoogleAgent-Mariner|Gemini-Deep-Research|Applebot|cohere|Bytespider|CCBot|Amazonbot|Amzn-SearchBot|NovaAct|AzureAI-SearchBot|Meta-ExternalAgent|meta-externalfetcher|meta-webindexer|FacebookBot|DuckAssistBot|MistralAI-User|YouBot|AI2Bot|Diffbot|DeepSeek|PanguBot|Webzio-Extended|omgili|Timpibot|Grok|Manus-User|quillbot|MyCentralAIScraperBot|Cursor|Windsurf/i

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
  if (
    s.includes('claudebot') ||
    s.includes('claude-user') ||
    s.includes('claude-searchbot') ||
    s.includes('claude-web') ||
    s.includes('anthropic')
  )
    return 'Claude'
  if (s.includes('perplexitybot') || s.includes('perplexity-user')) return 'Perplexity'
  if (s.includes('ccbot')) return 'Common Crawl'
  if (
    s.includes('google-extended') ||
    s.includes('googlebot') ||
    s.includes('google-cloudvertexbot') ||
    s.includes('google-agent') ||
    s.includes('googleagent-mariner') ||
    s.includes('gemini-deep-research')
  )
    return 'Google'
  if (s.includes('applebot')) return 'Apple'
  if (s.includes('bingbot')) return 'Bing'
  if (s.includes('bytespider')) return 'Bytespider'
  if (s.includes('amazonbot') || s.includes('amzn-searchbot') || s.includes('novaact')) return 'Amazon'
  if (
    s.includes('meta-externalagent') ||
    s.includes('meta-externalfetcher') ||
    s.includes('meta-webindexer') ||
    s.includes('facebookbot')
  )
    return 'Meta'
  if (s.includes('mistralai-user')) return 'Mistral'
  if (s.includes('duckassistbot')) return 'DuckDuckGo'
  if (s.includes('youbot')) return 'You.com'
  if (s.includes('diffbot')) return 'Diffbot'
  if (s.includes('ai2bot')) return 'AI2'
  if (s.includes('cohere')) return 'Cohere'
  if (s.includes('cursor')) return 'Cursor'
  if (s.includes('windsurf')) return 'Windsurf'
  if (s.includes('deepseek')) return 'DeepSeek'
  if (s.includes('pangubot')) return 'Huawei'
  if (s.includes('webzio') || s.includes('omgili')) return 'Webz.io'
  if (s.includes('timpibot')) return 'Timpi'
  if (s.includes('grok') || s.includes('xai-')) return 'xAI'
  if (s.includes('manus-user')) return 'Manus'
  if (s.includes('quillbot')) return 'QuillBot'
  if (s.includes('azureai-searchbot')) return 'Microsoft'
  if (s.includes('mycentralaiscraperbot')) return 'MyCentralAI'
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

  // AI search and indexing bots.
  if (s.includes('linkupbot')) return 'Linkup'
  if (s.includes('sogou')) return 'Sogou'
  if (s.includes('yandexbot')) return 'Yandex'
  if (s.includes('baiduspider')) return 'Baidu'

  // Link preview fetchers.
  if (s.includes('facebookexternalhit')) return 'Facebook'
  if (s.includes('com.apple.webkit')) return 'Apple URL Preview'

  // Uptime and monitoring.
  if (s.includes('ohdear')) return 'Oh Dear'

  // Generic scrapers.
  if (s.includes('scrapy')) return 'Scrapy'
  if (s.includes('headlesschrome')) return 'Headless Chrome'
  if (s.includes('phantomjs')) return 'PhantomJS'
  if (s.includes('wget')) return 'wget'
  if (s.includes('httpie')) return 'HTTPie'
  if (s.includes('guzzlehttp')) return 'Guzzle'

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

/**
 * Detect likely headless/automated browsers by checking for missing headers
 * that real browsers always send. Playwright, Puppeteer, and similar tools
 * spoof the UA but often omit standard browser headers.
 *
 * Signals checked (each scores 1 point):
 * - Missing `Accept-Language` — every real browser sends this
 * - Missing `Sec-Fetch-Mode` — sent by all modern browsers
 * - Missing `Sec-CH-UA` — Client Hints, Chromium 89+
 * - `Sec-CH-UA` contains "HeadlessChrome"
 * - Missing or bare Accept header — browsers send detailed accept lists
 * - `Connection: close` with browser UA — browsers use keep-alive
 *
 * Returns a score (0-6), the signals that fired, and a boolean `likely`
 * flag (score >= 2 with a browser-like UA).
 */
export function detectHeadless(req: Request): HeadlessDetection {
  const signals: string[] = []
  const ua = (req.headers.get('user-agent') || '').toLowerCase()
  const isBrowserUA =
    ua.includes('mozilla') || ua.includes('chrome') || ua.includes('safari') || ua.includes('firefox')

  if (!isBrowserUA) return { score: 0, signals: [], likely: false }

  if (!req.headers.get('accept-language')) {
    signals.push('missing-accept-language')
  }
  if (!req.headers.get('sec-fetch-mode')) {
    signals.push('missing-sec-fetch-mode')
  }
  const secChUa = req.headers.get('sec-ch-ua')
  if (!secChUa) {
    signals.push('missing-sec-ch-ua')
  } else if (secChUa.toLowerCase().includes('headlesschrome')) {
    signals.push('headless-chrome-hint')
  }
  const accept = req.headers.get('accept') || ''
  if (!accept || accept === '*/*') {
    signals.push('missing-or-bare-accept')
  }
  if ((req.headers.get('connection') || '').toLowerCase() === 'close') {
    signals.push('connection-close')
  }

  const score = signals.length
  return { score, signals, likely: score >= 2 }
}

export interface HeadlessDetection {
  /** Number of suspicious signals found (0-6). */
  score: number
  /** Names of the specific signals that fired. */
  signals: string[]
  /** True when score >= 2 — strong headless indication. */
  likely: boolean
}

export type AgentKind =
  | 'declared-crawler'
  | 'coding-agent-hint'
  | 'headless-likely'
  | 'browser'
  | 'other'

export interface AgentClassification {
  /**
   * Categorical tag for the request:
   *
   * - `'declared-crawler'` — {@link AI_BOT_PATTERN} matched. High confidence.
   * - `'coding-agent-hint'` — {@link HTTP_CLIENT_PATTERN} matched. Loose
   *   signal; could be a coding agent, a curl script, or any automation.
   * - `'headless-likely'` — Browser-like UA but missing standard headers.
   *   Strong signal of Playwright/Puppeteer automation (Aider, OpenCode, etc.).
   * - `'browser'` — Looks like a real browser with expected headers present.
   * - `'other'` — Unrecognised or empty.
   */
  kind: AgentKind
  /** Human-readable label, same string {@link parseBotName} returns. */
  label: string
  /** Strict: `true` only when the UA matches a branded AI crawler. */
  isAiBot: boolean
  /** Loose: `true` for known HTTP-library / automation UAs. */
  codingAgentHint: boolean
  /** Headless browser detection result. Only populated when `req` is passed. */
  headless?: HeadlessDetection
}

/**
 * UA-only classification. Use {@link classifyRequest} for full detection
 * including headless browser heuristics.
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

/**
 * Full request classification — combines UA parsing with header-based
 * headless detection. When a browser-like UA is missing standard headers,
 * the kind is promoted from `'browser'` to `'headless-likely'`.
 */
export function classifyRequest(req: Request): AgentClassification {
  const userAgent = req.headers.get('user-agent') || ''
  const base = classifyAgent(userAgent)
  const headless = detectHeadless(req)

  let kind = base.kind
  if (kind === 'browser' && headless.likely) {
    kind = 'headless-likely'
  }

  return { ...base, kind, headless }
}
