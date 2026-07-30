// Collapse each project's `local_paths` down to entries not already covered by a
// registered `path_prefixes` entry or by a shorter sibling local_path. Fixes the
// `!localPaths.includes(cwd)` append bug (see path-routing.ts `shouldRecordLocalPath`)
// that let a project's local_paths grow unbounded with subfolder paths a prefix
// already covers (Terawulf accumulated ~50 entries this way). Idempotent — a second
// --apply run reports zero changes.
// Run: node_modules/.bin/tsx --env-file=.env scripts/collapse-local-paths.ts [--apply]
import { Client } from 'pg'
import { collapseLocalPaths } from '../server/lib/projects/path-routing'

const APPLY = process.argv.includes('--apply')
if (!process.env.DATABASE_URL) throw new Error('set DATABASE_URL')
const db = new Client({ connectionString: process.env.DATABASE_URL })
await db.connect()

const { rows: projs } = await db.query(
  `select id, slug, local_paths, path_prefixes from projects`)

let changed = 0
for (const p of projs) {
  const before: string[] = p.local_paths ?? []
  const after = collapseLocalPaths(before, p.path_prefixes ?? [])
  if (after.length === before.length) continue
  console.log(`${APPLY ? '' : '[dry] '}${p.slug}: ${before.length} -> ${after.length}`)
  if (APPLY) {
    await db.query(`update projects set local_paths = $2 where id = $1`, [p.id, after])
  }
  changed++
}
console.log(`${APPLY ? 'changed' : '[dry] would change'} ${changed}/${projs.length} projects`)
await db.end()
