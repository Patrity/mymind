// Re-resolve sessions currently in `uncategorized` (or NULL) against EXISTING
// projects only — prefix match, then cwd/git-root label, then git_remote key.
// NEVER creates a project. Cascades agent-scoped memories. Idempotent.
// Run: node_modules/.bin/tsx --env-file=.env scripts/reresolve-uncategorized.ts [--dry-run]
import { Client } from 'pg'
import { normalizeGitRemote } from '../server/lib/projects/git-remote'
import { longestPrefixMatch, basenameOf } from '../server/lib/projects/path-routing'
import { slugify } from '../shared/utils/slugify'

const DRY = process.argv.includes('--dry-run')
if (!process.env.DATABASE_URL) throw new Error('set DATABASE_URL')
const db = new Client({ connectionString: process.env.DATABASE_URL })
await db.connect()

const { rows: projs } = await db.query(
  `select id, slug, name, git_remote_key, path_prefixes, aliases from projects`)
const prefixCands = projs.map(p => ({ id: p.id, slug: p.slug, prefixes: p.path_prefixes ?? [] }))

function matchLabel(label: string | null): { id: string, slug: string } | null {
  if (!label) return null
  const ls = slugify(label)
  const hit = projs.find(p =>
    p.slug === label || p.slug === ls ||
    (p.aliases ?? []).includes(label) || (p.aliases ?? []).includes(ls))
  return hit ? { id: hit.id, slug: hit.slug } : null
}

function resolve(cwd: string | null, gitRemote: string | null): { id: string, slug: string } | null {
  const key = normalizeGitRemote(gitRemote)
  if (key) {
    const hit = projs.find(p => p.git_remote_key === key || (p.aliases ?? []).includes(key))
    if (hit) return { id: hit.id, slug: hit.slug }
  }
  if (cwd) {
    const pfx = longestPrefixMatch(cwd, prefixCands)
    if (pfx) return { id: pfx.id, slug: pfx.slug }
    const byLeaf = matchLabel(basenameOf(cwd))
    if (byLeaf) return byLeaf
  }
  return null
}

const { rows: sess } = await db.query(
  `select id, cwd, git_remote, project from sessions
   where project is null or project = 'uncategorized'`)

let moved = 0
for (const s of sess) {
  const hit = resolve(s.cwd, s.git_remote)
  if (!hit || hit.slug === s.project) continue
  console.log(`${DRY ? '[dry] ' : ''}${s.id}  ${s.project ?? 'NULL'} -> ${hit.slug}   (${s.cwd ?? ''})`)
  if (!DRY) {
    await db.query(`update sessions set project_id=$2, project=$3 where id=$1`, [s.id, hit.id, hit.slug])
    await db.query(
      `update memories set project_id=$2, project=$3 where session_id=$1 and scope='agent'`,
      [s.id, hit.id, hit.slug])
  }
  moved++
}
console.log(`${DRY ? '[dry] would move' : 'moved'} ${moved}/${sess.length} sessions`)
await db.end()
