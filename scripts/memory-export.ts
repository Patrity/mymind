/**
 * Export every memory's scores for the cycle-77 analysis (spec §7). READ-ONLY: one SELECT.
 *
 *   pnpm memory:export
 *
 * Writes scripts/data/memory-scores-<YYYY-MM-DD>.csv and .jsonl (gitignored — they carry raw
 * memory contents). One row per memory, archived ones included (the `archived` column says so):
 * content, project, created_at, the extraction confidence + extract prompt version, the audit
 * (keep / verdict / reason / model / prompt version / failures), Jev (keep + raw answers /
 * model / failures), |audit − Jev| disagreement, archived/reviewed state, and Tony's hand labels
 * from every scripts/data/memory-labels-*.jsonl (`pnpm label`), joined by memory id — a later
 * file / later line wins for a re-labelled id.
 *
 * Against prod: run with DATABASE_URL pointed at prod (it only reads). `.env` is loaded only if it
 * exists (--env-file-if-exists), so on the prod box — native, no .env, NUXT_DATABASE_URL in the
 * service env — `NUXT_DATABASE_URL=… pnpm memory:export` works; the process env always wins.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { parseLabels } from './lib/labelling'
import { mergeLabels, toExportRow, toCsv, toJsonl, type MemoryScoreRow } from './lib/memory-export'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = resolve(HERE, 'data')

const QUERY = `
  select id, content, scope, project, created_at, confidence, extract_prompt_version,
         audit_keep, audit_verdict, audit_reason, audit_model, audit_prompt_version, audited_at,
         audit_failures, jev_score, jev_answers, jev_model, jev_scored_at, jev_failures,
         archived_at, reviewed_at
    from memories
   order by created_at asc, id asc`

async function main() {
  const url = process.env.DATABASE_URL ?? process.env.NUXT_DATABASE_URL
  if (!url) throw new Error('DATABASE_URL (or NUXT_DATABASE_URL) is not set — `pnpm memory:export` loads .env when present')

  mkdirSync(DATA, { recursive: true })
  const labelFiles = readdirSync(DATA).filter(f => /^memory-labels-.*\.jsonl$/.test(f)).sort()
  const labels = mergeLabels(labelFiles.map(f => parseLabels(readFileSync(resolve(DATA, f), 'utf8'))))

  const client = new pg.Client({ connectionString: url })
  await client.connect()
  let memories: MemoryScoreRow[]
  try {
    await client.query('begin read only')
    memories = (await client.query<MemoryScoreRow>(QUERY)).rows
    await client.query('commit')
  } finally {
    await client.end()
  }

  const rows = memories.map(m => toExportRow(m, labels))
  const date = new Date().toISOString().slice(0, 10)
  const csvPath = resolve(DATA, `memory-scores-${date}.csv`)
  const jsonlPath = resolve(DATA, `memory-scores-${date}.jsonl`)
  writeFileSync(csvPath, toCsv(rows))
  writeFileSync(jsonlPath, toJsonl(rows))

  const live = rows.filter(r => !r.archived)
  const count = (p: (r: typeof rows[number]) => boolean) => live.filter(p).length
  console.log(`memories exported : ${rows.length} (${live.length} live, ${rows.length - live.length} archived)`)
  console.log(`live with audit   : ${count(r => r.audit_keep != null)}`)
  console.log(`live with Jev     : ${count(r => r.jev_keep != null)}`)
  console.log(`live with both    : ${count(r => r.disagreement != null)}  (disagree >= 0.4: ${count(r => r.disagreement != null && r.disagreement >= 0.4)})`)
  console.log(`labels joined     : ${rows.filter(r => r.label_verdict != null).length} of ${labels.size} labelled ids (files: ${labelFiles.join(', ') || 'none'})`)
  console.log(`wrote ${csvPath}`)
  console.log(`wrote ${jsonlPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
