/**
 * One-shot quality check of the reflector's thread-pass proposals against a small, hand-written
 * transcript set (cycle 76 Task 8). Makes REAL model calls through the app's configured chain —
 * run it by hand once in a while, never in CI/tests:
 *
 *   pnpm reflect:eval
 *
 * Each row in scripts/data/reflect-eval.jsonl is { transcript, expect }, where `expect` is
 * null, one { kind, target? }, or an array of them (a "mixed" row).
 * No gate, no DB writes: callReflector is called directly against the thread-pass prompt (empty
 * skills/profile/rejections) and its proposals are compared to `expect`. This script must never
 * import processProposal, apply.ts or any store — that is what keeps it write-free. (It does READ
 * the AI config row to resolve the model chain, same as every other real chat() call.)
 *
 *   - "null" rows (small talk, a one-off lookup, a failed attempt, a mood) score PRECISION: the
 *     fraction where the reflector correctly proposed nothing.
 *   - single-expectation rows score HIT RATE: one of its proposals matches the expected kind,
 *     and the target too when the row names one. skill.create rows name no target: the slug the
 *     model picks is its own choice, not a quality signal.
 *   - mixed rows (a procedure AND a preference in one thread) score BOTH KINDS PRESENT: every
 *     expected kind appears among the proposals — i.e. the two lessons were not merged.
 *
 * Always exits 0 — this is a quality signal to read by eye, not a pass/fail gate.
 */
// `useDb()` (inside chat -> withFailover -> loadConfig) needs core initialised with databaseUrl:
// scripts/lib/core-init.ts, which must stay the FIRST import. chat() imports `ofetch` itself
// (cycle 80), so the old globalThis.$fetch shim is gone.
import './lib/core-init'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callReflector } from '../server/lib/agent/reflect/call'
import { threadReflectionMessages } from '../server/lib/agent/reflect/prompt'
import type { Proposal } from '../server/lib/agent/reflect/schema'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = resolve(HERE, 'data/reflect-eval.jsonl')

const THREAD_KINDS: Proposal['kind'][] = ['skill.create', 'skill.edit', 'profile.edit']

interface Expectation { kind: Proposal['kind'], target?: string }
interface EvalRow {
  transcript: string
  expect: Expectation | Expectation[] | null
}

const matches = (p: Proposal, e: Expectation) => p.kind === e.kind && (e.target === undefined || p.target === e.target)
const label = (e: Expectation) => e.target ? `${e.kind} ${e.target}` : e.kind

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
  let mixedTotal = 0
  let mixedBoth = 0

  for (const [i, row] of rows.entries()) {
    const messages = threadReflectionMessages({ transcript: row.transcript, skills: [], profile: '', recentRejections: [] })
    const res = await callReflector(messages, THREAD_KINDS)
    if (!res.ok) {
      console.log(`  [${i}] call failed: ${res.error}`)
      if (row.expect === null) nullTotal++
      else if (Array.isArray(row.expect)) mixedTotal++
      else expectTotal++
      continue
    }
    const proposals = res.proposals

    if (row.expect === null) {
      nullTotal++
      if (proposals.length === 0) nullCorrect++
      else console.log(`  [${i}] false positive — expected nothing, got: ${describe(proposals)}`)
    } else if (Array.isArray(row.expect)) {
      mixedTotal++
      const all = row.expect
      if (all.every(e => proposals.some(p => matches(p, e)))) mixedBoth++
      else console.log(`  [${i}] mixed miss — expected ${all.map(label).join(' + ')}, got: ${describe(proposals)}`)
    } else {
      expectTotal++
      const expect = row.expect
      if (proposals.some(p => matches(p, expect))) expectHit++
      else console.log(`  [${i}] miss — expected ${label(expect)}, got: ${describe(proposals)}`)
    }
  }

  console.log('')
  console.log(`precision on null rows (${nullTotal} rows): ${nullCorrect}/${nullTotal} (${pct(nullCorrect, nullTotal)})`)
  console.log(`hit rate on the rest   (${expectTotal} rows): ${expectHit}/${expectTotal} (${pct(expectHit, expectTotal)})`)
  console.log(`mixed rows, both kinds (${mixedTotal} rows): ${mixedBoth}/${mixedTotal} (${pct(mixedBoth, mixedTotal)})`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(0) // always exits 0 — a quality read, not a gate
  })
