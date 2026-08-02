#!/usr/bin/env node
/**
 * Bundle budget check.
 *
 * The root entry is edge middleware code — it runs on every request of every
 * consumer, so its size is a feature, not a vanity metric.
 *
 * This exists because the number silently doubled. #21 cut the root from 27.7 kB
 * to 9.6 kB; over the following commits payments, gateway, entitlement and
 * firewall were each exported from the root by reflex, and it climbed back to
 * 22.5 kB. Nothing failed. Every test passed. It was caught weeks later while
 * fetching a figure for a marketing page.
 *
 * So: assert the invariant rather than trusting anyone to remember. Zero
 * dependencies, in keeping with the package.
 *
 *   node scripts/check-size.mjs           # check
 *   node scripts/check-size.mjs --update  # rewrite budgets to current + headroom
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUDGET_FILE = join(root, 'size-budget.json')

/** Headroom applied by --update. Tight enough that a real regression trips it. */
const HEADROOM = 1.1

function gzipped(path) {
  return gzipSync(readFileSync(path), { level: 9 }).length
}

function fmt(n) {
  return `${(n / 1024).toFixed(2)} kB`
}

if (!existsSync(BUDGET_FILE)) {
  console.error(`No ${BUDGET_FILE}. Run with --update to create one.`)
  process.exit(1)
}

const budgets = JSON.parse(readFileSync(BUDGET_FILE, 'utf8'))
const update = process.argv.includes('--update')

const rows = []
let failed = false

for (const [file, entry] of Object.entries(budgets.entries)) {
  const path = join(root, file)
  if (!existsSync(path)) {
    console.error(`missing build output: ${file} — run \`npm run build\` first`)
    process.exit(1)
  }
  const actual = gzipped(path)
  const limit = entry.gzipBudget
  const pct = Math.round((actual / limit) * 100)
  const over = actual > limit
  if (over) failed = true
  rows.push({ file, actual, limit, pct, over, note: entry.note })
  if (update) entry.gzipBudget = Math.ceil((actual * HEADROOM) / 10) * 10
}

const width = Math.max(...rows.map((r) => r.file.length))
console.log('')
console.log(`${'entry'.padEnd(width)}  ${'gzipped'.padStart(9)}  ${'budget'.padStart(9)}  used`)
console.log('-'.repeat(width + 32))
for (const r of rows) {
  const flag = r.over ? '  OVER' : ''
  console.log(
    `${r.file.padEnd(width)}  ${fmt(r.actual).padStart(9)}  ${fmt(r.limit).padStart(9)}  ${String(r.pct).padStart(3)}%${flag}`
  )
}
console.log('')

if (update) {
  writeFileSync(BUDGET_FILE, JSON.stringify(budgets, null, 2) + '\n')
  console.log(`Budgets rewritten to current + ${Math.round((HEADROOM - 1) * 100)}% headroom.`)
  process.exit(0)
}

if (failed) {
  console.error('Bundle budget exceeded.\n')
  console.error('This is usually one of two things:')
  console.error('  1. Something optional got exported from the root entry. Check src/index.ts —')
  console.error('     payments, firewall and verify belong behind subpaths, not in every')
  console.error('     consumer\'s edge bundle.')
  console.error('  2. The growth is genuinely warranted. Then raise the budget deliberately:')
  console.error('     node scripts/check-size.mjs --update, and say why in the commit.\n')
  process.exit(1)
}

console.log('All entries within budget.')
