/**
 * One-shot quality check of the reflector's thread-pass proposals against a small, hand-written
 * transcript set (cycle 76 Task 8). Makes REAL model calls through the app's configured chain —
 * run it by hand once in a while, never in CI/tests:
 *
 *   pnpm reflect:eval
 *
 * Each row in scripts/data/reflect-eval.jsonl is { transcript, expect: { kind, target } | null }.
 * No gate, no DB writes: callReflector is called directly against the thread-pass prompt (empty
 * skills/profile/rejections) and its proposals are compared to `expect`. (It does READ the AI
 * config row to resolve the model chain, same as every other real chat() call — that's a read,
 * not a write.)
 *
 *   - "null" rows (small talk, a one-off lookup, a failed attempt, a mood) score PRECISION: the
 *     fraction where the reflector correctly proposed nothing.
 *   - the rest score HIT RATE: the fraction where one of its proposals matches the expected
 *     kind + target.
 *
 * Always exits 0 — this is a quality signal to read by eye, not a pass/fail gate.
 */
// `useDb()` (inside callReflector -> chat -> withFailover -> loadConfig) reads
// `useRuntimeConfig().databaseUrl`, a Nuxt auto-import not available to a bare tsx process.
// Polyfill both auto-imports as globals BEFORE importing anything that calls them (same pattern
// as scripts/seed-skills.ts).
;(globalThis as any).useRuntimeConfig = () => ({ databaseUrl: process.env.DATABASE_URL })
;(globalThis as any).$fetch = globalThis.fetch

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callReflector } from '../server/lib/agent/reflect/call'
import { threadReflectionMessages } from '../server/lib/agent/reflect/prompt'
import type { Proposal } from '../server/lib/agent/reflect/schema'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = resolve(HERE, 'data/reflect-eval.jsonl')

const THREAD_KINDS: Proposal['kind'][] = ['skill.create', 'skill.edit', 'profile.edit']

interface EvalRow {
  transcript: string
  expect: { kind: Proposal['kind'], target: string } | null
}

function describe(proposals: Proposal[]): string {
  return proposals.length ? proposals.map(p => `${p.kind} ${p.target}`).join(', ') : '(none)'
}

function pct(n: number, d: number): string {
  return d ? `${((n / d) * 100).toFixed(0)}%` : 'n/a'
}

async function main() {
  if (!existsSync(DATA)) {
    console.error(`No eval data at ${DATA}`)
    process.exit(0)
    return
  }
  const rows: EvalRow[] = readFileSync(DATA, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as EvalRow)

  let nullTotal = 0
  let nullCorrect = 0
  let expectTotal = 0
  let expectHit = 0

  for (const [i, row] of rows.entries()) {
    const messages = threadReflectionMessages({ transcript: row.transcript, skills: [], profile: '', recentRejections: [] })
    const res = await callReflector(messages, THREAD_KINDS)
    if (!res.ok) {
      console.log(`  [${i}] call failed: ${res.error}`)
      if (row.expect === null) nullTotal++
      else expectTotal++
      continue
    }
    const proposals = res.proposals

    if (row.expect === null) {
      nullTotal++
      if (proposals.length === 0) nullCorrect++
      else console.log(`  [${i}] false positive — expected nothing, got: ${describe(proposals)}`)
    } else {
      expectTotal++
      const expect = row.expect
      const hit = proposals.some(p => p.kind === expect.kind && p.target === expect.target)
      if (hit) expectHit++
      else console.log(`  [${i}] miss — expected ${expect.kind} ${expect.target}, got: ${describe(proposals)}`)
    }
  }

  console.log('')
  console.log(`precision on null rows (${nullTotal} rows): ${nullCorrect}/${nullTotal} (${pct(nullCorrect, nullTotal)})`)
  console.log(`hit rate on the rest   (${expectTotal} rows): ${expectHit}/${expectTotal} (${pct(expectHit, expectTotal)})`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(0) // always exits 0 — a quality read, not a gate
  })
