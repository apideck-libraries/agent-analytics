#!/usr/bin/env node
/**
 * Regenerate src/bot-ranges.ts from the vendors' published crawler IP feeds.
 *
 *     node scripts/refresh-bot-ranges.mjs
 *
 * Run this on a schedule. The lists rotate, and a stale snapshot is worse than
 * no snapshot: it produces false 'spoofed' verdicts on legitimate crawlers,
 * which is exactly the conclusion you'd act on. The script refuses to write a
 * file when a feed fails or shrinks implausibly, so a bad fetch can't silently
 * empty out a vendor.
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bot-ranges.ts')

// Vendor label (as parseBotName returns) -> the feeds that make up its ranges.
const FEEDS = {
  ChatGPT: [
    'https://openai.com/gptbot.json',
    'https://openai.com/chatgpt-user.json',
    'https://openai.com/searchbot.json'
  ],
  Claude: ['https://claude.com/crawling/bots.json'],
  Perplexity: ['https://www.perplexity.ai/perplexitybot.json'],
  Apple: ['https://search.developer.apple.com/applebot.json']
}

// A feed dropping below this fraction of its previous size signals a partial
// or malformed response rather than a genuine shrink. Bail instead of writing.
const SHRINK_FLOOR = 0.5

async function fetchPrefixes(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'agent-analytics range refresher' } })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  const body = await res.json()
  const prefixes = body?.prefixes
  if (!Array.isArray(prefixes)) throw new Error(`${url} -> no prefixes array`)
  // Feeds use ipv4Prefix / ipv6Prefix keys; take whichever is present.
  return prefixes.map((e) => e.ipv4Prefix ?? e.ipv6Prefix).filter(Boolean)
}

function previousCounts() {
  try {
    const src = readFileSync(OUT, 'utf8')
    const counts = {}
    for (const vendor of Object.keys(FEEDS)) {
      const block = src.match(new RegExp(`  ${vendor}: \\[([\\s\\S]*?)\\n  \\]`))
      counts[vendor] = block ? (block[1].match(/'/g) || []).length / 2 : 0
    }
    return counts
  } catch {
    return {}
  }
}

const before = previousCounts()
const vendors = {}

for (const [vendor, urls] of Object.entries(FEEDS)) {
  const all = new Set()
  for (const url of urls) {
    const got = await fetchPrefixes(url) // throws — a failed feed must abort the run
    got.forEach((p) => all.add(p))
    console.log(`  ${url} -> ${got.length}`)
  }
  const list = [...all].sort()
  const prev = before[vendor] ?? 0
  if (prev && list.length < prev * SHRINK_FLOOR) {
    throw new Error(
      `${vendor}: ${list.length} prefixes vs ${prev} previously — refusing to write a suspiciously small list`
    )
  }
  vendors[vendor] = list
  console.log(`${vendor}: ${list.length} prefixes (was ${prev})`)
}

const capturedAt = new Date().toISOString()
const body = `/**
 * Published crawler IP ranges, vendor by vendor.
 *
 * GENERATED FILE — do not edit by hand. Regenerate with:
 *
 *     node scripts/refresh-bot-ranges.mjs
 *
 * Keys match the labels {@link parseBotName} returns, so a claimed identity
 * maps to its range list without a translation table.
 *
 * Only vendors that publish a machine-readable feed appear here. A vendor's
 * absence means "cannot be verified", never "not a real bot" — see
 * {@link verifyBotIdentity} for how that distinction is surfaced.
 *
 * Freshness is the whole ballgame: these lists rotate. Almost every OpenAI
 * prefix is an Azure block and every Anthropic prefix is GCP or similar, so
 * "came from a datacenter" proves nothing on its own — only membership in the
 * current published list does. A stale snapshot produces false 'spoofed'
 * verdicts on legitimate crawlers, which is the failure mode to fear.
 */

/** When these ranges were captured from the vendor feeds (UTC). */
export const BOT_RANGES_CAPTURED_AT = '${capturedAt}'

export const BOT_IP_RANGES: Readonly<Record<string, readonly string[]>> = {
${Object.entries(vendors)
  .map(([name, cidrs]) => `  ${name}: [\n${cidrs.map((c) => `    '${c}',`).join('\n')}\n  ],`)
  .join('\n')}
}

/** Vendor labels this build can verify. Anything else yields a null verdict. */
export const VERIFIABLE_VENDORS: readonly string[] = Object.keys(BOT_IP_RANGES)
`

writeFileSync(OUT, body)
console.log(`\nwrote ${OUT}`)
