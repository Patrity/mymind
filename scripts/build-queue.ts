/**
 * Build a blinded uncertainty-sampling queue for the next labelling pass.
 *
 *   node_modules/.bin/tsx scripts/build-queue.ts
 *
 * Random labelling spends most of its effort on obvious keeps, which move no
 * threshold — that is why it feels tedious. This concentrates the next pass on
 * the rows that would actually settle something: the ones Jev flags as
 * `transient`, the one signal that survived its confidence interval (AUC 0.81
 * [0.62-0.96] for detecting noise, on only 4 noise items — a hypothesis in need
 * of a real test).
 *
 * Those flagged rows are mixed 1:1 with controls drawn at random from the rest
 * and shuffled, so the labeller cannot tell a flagged row from a control. That
 * matters more than the concentration does: served raw, a labeller primed to
 * expect noise would label the prediction instead of the memory, and the queue
 * would destroy the measurement it exists to sharpen. The controls are not
 * waste either — they are the negative class the AUC needs.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SAMPLE = resolve(HERE, 'data/memory-sample-2026-09-22.jsonl')
const SCORES = resolve(HERE, 'data/jev-scores-2026-09-22.jsonl')
const LABELS = resolve(HERE, 'data/memory-labels-2026-09-22.jsonl')
const OUT = resolve(HERE, 'data/label-queue-2026-09-22.json')

const FLAG_SIGNAL = 'transient'
const FLAG_THRESHOLD = 0.5
const SEED = 20260922

/** Deterministic shuffle — the queue must be reproducible across runs. */
function shuffled<T>(items: T[], seed: number): T[] {
  let s = seed
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

const lines = (p: string) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))

function main() {
  for (const p of [SAMPLE, SCORES]) {
    if (!existsSync(p)) {
      console.error(`missing ${p}`)
      process.exit(1)
    }
  }

  const scores = lines(SCORES) as { id: string, answers: Record<string, { noul: number }> }[]
  const done = new Set(existsSync(LABELS) ? lines(LABELS).map((l: { id: string }) => l.id) : [])
  const open = scores.filter(s => !done.has(s.id))

  const flagged = open.filter(s => (s.answers[FLAG_SIGNAL]?.noul ?? 0) > FLAG_THRESHOLD)
  const pool = open.filter(s => (s.answers[FLAG_SIGNAL]?.noul ?? 0) <= FLAG_THRESHOLD)
  const controls = shuffled(pool, SEED).slice(0, flagged.length)

  const queue = shuffled([...flagged, ...controls], SEED + 1).map(s => s.id)
  writeFileSync(OUT, JSON.stringify(queue, null, 2) + '\n')

  console.log(`  ${open.length} unlabelled`)
  console.log(`  ${flagged.length} flagged (${FLAG_SIGNAL} > ${FLAG_THRESHOLD}) + ${controls.length} controls`)
  console.log(`  queue of ${queue.length}, shuffled — indistinguishable at label time`)
  console.log(`  ${OUT}`)
}

main()
