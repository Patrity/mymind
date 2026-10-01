/**
 * Quality check of the extract-v3 memory prompt (cycle 77). Makes REAL model calls through the
 * app's configured 'bulk' chain — run it by hand, never in CI/tests:
 *
 *   pnpm memory:eval                 # both parts
 *   pnpm memory:eval --audit-only    # the audit part only
 *
 * No memory/store writes: it calls extractV3() (prompt + chat + parser) directly and never
 * imports the enrichment service, createMemory, or any store. The only DB writes are the
 * activity_log telemetry rows chat() records on every call (via withFailover), and chat() READS
 * the AI config row to resolve the model chain, same as every other real chat() call.
 *
 * EXTRACTION part — each row of scripts/data/memory-eval-v3.jsonl is
 *   { transcript, expectKeep: string[], expectReject: string[], expectDoc: boolean, note? }
 * Memories are counted after the parser's 0.6 confidence floor, i.e. what enrichment would
 * actually store.
 *
 * PURE-STALE rows (only expectReject, no expectKeep, no expectDoc) are scored by the ROW: the
 * stale fact is rejected only if the row yields ZERO memories. A keyword test there would score a
 * reworded stale memory ("Oct 12" for "october") as rejected and inflate the gate.
 * Every other expectation (keep items, and reject items on MIXED rows) is matched by keyword: it
 * MATCHES a memory when every whitespace-separated token appears (case-insensitive substring) in
 * the memory's content. Such items need >= 2 distinctive tokens (no single letters, no month
 * names); the script warns about any that don't.
 *   - keep rate:           expectKeep entries matched by some memory / all expectKeep entries
 *   - stale-rejection rate: (pure-stale rows with zero memories + mixed-row expectReject entries
 *                           matched by NO memory) / (pure-stale rows + mixed-row reject entries)
 *   - doc routing:          expectDoc rows with >= 1 doc_candidate; plus doc candidates emitted
 *                           on rows that expected none (reported, not scored)
 * Merge bar (Task 8): keep rate >= 90%, stale-rejection rate >= 80%.
 *
 * AUDIT part — runs the extract-v3 audit (Task 3) over the 45 rows hand-labelled in
 * scripts/data/memory-labels-2026-09-22.jsonl ({ id, value, durable, selfContained, verdict }),
 * loading each row's content/project/created_at from scripts/data/memory-sample-2026-09-22.jsonl
 * by id. Reports agreement of the audit verdict against the human label, under the mapping
 * keep<->keep, stale<->transient, noise<->redundant|wrong_scope. A `belongs_in_doc` verdict has
 * no label counterpart, so it is reported separately rather than scored as agree/disagree.
 * No merge bar for this part — it is a quality read, same as the rest of the script.
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
import { extractV3, EXTRACT_PROMPT_VERSION, auditMemory, AUDIT_PROMPT_VERSION } from '../server/lib/memory/extract-v3'
import type { AuditVerdict } from '../shared/types/memory'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXTRACT_DATA = resolve(HERE, 'data/memory-eval-v3.jsonl')
const AUDIT_LABELS = resolve(HERE, 'data/memory-labels-2026-09-22.jsonl')
const AUDIT_SAMPLE = resolve(HERE, 'data/memory-sample-2026-09-22.jsonl')

interface ExtractRow {
  transcript: string
  expectKeep: string[]
  expectReject: string[]
  expectDoc: boolean
  note?: string
}

interface LabelRow {
  id: string
  value: number
  durable: boolean
  selfContained: boolean
  verdict: 'keep' | 'stale' | 'noise'
  labelledAt?: string
}

interface SampleRow {
  id: string
  content: string
  project: string | null
  created_at: string
  scope?: string
  [key: string]: unknown
}

function pct(n: number, d: number): string {
  return d ? `${((n / d) * 100).toFixed(0)}%` : 'n/a'
}

// Month names collide with dates the model rewrites ("October 12" vs "Oct 12") and with ordinary
// words ("may", "march"), so they never count as a distinctive keyword.
const MONTHS = new Set([
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec'
])

const isPureStale = (row: ExtractRow) => row.expectKeep.length === 0 && row.expectReject.length > 0 && !row.expectDoc

/** Why a keyword expectation is too weak to score, or null when it is fine. */
function weakExpectation(expectation: string): string | null {
  const toks = expectation.toLowerCase().split(/\s+/).filter(Boolean)
  if (toks.length < 2) return 'fewer than 2 tokens'
  if (toks.some(t => t.length < 2)) return 'single-letter token'
  if (toks.some(t => MONTHS.has(t))) return 'month-name token'
  return null
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
  for (const [i, row] of rows.entries()) {
    const keyworded = isPureStale(row) ? [] : [...row.expectKeep, ...row.expectReject]
    for (const e of keyworded) {
      const why = weakExpectation(e)
      if (why) console.log(`  WARN [${i}] weak expectation "${e}": ${why}`)
    }
  }

  let keepTotal = 0
  let keepHit = 0
  let rejectTotal = 0
  let rejectHit = 0
  let staleRowTotal = 0
  let staleRowHit = 0
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
      if (isPureStale(row)) staleRowTotal++
      else rejectTotal += row.expectReject.length
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
    if (isPureStale(row)) {
      staleRowTotal++
      if (contents.length === 0) staleRowHit++
      else console.log(`  ${tag} KEPT ${contents.length} memor${contents.length === 1 ? 'y' : 'ies'} from a pure-stale row (${row.expectReject.join(', ')})`)
    } else for (const r of row.expectReject) {
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
  const staleHit = staleRowHit + rejectHit
  const staleTotal = staleRowTotal + rejectTotal
  console.log(`stale-rejection rate  : ${staleHit}/${staleTotal} (${pct(staleHit, staleTotal)})   bar >= 80%`)
  console.log(`  pure-stale rows, zero memories kept : ${staleRowHit}/${staleRowTotal} (${pct(staleRowHit, staleRowTotal)})`)
  console.log(`  mixed-row stale items not kept      : ${rejectHit}/${rejectTotal} (${pct(rejectHit, rejectTotal)})`)
  console.log(`doc routing           : ${docHit}/${docTotal} (${pct(docHit, docTotal)})`)
  console.log(`unexpected doc rows   : ${docUnexpected}`)
  if (failed) console.log(`failed calls          : ${failed} (their expectations count as misses)`)
}

/**
 * keep<->keep, stale<->transient, noise<->redundant|wrong_scope. The caller reports a
 * `belongs_in_doc` verdict separately (it has no label counterpart) and never passes it here.
 */
function agreesWithLabel(verdict: Exclude<AuditVerdict, 'belongs_in_doc'>, label: LabelRow['verdict']): boolean {
  if (label === 'keep') return verdict === 'keep'
  if (label === 'stale') return verdict === 'transient'
  return verdict === 'redundant' || verdict === 'wrong_scope' // label === 'noise'
}

async function evalAudit() {
  if (!existsSync(AUDIT_LABELS) || !existsSync(AUDIT_SAMPLE)) {
    console.error(`No audit label/sample data at ${AUDIT_LABELS} / ${AUDIT_SAMPLE} — skipping audit eval`)
    return
  }
  const labels: LabelRow[] = readFileSync(AUDIT_LABELS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as LabelRow)
  const sample: SampleRow[] = readFileSync(AUDIT_SAMPLE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as SampleRow)
  const byId = new Map(sample.map(r => [r.id, r]))

  console.log('')
  console.log(`== audit (${AUDIT_PROMPT_VERSION}) over ${labels.length} labelled rows ==`)

  const now = Date.now()
  let agreeTotal = 0
  let agreeHit = 0
  let docVerdicts = 0
  let missingSample = 0
  let failed = 0
  const perLabel: Record<LabelRow['verdict'], { hit: number, total: number, verdicts: Record<string, number> }> = {
    keep: { hit: 0, total: 0, verdicts: {} },
    stale: { hit: 0, total: 0, verdicts: {} },
    noise: { hit: 0, total: 0, verdicts: {} }
  }

  for (const label of labels) {
    const row = byId.get(label.id)
    if (!row) {
      missingSample++
      console.log(`  [${label.id}] no sample row for this id — skipped`)
      continue
    }
    const ageDays = Math.max(0, Math.round((now - new Date(row.created_at).getTime()) / 86_400_000))
    const scope = typeof row.scope === 'string' ? row.scope : 'agent'

    const res = await auditMemory({ content: row.content, project: row.project, ageDays, scope })
    if (!res.ok) {
      failed++
      console.log(`  [${label.id}] audit failed: ${res.error}`)
      continue
    }
    const bucket = perLabel[label.verdict]
    bucket.verdicts[res.verdict] = (bucket.verdicts[res.verdict] ?? 0) + 1
    if (res.verdict === 'belongs_in_doc') {
      docVerdicts++
      console.log(`  [${label.id}] belongs_in_doc (label was "${label.verdict}") — reported separately, not scored`)
      continue
    }
    agreeTotal++
    bucket.total++
    if (agreesWithLabel(res.verdict, label.verdict)) {
      agreeHit++
      bucket.hit++
    } else {
      console.log(`  [${label.id}] DISAGREE label=${label.verdict} audit=${res.verdict} keep=${res.keep.toFixed(2)} reason="${res.reason}" :: ${row.content.slice(0, 100)}`)
    }
  }

  console.log('')
  console.log(`audit-vs-label agreement : ${agreeHit}/${agreeTotal} (${pct(agreeHit, agreeTotal)})`)
  for (const [label, b] of Object.entries(perLabel)) {
    const spread = Object.entries(b.verdicts).map(([v, n]) => `${v} ${n}`).join(', ')
    console.log(`  label ${label.padEnd(5)} : ${b.hit}/${b.total} (${pct(b.hit, b.total)})   verdicts: ${spread || '-'}`)
  }
  console.log(`belongs_in_doc verdicts  : ${docVerdicts}/${labels.length} (reported separately, not scored as agree/disagree)`)
  if (missingSample) console.log(`rows with no sample match : ${missingSample}`)
  if (failed) console.log(`failed audit calls        : ${failed} (excluded from the agreement total)`)
}

/** `--audit-only` skips the extraction part (e.g. to re-read the audit alone after a prompt edit). */
async function main() {
  if (!process.argv.includes('--audit-only')) await evalExtraction()
  await evalAudit()
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(0) // always exits 0 — a quality read, not a gate
  })
