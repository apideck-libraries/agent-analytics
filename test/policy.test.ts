import { describe, expect, it } from 'vitest'
import { agentIntent, agentPolicy } from '../src/policy.js'
import { verifyRequest } from '../src/verify.js'

function req(ua: string, headers: Record<string, string> = {}) {
  return new Request('https://example.com/docs', {
    headers: { 'user-agent': ua, ...headers }
  })
}

const GPTBOT = 'Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)'
const CHATGPT_USER = 'Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)'
const CLAUDEBOT = 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)'
const CLAUDE_CODE = 'Claude-User (claude-code/2.1.218; +https://support.anthropic.com/)'
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
const BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

describe('agentIntent', () => {
  it('separates a vendor\'s bulk crawler from its user-facing fetcher', () => {
    // The whole point of the module: same vendor, opposite economics.
    expect(agentIntent(GPTBOT)).toBe('training')
    expect(agentIntent(CHATGPT_USER)).toBe('retrieval')
    expect(agentIntent(CLAUDEBOT)).toBe('training')
    expect(agentIntent(CLAUDE_CODE)).toBe('retrieval')
  })

  it('treats classic indexers as search, not training', () => {
    expect(agentIntent(GOOGLEBOT)).toBe('search')
    expect(agentIntent('Mozilla/5.0 (compatible; bingbot/2.0)')).toBe('search')
    // Applebot indexes; Applebot-Extended is the training opt-in. Different intent.
    expect(agentIntent('Mozilla/5.0 (compatible; Applebot/0.1)')).toBe('search')
    expect(agentIntent('Mozilla/5.0 (compatible; Applebot-Extended/0.1)')).toBe('training')
  })

  it('returns unknown for browsers and empty input', () => {
    expect(agentIntent(BROWSER)).toBe('unknown')
    expect(agentIntent('')).toBe('unknown')
    expect(agentIntent(null)).toBe('unknown')
  })
})

describe('agentPolicy defaults', () => {
  it('meters training crawlers but never charges retrieval', () => {
    // Charging retrieval means charging your own distribution channel.
    expect(agentPolicy(req(GPTBOT)).action).toBe('meter')
    expect(agentPolicy(req(CLAUDEBOT)).action).toBe('meter')
    expect(agentPolicy(req(CHATGPT_USER)).action).toBe('allow')
    expect(agentPolicy(req(CLAUDE_CODE)).action).toBe('allow')
  })

  it('lets search crawlers and browsers straight through', () => {
    expect(agentPolicy(req(GOOGLEBOT)).action).toBe('allow')
    expect(agentPolicy(req(BROWSER)).action).toBe('allow')
  })

  it('classifies bare HTTP clients as tooling', () => {
    const d = agentPolicy(req('curl/8.4.0'))
    expect(d.intent).toBe('tooling')
    expect(d.action).toBe('allow')
  })

  it('carries a reason for logging', () => {
    expect(agentPolicy(req(GPTBOT)).reason).toBe('bulk corpus collection')
    expect(agentPolicy(req(CHATGPT_USER)).reason).toBe('a person is waiting on this answer')
  })
})

describe('agentPolicy overrides', () => {
  it('can charge training crawlers instead of metering them', () => {
    expect(agentPolicy(req(GPTBOT), { onTraining: 'charge' }).action).toBe('charge')
    // Retrieval is unaffected by the training knob.
    expect(agentPolicy(req(CHATGPT_USER), { onTraining: 'charge' }).action).toBe('allow')
  })

  it('honours the allowList over any intent rule', () => {
    const d = agentPolicy(req(GPTBOT), { onTraining: 'block', allowList: ['ChatGPT'] })
    expect(d.action).toBe('allow')
    expect(d.reason).toBe('on allowList')
  })
})

describe('agentPolicy with verification', () => {
  const REAL_OPENAI_IP = '104.208.184.193'

  it('blocks a spoofed crawler', () => {
    const d = agentPolicy(req(CHATGPT_USER, { 'x-forwarded-for': '1.2.3.4' }), { verify: verifyRequest })
    expect(d.action).toBe('block')
    expect(d.verification).toBe('spoofed')
  })

  it('allows the same UA from a published range', () => {
    const d = agentPolicy(req(CHATGPT_USER, { 'x-forwarded-for': REAL_OPENAI_IP }), { verify: verifyRequest })
    expect(d.action).toBe('allow')
    expect(d.verification).toBe('verified')
  })

  it('does not block on unverifiable', () => {
    // Bytespider publishes no ranges, and Claude Code runs on a laptop.
    // Blocking either would refuse legitimate traffic we simply can't check.
    const bytespider = agentPolicy(
      req('Mozilla/5.0 (compatible; Bytespider/1.0)', { 'x-forwarded-for': '1.2.3.4' }),
      { verify: verifyRequest }
    )
    expect(bytespider.verification).toBe('unverifiable')
    expect(bytespider.action).not.toBe('block')

    const local = agentPolicy(req(CLAUDE_CODE, { 'x-forwarded-for': '109.135.42.185' }), {
      verify: verifyRequest
    })
    expect(local.verification).toBe('unverifiable')
    expect(local.action).toBe('allow')
  })

  it('skips verification entirely when not asked', () => {
    const d = agentPolicy(req(CHATGPT_USER, { 'x-forwarded-for': '1.2.3.4' }))
    expect(d.verification).toBeUndefined()
    expect(d.action).toBe('allow')
  })
})

describe('agentIntent and agentPolicy never disagree', () => {
  // These are two separately exported functions answering the same question. If
  // they diverge, a caller has no way to know which is authoritative — and the
  // divergence is silent. It shipped that way: the `tooling` promotion lived
  // only inside agentPolicy, so agentIntent('curl/8.4.0') returned 'unknown'
  // while the policy returned 'tooling', for every HTTP client.
  const CORPUS = [
    'curl/8.4.0',
    'axios/1.8.4',
    'python-requests/2.31.0',
    'Go-http-client/1.1',
    'node-fetch/3.0.0',
    'Electron/28.0.0',
    'okhttp/4.12.0',
    'aiohttp/3.9.1',
    'Deno/1.40.0',
    'Mozilla/5.0 (compatible; GPTBot/1.1)',
    'Mozilla/5.0 (compatible; ChatGPT-User/1.0)',
    'Mozilla/5.0 (compatible; ClaudeBot/1.0)',
    'Claude-User (claude-code/2.1.218)',
    'Mozilla/5.0 (compatible; Googlebot/2.1)',
    'Mozilla/5.0 (compatible; Applebot/0.1)',
    'Mozilla/5.0 (compatible; Applebot-Extended/0.1)',
    'Mozilla/5.0 (compatible; PerplexityBot/1.0)',
    'Mozilla/5.0 (compatible; Perplexity-User/1.0)',
    'facebookexternalhit/1.1',
    'Slackbot-LinkExpanding 1.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    '',
    'SomethingCompletelyUnknown/9'
  ]

  it.each(CORPUS)('agrees for %s', (ua) => {
    const fromRequest = agentPolicy(
      new Request('https://example.com/', { headers: { 'user-agent': ua } })
    ).intent
    expect(agentIntent(ua)).toBe(fromRequest)
  })

  it('classifies HTTP libraries as tooling from the UA alone', () => {
    // No Request needed — the old asymmetry was that only the Request-taking
    // path knew about HTTP clients.
    expect(agentIntent('curl/8.4.0')).toBe('tooling')
    expect(agentIntent('axios/1.8.4')).toBe('tooling')
  })
})

describe('vendors that fell through every list', () => {
  // Found in production traffic, not in review: 42 requests a day from
  // PerplexityBot classified as `unknown`, which put it in no firewall rule at
  // all — neither protected by the retrieval/search bypass nor bounded by the
  // training rate limit. The `Bot` suffix reads like a corpus crawler, but
  // Perplexity documents it as the crawler behind their search results.
  it('classifies PerplexityBot as search, not unknown', () => {
    expect(agentIntent('Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)')).toBe('search')
  })

  it('keeps Perplexity-User on retrieval — the tokens must not collide', () => {
    expect(agentIntent('Mozilla/5.0 (compatible; Perplexity-User/1.0)')).toBe('retrieval')
  })

  it('never leaves a known agent in the intent gap', () => {
    // Anything here that returns `unknown` is invisible to every generated
    // rule. That is the actual failure mode, so assert the absence directly.
    const KNOWN = [
      'Mozilla/5.0 (compatible; PerplexityBot/1.0)',
      'Mozilla/5.0 (compatible; Bravebot/1.0)',
      'facebookexternalhit/1.1',
      'Twitterbot/1.0',
      'LinkedInBot/1.0',
      'Slackbot-LinkExpanding 1.0',
      'Discordbot/2.0',
      'TelegramBot (like TwitterBot)',
      'WhatsApp/2.23',
      'redditbot/1.0'
    ]
    for (const ua of KNOWN) {
      expect(agentIntent(ua), `${ua} is in no intent bucket`).not.toBe('unknown')
    }
  })
})

describe('link unfurlers', () => {
  const UNFURLERS = [
    ['facebookexternalhit/1.1', 'facebook'],
    ['Twitterbot/1.0', 'twitter'],
    ['LinkedInBot/1.0 (compatible; Mozilla/5.0)', 'linkedin'],
    ['Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'slack'],
    ['Discordbot/2.0 (+https://discordapp.com)', 'discord'],
    ['WhatsApp/2.23.20.0', 'whatsapp']
  ] as const

  it.each(UNFURLERS)('%s is preview', (ua) => {
    expect(agentIntent(ua)).toBe('preview')
  })

  it('is allowed by default', () => {
    const d = agentPolicy(
      new Request('https://example.com/', { headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0' } })
    )
    expect(d.action).toBe('allow')
    expect(d.intent).toBe('preview')
  })

  it('honours onPreview', () => {
    const d = agentPolicy(
      new Request('https://example.com/', { headers: { 'user-agent': 'Discordbot/2.0' } }),
      { onPreview: 'block' }
    )
    expect(d.action).toBe('block')
  })

  it('does not steal Applebot from search', () => {
    // Apple uses one token for the search crawler and for iMessage previews.
    // PREVIEW is tested after SEARCH so the crawler classification wins; if the
    // order is ever flipped this catches it.
    expect(agentIntent('Mozilla/5.0 (compatible; Applebot/0.1)')).toBe('search')
  })

  it('keeps preview out of the retrieval demand signal', () => {
    // The whole point of a separate bucket: retrieval is what the library sells
    // as demand. A Slack unfurl is not someone asking an assistant a question,
    // and counting it as one inflates the headline number.
    expect(agentIntent('Slackbot-LinkExpanding 1.0')).not.toBe('retrieval')
  })
})
