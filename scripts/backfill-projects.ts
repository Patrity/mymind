// Idempotent backfill: resolve sessions to canonical project_id, then derive
// memory project_id (scope-based) + source_date from each memory's session.
// Run: node_modules/.bin/tsx --env-file=.env scripts/backfill-projects.ts
import { Client } from 'pg'
import { normalizeGitRemote, repoNameFromKey, nextUniqueSlug } from '../server/lib/projects/git-remote'
import { slugify } from '../shared/utils/slugify'

if (!process.env.DATABASE_URL) throw new Error('set DATABASE_URL')
const db = new Client({ connectionString: process.env.DATABASE_URL })
await db.connect()

const { rows: uncat } = await db.query(`select id from projects where slug='uncategorized' limit 1`)
const uncategorizedId: string = uncat[0].id

const taken = new Set<string>((await db.query(`select slug from projects`)).rows.map(r => r.slug))

async function resolveProject(gitRemote: string | null, cwd: string | null): Promise<string> {
  const key = normalizeGitRemote(gitRemote)
  if (!key) return uncategorizedId
  const hit = await db.query(`select id, local_paths from projects where git_remote_key=$1 limit 1`, [key])
  if (hit.rows[0]) {
    const id = hit.rows[0].id
    if (cwd && !(hit.rows[0].local_paths ?? []).includes(cwd)) {
      await db.query(`update projects set local_paths = array_append(local_paths,$2), last_activity_at=now() where id=$1`, [id, cwd])
    }
    return id
  }
  const slug = nextUniqueSlug(slugify(repoNameFromKey(key)) || 'project', taken)
  taken.add(slug)
  const ins = await db.query(
    `insert into projects (slug,name,git_remote_key,repository_url,local_paths,last_activity_at)
     values ($1,$2,$3,$4,$5,now())
     on conflict (git_remote_key) where git_remote_key is not null do update set last_activity_at=now()
     returning id`,
    [slug, repoNameFromKey(key), key, gitRemote, cwd ? [cwd] : []])
  return ins.rows[0].id
}

const { rows: sessions } = await db.query(`select id, git_remote, cwd, project_id from sessions`)
let sCount = 0
for (const s of sessions) {
  const pid = await resolveProject(s.git_remote, s.cwd)
  const { rows: slugRow } = await db.query(`select slug from projects where id=$1`, [pid])
  await db.query(`update sessions set project_id=$2, project=$3 where id=$1`, [s.id, pid, slugRow[0].slug])
  sCount++
}

const { rows: mems } = await db.query(`select id, scope, session_id from memories`)
let mCount = 0
for (const m of mems) {
  let projectId: string | null = null
  let sourceDate: string | null = null
  if (m.session_id) {
    const { rows } = await db.query(`select project_id, started_at from sessions where id=$1`, [m.session_id])
    if (rows[0]) {
      projectId = m.scope === 'agent' ? rows[0].project_id : null
      sourceDate = rows[0].started_at
    }
  }
  await db.query(`update memories set project_id=$2, source_date=$3 where id=$1`, [m.id, projectId, sourceDate])
  mCount++
}

console.log(`backfill: ${sCount} sessions, ${mCount} memories`)
await db.end()
