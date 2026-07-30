// Collapse each project's `local_paths` down to entries not already covered by a
// registered `path_prefixes` entry or by a shorter sibling local_path. Fixes the
// `!localPaths.includes(cwd)` append bug (see path-routing.ts `shouldRecordLocalPath`)
// that let a project's local_paths grow unbounded with subfolder paths a prefix
// already covers (Terawulf accumulated ~50 entries this way). Idempotent — a second
// --apply run reports zero changes.
//
// ⚠️ THERE IS NO UNDO. `--apply` overwrites `local_paths` in place and the dropped
// entries are gone. Snapshot first:
//   \copy (select id, slug, local_paths from projects) to '/tmp/local_paths.bak.csv' csv
// Restore by hand from that CSV if a collapse turns out wrong.
//
// Run: node_modules/.bin/tsx --env-file=.env scripts/collapse-local-paths.ts [--apply] [--project <slug>]
//   (no flags)          dry run over every project — prints every path it would drop
//   --project terawulf  restrict to one project (inspect or apply in isolation)
//   --apply             actually write; run the dry run FIRST and read the drop list
import { Client } from 'pg'
import { collapseLocalPaths, normalizePrefix } from '../server/lib/projects/path-routing'

const APPLY = process.argv.includes('--apply')
const projectIdx = process.argv.indexOf('--project')
const ONLY_PROJECT = projectIdx === -1 ? null : process.argv[projectIdx + 1]
if (projectIdx !== -1 && !ONLY_PROJECT) throw new Error('--project needs a slug, e.g. --project terawulf')
if (!process.env.DATABASE_URL) throw new Error('set DATABASE_URL')
const db = new Client({ connectionString: process.env.DATABASE_URL })
await db.connect()

const { rows: projs } = ONLY_PROJECT
  ? await db.query(`select id, slug, local_paths, path_prefixes from projects where slug = $1`, [ONLY_PROJECT])
  : await db.query(`select id, slug, local_paths, path_prefixes from projects`)
if (ONLY_PROJECT && !projs.length) throw new Error(`no project with slug '${ONLY_PROJECT}'`)

// High enough that a realistic prod run (Terawulf: ~50 redundant entries) prints its FULL
// drop list — the handover asks the operator to review those paths before --apply, which a
// truncated listing makes impossible.
const MAX_LISTED = 200

let changed = 0
for (const p of projs) {
  const before: string[] = p.local_paths ?? []
  const after = collapseLocalPaths(before, p.path_prefixes ?? [])
  // Compare by value, not length — a purely-normalizing change (e.g. a stray
  // trailing slash) can leave the array the same length but a different value,
  // and would otherwise be silently skipped forever.
  if (JSON.stringify(before) === JSON.stringify(after)) continue

  console.log(`${APPLY ? '' : '[dry] '}${p.slug}: ${before.length} -> ${after.length}`)
  // Dropped = normalized entries that were actually pruned (covered by a prefix or a
  // shorter sibling), as opposed to entries merely re-spelled by normalization (e.g. a
  // stray trailing slash) — those still survive under their normalized form in `after`.
  const afterSet = new Set(after)
  const dropped = [...new Set(before.map(normalizePrefix))].filter(x => !afterSet.has(x))
  for (const d of dropped.slice(0, MAX_LISTED)) console.log(`    - ${d}`)
  if (dropped.length > MAX_LISTED) console.log(`    … and ${dropped.length - MAX_LISTED} more`)

  if (APPLY) {
    await db.query(`update projects set local_paths = $2 where id = $1`, [p.id, after])
  }
  changed++
}
const scope = ONLY_PROJECT ? ` (--project ${ONLY_PROJECT})` : ''
console.log(`${APPLY ? 'changed' : '[dry] would change'} ${changed}/${projs.length} projects${scope}`)
await db.end()
