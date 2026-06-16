// One-time, idempotent, re-runnable import of bridget raw sessions into MyMind.
// Imports sessions/messages/tool_events ONLY (no memories, no embeddings).
// Run: node --import tsx --env-file=.env scripts/migrate-bridget-sessions.ts [--dry-run] [--source=claude_code] [--limit=N] [--include-empty]
// By default skips message_count=0 sessions (live-event-only, no transcript ever shipped).
import { Client } from 'pg'
import { mapSession, mapMessage, mapToolEvent } from '../server/lib/migrate/bridget-map'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const source = (args.find(a => a.startsWith('--source='))?.split('=')[1]) ?? 'claude_code'
const limit = Number(args.find(a => a.startsWith('--limit='))?.split('=')[1]) || null
const includeEmpty = args.includes('--include-empty')
const projects = (args.find(a => a.startsWith('--projects='))?.split('=')[1]?.split(',').map(s => s.trim()).filter(Boolean)) ?? null

if (!process.env.BRIDGET_DATABASE_URL) throw new Error('set BRIDGET_DATABASE_URL (read-only) in .env')
if (!process.env.DATABASE_URL) throw new Error('set DATABASE_URL (MyMind) in .env')

// Bridget's session data lives in the `bridget` database. If the URL points at
// the default `postgres` db (or omits the db), retarget it to `/bridget`.
function bridgetConn(): string {
  const raw = process.env.BRIDGET_DATABASE_URL as string
  try {
    const u = new URL(raw)
    if (u.pathname === '' || u.pathname === '/' || u.pathname === '/postgres') u.pathname = '/bridget'
    return u.toString()
  } catch { return raw }
}

const src = new Client({ connectionString: bridgetConn() })
const dst = new Client({ connectionString: process.env.DATABASE_URL })
await src.connect()
await dst.connect()
const srcDb = (await src.query('select current_database() d')).rows[0].d
console.log(`bridget import — source=${source} dryRun=${dryRun} limit=${limit ?? 'none'} includeEmpty=${includeEmpty} projects=${projects?.join('|') ?? 'all'} srcDb=${srcDb}`)

// Preflight: fail loudly if we're not actually looking at the bridget schema.
const pre = await src.query(`select to_regclass('public.sess_sessions') as t`)
if (!pre.rows[0].t) throw new Error(`sess_sessions not found in db '${srcDb}' — point BRIDGET_DATABASE_URL at the bridget database (path /bridget)`)

// jsonb columns come back from pg as PARSED JS values; re-inserting a primitive
// (e.g. the string "file1.txt") into a jsonb column fails the text→jsonb cast.
// Stringify so Postgres always receives valid JSON text (null stays SQL NULL).
const jb = (v: unknown) => v == null ? null : JSON.stringify(v)

const sessionsSql = `select id, source, external_id, project, host, machine_id, cwd,
  git_branch, git_commit, git_remote, app_version, title, summary,
  started_at, last_active, ended_at, message_count, tool_count, metadata
  from sess_sessions where source = $1 ${includeEmpty ? '' : 'and message_count > 0'}
  ${projects ? 'and project = any($2)' : ''}
  order by last_active asc nulls first, external_id asc ${limit ? 'limit ' + limit : ''}`
const { rows: bSessions } = await src.query(sessionsSql, projects ? [source, projects] : [source])
console.log(`found ${bSessions.length} bridget sessions`)

let nSess = 0, nMsg = 0, nTool = 0
for (const bs of bSessions) {
  const ms = mapSession(bs)
  if (dryRun) { nSess++; continue }

  const sUp = await dst.query<{ id: string }>(
    `insert into sessions (source, external_id, project, cwd, machine_id, hostname,
        git_branch, git_commit, git_remote, app_version, title, summary,
        started_at, last_active, ended_at, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     on conflict (source, external_id) do update set
        project = excluded.project, cwd = excluded.cwd, machine_id = excluded.machine_id,
        git_branch = excluded.git_branch, git_commit = excluded.git_commit, git_remote = excluded.git_remote,
        app_version = excluded.app_version, title = coalesce(nullif(excluded.title,''), sessions.title),
        summary = coalesce(excluded.summary, sessions.summary), ended_at = excluded.ended_at,
        last_active = excluded.last_active
     returning id`,
    [ms.source, ms.externalId, ms.project, ms.cwd, ms.machineId, ms.hostname, ms.gitBranch,
     ms.gitCommit, ms.gitRemote, ms.appVersion, ms.title, ms.summary, ms.startedAt ?? new Date(),
     ms.lastActive ?? new Date(), ms.endedAt, jb(ms.metadata)])
  const mid = sUp.rows[0]!.id

  const { rows: bMsgs } = await src.query(
    `select id, role, content, external_uuid, parent_uuid, thinking, model, request_id,
       stop_reason, is_sidechain, usage, created_at, metadata
     from msg_messages where session_id = $1 order by created_at asc`, [bs.id])
  for (const bm of bMsgs) {
    const mm = mapMessage(bm)
    await dst.query(
      `insert into messages (session_id, role, content, external_uuid, parent_uuid, thinking,
          model, stop_reason, request_id, is_sidechain, usage, created_at, metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (session_id, external_uuid) do nothing`,
      [mid, mm.role, mm.content, mm.externalUuid, mm.parentUuid, mm.thinking, mm.model,
       mm.stopReason, mm.requestId, mm.isSidechain, jb(mm.usage), mm.createdAt ?? new Date(), jb(mm.metadata)])
    nMsg++
  }

  const { rows: mMsgs } = await dst.query<{ id: string, external_uuid: string | null }>(
    `select id, external_uuid from messages where session_id = $1`, [mid])
  const midByUuid = new Map(mMsgs.map(r => [r.external_uuid, r.id]))
  const uuidByBId = new Map(bMsgs.map((r: any) => [r.id, r.external_uuid]))

  const { rows: bTools } = await src.query(
    `select message_id, tool_name, args, result, exit_status, phase, tool_use_id,
       is_sidechain, caller_type, created_at
     from tool_events where session_id = $1`, [bs.id])
  for (const bt of bTools) {
    const mt = mapToolEvent(bt)
    const msgUuid = bt.message_id ? uuidByBId.get(bt.message_id) : null
    const messageId = msgUuid ? midByUuid.get(msgUuid) ?? null : null
    await dst.query(
      `insert into tool_events (session_id, message_id, tool_name, args, result, exit_status,
          phase, tool_use_id, is_sidechain, caller_type, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (session_id, tool_use_id) do nothing`,
      [mid, messageId, mt.toolName, jb(mt.args), jb(mt.result), mt.exitStatus, mt.phase,
       mt.toolUseId, mt.isSidechain, mt.callerType, mt.createdAt ?? new Date()])
    nTool++
  }

  await dst.query(
    `update sessions s set
       message_count = (select count(*) from messages where session_id = s.id),
       tool_count = (select count(*) from tool_events where session_id = s.id),
       input_tokens = (select coalesce(sum( coalesce((usage->>'input_tokens')::int,0)
         + coalesce((usage->>'cache_creation_input_tokens')::int,0) ),0) from messages where session_id = s.id),
       output_tokens = (select coalesce(sum( coalesce((usage->>'output_tokens')::int,0) ),0) from messages where session_id = s.id),
       started_at = coalesce((select min(created_at) from messages where session_id = s.id), s.started_at),
       last_active = coalesce((select max(created_at) from messages where session_id = s.id), s.last_active)
     where s.id = $1`, [mid])

  nSess++
  if (nSess % 25 === 0) console.log(`  …${nSess}/${bSessions.length} sessions`)
}

console.log(dryRun
  ? `DRY RUN: would import ${nSess} sessions`
  : `imported ${nSess} sessions, ${nMsg} messages, ${nTool} tool events`)
await src.end(); await dst.end()
