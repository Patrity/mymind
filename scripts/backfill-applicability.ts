/**
 * One-time classification backfill: does this memory travel across projects, or is it
 * bound to the one it was learned in?
 *
 * `memories.project` records where a fact was LEARNED (enrichment runs per-session, a
 * session has a project, the memory inherits it) — not where it APPLIES. A universal
 * working preference revealed mid-session sits filed under whichever project happened to
 * be open at the time. This script asks Jev the narrow observable question per live,
 * still-`project`-tagged memory and sets `applicability = 'global'` on the ones that
 * travel, gated by confidence (`decideApplicability`, scripts/lib/applicability.ts).
 *
 * RULING 18 (fix round 1): a `review` verdict does NOT file a `review_queue` row anymore.
 * The classifier's raw `noul` is compressed in the middle across the live store (p25 0.63,
 * median 0.75, p75 0.84 on a 0-1 scale) — only 7.8% of scores fell outside the 0.9/0.1 gate
 * at all. Queueing the other 92.2% put 1,475 low-value `applicability` rows into
 * `review_queue`, burying the surface's other kinds (4 memory-contradict, 17 triage, 10
 * enrichment) under noise. A `review` verdict just leaves the memory at its pre-existing
 * `applicability = 'project'` default — a no-op, not a regression — and `global` promotion
 * is expected to happen from the resident-promotion / retrieval-count path instead: a memory
 * that's actually reused across projects, a measured signal, rather than a single model
 * opinion on a distribution too flat to gate confidently. See `decideApplicability`'s own
 * doc comment in scripts/lib/applicability.ts for the full rationale.
 *
 *   set -a; . /Users/tony/Documents/GitHub/homelab/.env; set +a
 *   node_modules/.bin/tsx scripts/backfill-applicability.ts --dry-run   # run this FIRST
 *   node_modules/.bin/tsx scripts/backfill-applicability.ts            # then for real
 *
 * `useDb()` reads `useRuntimeConfig().databaseUrl`, a Nuxt auto-import not available to a
 * bare tsx process — polyfilled below, before importing anything that calls it (same
 * pattern as scripts/seed-skills.ts, task-5-report.md). The `declare global` gives the
 * standalone `tsc -p` check (scripts/ isn't covered by `pnpm typecheck` — see
 * `.nuxt/tsconfig.server.json`'s `include`, which has no `scripts/**` entry) a type for the
 * same symbol Nuxt would otherwise supply via its generated `.nuxt/types`.
 */
declare global {
  function useRuntimeConfig(): { databaseUrl?: string }
}
globalThis.useRuntimeConfig = () => ({ databaseUrl: process.env.DATABASE_URL })

import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { and, eq, isNull } from 'drizzle-orm'
import { useDb } from '../server/db'
import { memories } from '../server/db/schema'
import { decideApplicability } from './lib/applicability'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, 'data/applicability-backfill-2026-09-24.jsonl')

const MODEL = 'jev-1.13.0' // pinned, never jev-latest — see scripts/jev-score.ts
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const CONCURRENCY = 6 // 8 has hit 429s before; stay under it (scripts/jev-score.ts)

const DRY_RUN = process.argv.includes('--dry-run')

// Single Noul question. Phrasing matches the brief verbatim.
const QUESTIONS = {
  projectBound: {
    type: 'noul',
    instructions: 'This fact is specific to one named project or codebase, rather than being true across all of Tony\'s work'
  }
} as const

interface Row { id: string, content: string }

interface NoulAnswer { type: 'noul', noul: number }

interface Outcome {
  id: string
  content: string
  /** Raw API answer: P(this fact is project-bound). NOT what's fed to decideApplicability. */
  noul: number
  decision: 'global' | 'project' | 'review'
  inputTokens: number
}

async function askJev(row: Row, key: string, attempt = 0): Promise<{ noul: number, inputTokens: number }> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: row.content, model: MODEL, questions: QUESTIONS })
  })

  if (res.status === 429 && attempt < 5) {
    const wait = Number(res.headers.get('retry-after') ?? 0) * 1000 || 2 ** attempt * 500
    await new Promise(r => setTimeout(r, wait))
    return askJev(row, key, attempt + 1)
  }
  if (!res.ok) throw new Error(`${row.id}: ${res.status} ${(await res.text()).slice(0, 200)}`)

  const body = await res.json() as { answers: Record<string, NoulAnswer>, usage: Record<string, number> }
  const answer = body.answers.projectBound
  if (!answer || answer.type !== 'noul' || typeof answer.noul !== 'number') {
    throw new Error(`${row.id}: malformed answer ${JSON.stringify(answer)}`)
  }
  return { noul: answer.noul, inputTokens: body.usage?.input_tokens ?? 0 }
}

async function main() {
  const key = process.env.JEV_KEY
  if (!key) {
    console.error('JEV_KEY is not set (it lives in the homelab repo .env)')
    process.exit(1)
  }

  const db = useDb()
  const rows: Row[] = await db.select({ id: memories.id, content: memories.content })
    .from(memories)
    .where(and(isNull(memories.archivedAt), eq(memories.applicability, 'project')))

  console.log(`${DRY_RUN ? 'DRY RUN — ' : ''}${rows.length} live, project-tagged memories to classify`)

  const outcomes: Outcome[] = []
  const errors: string[] = []
  const started = Date.now()
  let next = 0

  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const i = next++
      if (i >= rows.length) return
      const row = rows[i]!
      try {
        const { noul, inputTokens } = await askJev(row, key)
        // ⚠️ POLARITY: the question asks about being PROJECT-BOUND, so a high `noul` means
        // project-bound. decideApplicability wants the probability the fact TRAVELS
        // (the opposite), so we invert here. Getting this backwards marks every
        // project-specific memory as global and contaminates every other project's context.
        const travelProbability = 1 - noul
        const decision = decideApplicability(travelProbability)
        outcomes.push({ id: row.id, content: row.content, noul, decision, inputTokens })
      } catch (e) {
        errors.push(String(e))
      }
      if (outcomes.length % 50 === 0) process.stdout.write(`\r  ${outcomes.length}/${rows.length}`)
    }
  }))

  console.log(`\r  ${outcomes.length}/${rows.length} classified in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  if (errors.length) console.log(`  ${errors.length} errors:\n   ${errors.slice(0, 5).join('\n   ')}`)

  const buckets = { global: 0, project: 0, review: 0 }
  for (const o of outcomes) buckets[o.decision]++

  console.log(`\n  global: ${buckets.global}  project: ${buckets.project}  review: ${buckets.review}`)
  const globalPct = outcomes.length ? (buckets.global / outcomes.length) * 100 : 0
  console.log(`  global = ${globalPct.toFixed(1)}% of classified`)

  const tokens = outcomes.reduce((a, o) => a + o.inputTokens, 0)
  console.log(`  ${tokens.toLocaleString()} input tokens -> $${(tokens / 1e6 * 0.042).toFixed(5)}`)

  if (DRY_RUN) {
    console.log('\n  --dry-run: wrote NOTHING (no DB writes, no output file)')
    return
  }

  if (globalPct > 25) {
    console.log(`\n  STOPPING: global (${globalPct.toFixed(1)}%) exceeds the ~25% sanity bar.`)
    console.log('  This is the same failure mode that once put needs_verification on 248/276')
    console.log('  memories — the question is likely mis-worded and firing too broadly.')
    console.log('  Reword and re-dry-run instead of writing this batch.')
    process.exit(1)
  }

  let updated = 0
  for (const o of outcomes) {
    if (o.decision === 'global') {
      await db.update(memories)
        .set({ applicability: 'global', updatedAt: new Date() })
        .where(eq(memories.id, o.id))
      updated++
    }
    // decision === 'project', and decision === 'review': no-op — stays at the pre-existing
    // 'project' default (RULING 18 — see the doc comment above and decideApplicability's own).
  }

  console.log(`\n  wrote: ${updated} memories set to global`)

  writeFileSync(OUT, outcomes.map(o => JSON.stringify(o)).join('\n') + '\n')
  console.log(`  audit trail: ${OUT}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
