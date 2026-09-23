/**
 * Score the hand-labelled memory sample with Jev.
 *
 *   JEV_KEY=... node_modules/.bin/tsx scripts/jev-score.ts
 *
 * Asks the two holistic facets (value, durable) AND a set of atomic sub-questions
 * in the SAME call. Extra questions are latency-free, and the decomposition is the
 * open question that matters: on jev-phishing-bench a single holistic question
 * scored 62.6% where five atomic ones combined scored 95.0%. If MyMind's 64.9%
 * category agreement is the same "asked once" failure mode, the atomic signals
 * will carry more information than `value` does on its own.
 *
 * `self_contained` is deliberately absent — 27 of the first 28 labels were true,
 * so the facet has no discriminating power on this store.
 *
 * The model version is pinned, not `jev-latest`: these numbers get compared against
 * later runs, and a silent model bump would make that comparison meaningless.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SAMPLE = resolve(HERE, 'data/memory-sample-2026-09-22.jsonl')
const OUT = resolve(HERE, 'data/jev-scores-2026-09-22.jsonl')

const MODEL = 'jev-1.13.0'
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const CONCURRENCY = 6 // 8 has hit 429s before; stay under it

const QUESTIONS = {
  // --- holistic: the facets the uses doc proposes thresholding on ---
  value: {
    type: 'score',
    instructions: 'How valuable is this memory to keep in a long-term engineering knowledge base',
    criteria: [
      'Noise - transient status or too vague to act on',
      'Marginal - true but easily re-derived',
      'Useful - a real convention, constraint or decision',
      'Critical - a hard-won gotcha worth hours'
    ]
  },
  durable: {
    type: 'noul',
    instructions: 'This will still be true and useful in six months, rather than describing a temporary state, an in-progress task, a branch name or a status snapshot'
  },
  // --- atomic: observable facts, for the decomposition test ---
  names_specific: {
    type: 'noul',
    instructions: 'This names at least one specific identifier a person could look up: a file path, a command, a config key, an endpoint, an error message, or a concrete number'
  },
  states_reason: {
    type: 'noul',
    instructions: 'This explains a cause, a constraint or a rationale, rather than only stating what is the case'
  },
  rederivable: {
    type: 'noul',
    instructions: 'An engineer unfamiliar with this could re-derive this fact in under five minutes by reading the code or running a single command'
  },
  transient: {
    type: 'noul',
    instructions: 'This describes a point-in-time snapshot: a current status, an active branch, a task in progress, or what someone was doing at the time'
  },
  version_bound: {
    type: 'noul',
    instructions: 'This depends on a specific version number, model name, host address or service that is expected to be replaced or upgraded'
  }
} as const

interface SampleRow { id: string, content: string, scope: string, stratum: string }

async function score(row: SampleRow, key: string, attempt = 0): Promise<Record<string, unknown>> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: row.content, model: MODEL, questions: QUESTIONS })
  })

  if (res.status === 429 && attempt < 5) {
    const wait = Number(res.headers.get('retry-after') ?? 0) * 1000 || 2 ** attempt * 500
    await new Promise(r => setTimeout(r, wait))
    return score(row, key, attempt + 1)
  }
  if (!res.ok) throw new Error(`${row.id}: ${res.status} ${(await res.text()).slice(0, 200)}`)

  const body = await res.json() as { answers: Record<string, unknown>, usage: Record<string, number> }
  return { id: row.id, scope: row.scope, stratum: row.stratum, answers: body.answers, usage: body.usage }
}

async function main() {
  const key = process.env.JEV_KEY
  if (!key) {
    console.error('JEV_KEY is not set (it lives in the homelab repo .env)')
    process.exit(1)
  }
  if (!existsSync(SAMPLE)) {
    console.error(`No sample at ${SAMPLE}`)
    process.exit(1)
  }

  const rows: SampleRow[] = readFileSync(SAMPLE, 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l) as SampleRow)

  const out: Record<string, unknown>[] = []
  const errors: string[] = []
  const started = Date.now()
  let next = 0

  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const i = next++
      if (i >= rows.length) return
      try {
        out.push(await score(rows[i]!, key))
      } catch (e) {
        errors.push(String(e))
      }
      if (out.length % 20 === 0) process.stdout.write(`\r  ${out.length}/${rows.length}`)
    }
  }))

  writeFileSync(OUT, out.map(o => JSON.stringify(o)).join('\n') + '\n')

  const tokens = out.reduce((a, o) => a + ((o.usage as Record<string, number>)?.input_tokens ?? 0), 0)
  console.log(`\r  ${out.length}/${rows.length} scored in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  console.log(`  ${tokens.toLocaleString()} input tokens -> $${(tokens / 1e6 * 0.042).toFixed(5)}`)
  if (errors.length) console.log(`  ${errors.length} errors:\n   ${errors.slice(0, 3).join('\n   ')}`)
  console.log(`  ${OUT}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
