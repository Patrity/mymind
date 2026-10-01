/**
 * Quality check of the extract-v3 memory prompt (cycle 77). Makes REAL model calls through the
 * app's configured 'bulk' chain — run it by hand, never in CI/tests:
 *
 *   pnpm memory:eval
 *
 * No DB writes: it calls extractV3() (prompt + chat + parser) directly and never imports the
 * enrichment service, createMemory, or any store. (chat() does READ the AI config row to resolve
 * the model chain, same as every other real chat() call.)
 *
 * EXTRACTION part — each row of scripts/data/memory-eval-v3.jsonl is
 *   { transcript, expectKeep: string[], expectReject: string[], expectDoc: boolean, note? }
 * An expectation MATCHES a memory when every whitespace-separated token in it appears
 * (case-insensitive substring) in the memory's content. Memories are counted after the parser's
 * 0.6 confidence floor, i.e. what enrichment would actually store.
 *   - keep rate:           expectKeep entries matched by some memory / all expectKeep entries
 *   - stale-rejection rate: expectReject entries matched by NO memory / all expectReject entries
 *   - doc routing:          expectDoc rows with >= 1 doc_candidate; plus doc candidates emitted
 *                           on rows that expected none (reported, not scored)
 * Merge bar (Task 8): keep rate >= 90%, stale-rejection rate >= 80%.
 *
 * (The audit-vs-labels part is added by cycle 77 Task 3.)
 *
 * Always exits 0 — a quality read, not a gate.
 */
// `useDb()` (inside chat -> withFailover -> loadConfig) reads `useRuntimeConfig().databaseUrl`, a
// Nuxt auto-import not available to a bare tsx process. Polyfill both auto-imports as globals
// BEFORE importing anything that calls them (same pattern as scripts/reflect-eval.ts).
;(globalThis as any).useRuntimeConfig = () => ({ databaseUrl: process.env.DATABASE_URL })
// chat() calls `$fetch(url, { method, headers, body: <object> })` and expects PARSED JSON back
// (ofetch semantics); plain fetch would send "[object Object]". Minimal self-contained shim.
;(globalThis as any).$fetch = async (url: string, opts: { method?: string, headers?: Record<string, string>, body?: unknown, signal?: AbortSignal } = {}) => {
  const res = await fetch(url, {
    method: opts.method,
    signal: opts.signal,
    headers: { 'content-type': 'application/json', ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractV3, EXTRACT_PROMPT_VERSION } from '../server/lib/memory/extract-v3'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXTRACT_DATA = resolve(HERE, 'data/memory-eval-v3.jsonl')

interface ExtractRow {
  transcript: string
  expectKeep: string[]
  expectReject: string[]
  expectDoc: boolean
  note?: string
}

function pct(n: number, d: number): string {
  return d ? `${((n / d) * 100).toFixed(0)}%` : 'n/a'
}

/** Every whitespace-separated token of `expectation` appears in `content` (case-insensitive). */
function matches(expectation: string, content: string): boolean {
  const hay = content.toLowerCase()
  return expectation.toLowerCase().split(/\s+/).filter(Boolean).every(tok => hay.includes(tok))
}

async function evalExtraction() {
  if (!existsSync(EXTRACT_DATA)) {
    console.error(`No extraction eval data at ${EXTRACT_DATA}`)
    return
  }
  const rows: ExtractRow[] = readFileSync(EXTRACT_DATA, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as ExtractRow)
  console.log(`== extraction (${EXTRACT_PROMPT_VERSION}) over ${rows.length} rows ==`)

  let keepTotal = 0
  let keepHit = 0
  let rejectTotal = 0
  let rejectHit = 0
  let docTotal = 0
  let docHit = 0
  let docUnexpected = 0
  let failed = 0

  for (const [i, row] of rows.entries()) {
    const tag = `[${i}]${row.note ? ` (${row.note})` : ''}`
    let res
    try {
      res = await extractV3(row.transcript)
    } catch (err) {
      failed++
      keepTotal += row.expectKeep.length
      rejectTotal += row.expectReject.length
      if (row.expectDoc) docTotal++
      console.log(`  ${tag} call failed: ${String(err)}`)
      continue
    }
    const contents = res.memories.map(m => m.content)

    for (const k of row.expectKeep) {
      keepTotal++
      if (contents.some(c => matches(k, c))) keepHit++
      else console.log(`  ${tag} MISSED durable "${k}"`)
    }
    for (const r of row.expectReject) {
      rejectTotal++
      const hit = contents.find(c => matches(r, c))
      if (!hit) rejectHit++
      else console.log(`  ${tag} KEPT stale "${r}": ${hit}`)
    }
    if (row.expectDoc) {
      docTotal++
      if (res.docCandidates.length > 0) docHit++
      else console.log(`  ${tag} no doc_candidate`)
    } else if (res.docCandidates.length > 0) {
      docUnexpected++
      console.log(`  ${tag} unexpected doc_candidate(s): ${res.docCandidates.map(d => d.text.slice(0, 80)).join(' | ')}`)
    }
    for (const m of res.memories) console.log(`  ${tag} memory (${m.confidence ?? '?'}): ${m.content}`)
  }

  console.log('')
  console.log(`keep rate             : ${keepHit}/${keepTotal} (${pct(keepHit, keepTotal)})   bar >= 90%`)
  console.log(`stale-rejection rate  : ${rejectHit}/${rejectTotal} (${pct(rejectHit, rejectTotal)})   bar >= 80%`)
  console.log(`doc routing           : ${docHit}/${docTotal} (${pct(docHit, docTotal)})`)
  console.log(`unexpected doc rows   : ${docUnexpected}`)
  if (failed) console.log(`failed calls          : ${failed} (their expectations count as misses)`)
}

async function main() {
  await evalExtraction()
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(0) // always exits 0 — a quality read, not a gate
  })
