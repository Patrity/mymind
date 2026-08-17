/**
 * One-off backfill for task f80622b9: fuse memories the enrichment resolver should have
 * merged but didn't.
 *
 * Until 2026-08-17 the enrichment path (`memory-resolve.insertFresh`) had no similarity
 * floor — after the exact-hash check, whether a near-duplicate merged was entirely
 * `judgeRelations`' opinion, and it let near-verbatim restatements through. The resolver
 * now short-circuits at `memoryDuplicateThreshold` (0.96), which stops NEW duplicates.
 * This cleans up the ones already stored.
 *
 * Pairs are matched within the SAME (scope, project) partition only — the same partition
 * the resolver itself compares within, so this never fuses across a boundary the live code
 * would have respected.
 *
 * For each pair the OLDER row wins: it keeps its id (so `memory_relations`, session links
 * and any external reference stay valid) and absorbs the newer row's evidence. The newer
 * row is ARCHIVED, never deleted — reversible, and consistent with how the app retires a
 * memory everywhere else.
 *
 * DRY RUN BY DEFAULT. Pass --apply to write.
 *
 *   pnpm tsx scripts/dedupe-memories.ts            # report only
 *   pnpm tsx scripts/dedupe-memories.ts --apply    # actually merge
 *   pnpm tsx scripts/dedupe-memories.ts --bar 0.95 # override the bar
 */
import pg from 'pg'

const APPLY = process.argv.includes('--apply')
const barIdx = process.argv.indexOf('--bar')
const BAR = barIdx > -1 ? Number(process.argv[barIdx + 1]) : 0.96

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required')

const client = new pg.Client({ connectionString: url })
await client.connect()

// Nearest-neighbour pairs inside one (scope, project) partition, above the bar.
// `a` is always the older row (a.created_at <= b.created_at), so the winner is deterministic.
const { rows } = await client.query<{
  keep: string, drop: string, sim: string, keep_content: string, drop_content: string
}>(`
  select a.id as keep, b.id as drop,
         round((1 - (a.embedding <=> b.embedding))::numeric, 4) as sim,
         left(a.content, 90) as keep_content, left(b.content, 90) as drop_content
  from memories a
  join memories b
    on a.scope = b.scope
   and a.project is not distinct from b.project
   and (a.created_at, a.id) < (b.created_at, b.id)
  where a.archived_at is null and b.archived_at is null
    and a.embedding is not null and b.embedding is not null
    and 1 - (a.embedding <=> b.embedding) >= $1
  order by 3 desc
`, [BAR])

console.log(`bar=${BAR}  mode=${APPLY ? 'APPLY' : 'DRY RUN'}  candidate pairs=${rows.length}\n`)

// A row can appear as `drop` in one pair and `keep` in another. Archive each row at most
// once, and never archive a row that has already been chosen as a keeper — otherwise a
// chain of three near-identical memories could archive all of them.
const archived = new Set<string>()
const keepers = new Set<string>()
let merged = 0

for (const r of rows) {
  if (archived.has(r.keep) || archived.has(r.drop)) continue
  if (keepers.has(r.drop)) continue
  keepers.add(r.keep)

  console.log(`${r.sim}  keep ${r.keep.slice(0, 8)}  drop ${r.drop.slice(0, 8)}`)
  console.log(`      keep: ${r.keep_content}`)
  console.log(`      drop: ${r.drop_content}`)

  if (APPLY) {
    await client.query('begin')
    try {
      // Move the loser's evidence onto the winner so provenance survives the merge.
      await client.query(
        `update memories set evidence = coalesce(evidence, '[]'::jsonb) || coalesce(
           (select evidence from memories where id = $2), '[]'::jsonb),
         updated_at = now() where id = $1`, [r.keep, r.drop])
      await client.query(
        `update memories set archived_at = now(), superseded_by = $1, updated_at = now()
         where id = $2 and archived_at is null`, [r.keep, r.drop])
      await client.query('commit')
    } catch (e) {
      await client.query('rollback')
      throw e
    }
  }
  archived.add(r.drop)
  merged++
}

console.log(`\n${APPLY ? 'merged' : 'would merge'}: ${merged}`)
if (!APPLY) console.log('re-run with --apply to write')
await client.end()
