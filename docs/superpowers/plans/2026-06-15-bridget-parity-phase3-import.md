# Phase 3 — Raw Bridget Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** One-time import of bridget's raw session data (`sess_sessions` / `msg_messages` / `tool_events`) into MyMind's Phase-2 schema, idempotent and re-runnable, so MyMind's local enrichment can regenerate memories over the real history. **No memories or embeddings are copied** — those are regenerated locally (sidesteps bridget's truncated-`content_hash` format).

**Architecture:** A standalone script `scripts/migrate-bridget-sessions.ts` connects to bridget (`BRIDGET_DATABASE_URL`, read-only) and MyMind (`DATABASE_URL`) via two `pg` clients. It walks bridget sessions (default `source='claude_code'`), and per session: upserts the MyMind session, imports its messages (remapping ids), then its tool events (remapping session+message ids), then recomputes MyMind's per-session aggregates. Pure column-mapping logic lives in a unit-tested module.

**Tech Stack:** Node + `tsx`, `pg`, vitest. Run: `node --import tsx --env-file=.env scripts/migrate-bridget-sessions.ts [--dry-run] [--source=claude_code] [--limit=N]` (matches the existing `scripts/migrate-ai-config-litellm.ts` pattern).

**Scope:** Phase 3 of 5 of the cycle-13 bridget-parity spec (Part H). Default import source = **`claude_code`** (Tony's choice; `--source` overrides). Branch `feat/bridget-parity`.

**Source schema (from the cycle-13 audit of `~/Documents/GitHub/bridget-services/db/migrations`):**
- `sess_sessions`: `id, source, external_id, project, host, machine_id, cwd, git_branch, git_commit, git_remote, app_version, title, summary, started_at, last_active, ended_at, message_count, tool_count, metadata` (+ `summary_embedding`, `last_embedded_at`, `jsonl_path`, `user_account` — NOT imported). UNIQUE `(source, external_id)`.
- `msg_messages`: `id, session_id, role, content, external_uuid, parent_uuid, thinking, model, request_id, stop_reason, is_sidechain, usage, created_at, metadata` (+ `token_count`, `embedding` — NOT imported). Partial-unique `(session_id, external_uuid)`.
- `tool_events`: `id, session_id, message_id, tool_name, args, result, exit_status, phase, tool_use_id, is_sidechain, caller_type, created_at` (+ `duration_ms` — NOT imported). Partial-unique `(session_id, tool_use_id)`.

> The script SELECTs explicit columns; if bridget's live schema differs from this map, the query errors loudly (a clear failure beats a silent skip). The implementer verifies column names against the live DB during the dry-run task.

---

## File structure
**Create:** `server/lib/migrate/bridget-map.ts` (pure mappers), `test/bridget-map.test.ts`, `scripts/migrate-bridget-sessions.ts`.

---

## Task 1: Pure column mappers (TDD)

**Files:** Create `server/lib/migrate/bridget-map.ts`, `test/bridget-map.test.ts`.

- [ ] **Step 1: Write the failing test** — `test/bridget-map.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { mapSession, mapMessage, mapToolEvent } from '../server/lib/migrate/bridget-map'

describe('mapSession', () => {
  it('maps columns, prefers machine_id then host, drops embeddings', () => {
    const r = { source: 'claude_code', external_id: 'sess-1', project: 'mymind', host: 'h1',
      machine_id: 'm1', cwd: '/x', git_branch: 'main', git_commit: 'abc', git_remote: 'r',
      app_version: '1.2', title: 'T', summary: 'S', started_at: new Date('2026-01-01'),
      last_active: new Date('2026-01-02'), ended_at: null, message_count: 5, tool_count: 2, metadata: { a: 1 } }
    const m = mapSession(r)
    expect(m.source).toBe('claude_code')
    expect(m.externalId).toBe('sess-1')
    expect(m.machineId).toBe('m1')        // prefers machine_id
    expect(m.gitBranch).toBe('main')
    expect(m.title).toBe('T')
    expect(m.metadata).toEqual({ a: 1 })
    expect('summary_embedding' in m).toBe(false)
  })
  it('falls back to host when machine_id is null', () => {
    expect(mapSession({ source: 'x', external_id: 'y', machine_id: null, host: 'h9' }).machineId).toBe('h9')
  })
})

describe('mapMessage', () => {
  it('maps rich fields, drops token_count/embedding', () => {
    const r = { role: 'assistant', content: 'hi', external_uuid: 'u1', parent_uuid: 'p1',
      thinking: 'th', model: 'claude-opus-4-8', request_id: 'req', stop_reason: 'end_turn',
      is_sidechain: true, usage: { input_tokens: 1 }, created_at: new Date('2026-01-01'), metadata: {} }
    const m = mapMessage(r)
    expect(m.role).toBe('assistant')
    expect(m.externalUuid).toBe('u1')
    expect(m.thinking).toBe('th')
    expect(m.isSidechain).toBe(true)
    expect(m.usage).toEqual({ input_tokens: 1 })
    expect('token_count' in m).toBe(false)
    expect('embedding' in m).toBe(false)
  })
})

describe('mapToolEvent', () => {
  it('maps fields, drops duration_ms', () => {
    const r = { tool_name: 'Bash', args: { c: 'ls' }, result: 'ok', exit_status: 'ok',
      phase: 'completed', tool_use_id: 'tu1', is_sidechain: false, caller_type: 'direct',
      created_at: new Date('2026-01-01') }
    const m = mapToolEvent(r)
    expect(m.toolName).toBe('Bash')
    expect(m.toolUseId).toBe('tu1')
    expect(m.exitStatus).toBe('ok')
    expect('duration_ms' in m).toBe(false)
  })
})
```

- [ ] **Step 2: Run → fail** — `pnpm test -- bridget-map` (module missing).

- [ ] **Step 3: Implement** — `server/lib/migrate/bridget-map.ts`:

```typescript
// Pure mappers: bridget snake_case rows → MyMind insert-shaped objects.
// Embeddings, token_count, duration_ms are intentionally NOT carried.

export interface MappedSession {
  source: string
  externalId: string
  project: string | null
  cwd: string | null
  machineId: string | null
  hostname: string | null
  gitBranch: string | null
  gitCommit: string | null
  gitRemote: string | null
  appVersion: string | null
  title: string | null
  summary: string | null
  startedAt: Date | null
  lastActive: Date | null
  endedAt: Date | null
  metadata: Record<string, unknown>
}

export interface MappedMessage {
  role: string | null
  content: string
  externalUuid: string | null
  parentUuid: string | null
  thinking: string | null
  model: string | null
  stopReason: string | null
  requestId: string | null
  isSidechain: boolean
  usage: Record<string, unknown> | null
  createdAt: Date | null
  metadata: Record<string, unknown>
}

export interface MappedToolEvent {
  toolName: string
  args: unknown
  result: unknown
  exitStatus: string | null
  phase: string
  toolUseId: string | null
  isSidechain: boolean
  callerType: string | null
  createdAt: Date | null
}

export function mapSession(r: Record<string, any>): MappedSession {
  return {
    source: r.source,
    externalId: r.external_id,
    project: r.project ?? null,
    cwd: r.cwd ?? null,
    machineId: r.machine_id ?? r.host ?? null,
    hostname: r.hostname ?? null,
    gitBranch: r.git_branch ?? null,
    gitCommit: r.git_commit ?? null,
    gitRemote: r.git_remote ?? null,
    appVersion: r.app_version ?? null,
    title: r.title ?? null,
    summary: r.summary ?? null,
    startedAt: r.started_at ?? null,
    lastActive: r.last_active ?? null,
    endedAt: r.ended_at ?? null,
    metadata: (r.metadata && typeof r.metadata === 'object') ? r.metadata : {}
  }
}

export function mapMessage(r: Record<string, any>): MappedMessage {
  return {
    role: r.role ?? null,
    content: r.content ?? '',
    externalUuid: r.external_uuid ?? null,
    parentUuid: r.parent_uuid ?? null,
    thinking: r.thinking ?? null,
    model: r.model ?? null,
    stopReason: r.stop_reason ?? null,
    requestId: r.request_id ?? null,
    isSidechain: r.is_sidechain === true,
    usage: (r.usage && typeof r.usage === 'object') ? r.usage : null,
    createdAt: r.created_at ?? null,
    metadata: (r.metadata && typeof r.metadata === 'object') ? r.metadata : {}
  }
}

export function mapToolEvent(r: Record<string, any>): MappedToolEvent {
  return {
    toolName: r.tool_name ?? 'unknown',
    args: r.args ?? null,
    result: r.result ?? null,
    exitStatus: r.exit_status ?? null,
    phase: r.phase ?? 'completed',
    toolUseId: r.tool_use_id ?? null,
    isSidechain: r.is_sidechain === true,
    callerType: r.caller_type ?? null,
    createdAt: r.created_at ?? null
  }
}
```

- [ ] **Step 4: Run → pass + typecheck** — `pnpm test -- bridget-map` (PASS), `pnpm typecheck` (0).

- [ ] **Step 5: Commit**
```bash
git add server/lib/migrate/bridget-map.ts test/bridget-map.test.ts
git commit -m "feat(migrate): pure bridget→mymind row mappers"
```

---

## Task 2: The migration script

**Files:** Create `scripts/migrate-bridget-sessions.ts`.

- [ ] **Step 1: Write the script** — `scripts/migrate-bridget-sessions.ts`:

```typescript
// One-time, idempotent, re-runnable import of bridget raw sessions into MyMind.
// Imports sessions/messages/tool_events ONLY (no memories, no embeddings).
// Run: node --import tsx --env-file=.env scripts/migrate-bridget-sessions.ts [--dry-run] [--source=claude_code] [--limit=N]
import { Client } from 'pg'
import { mapSession, mapMessage, mapToolEvent } from '../server/lib/migrate/bridget-map'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const source = (args.find(a => a.startsWith('--source='))?.split('=')[1]) ?? 'claude_code'
const limit = Number(args.find(a => a.startsWith('--limit='))?.split('=')[1]) || null

if (!process.env.BRIDGET_DATABASE_URL) throw new Error('set BRIDGET_DATABASE_URL (read-only) in .env')
if (!process.env.DATABASE_URL) throw new Error('set DATABASE_URL (MyMind) in .env')

const src = new Client({ connectionString: process.env.BRIDGET_DATABASE_URL })
const dst = new Client({ connectionString: process.env.DATABASE_URL })
await src.connect()
await dst.connect()
console.log(`bridget import — source=${source} dryRun=${dryRun} limit=${limit ?? 'none'}`)

// jsonb columns come back from pg as PARSED JS values; re-inserting a primitive
// (e.g. the string "file1.txt") into a jsonb column fails the text→jsonb cast.
// Stringify so Postgres always receives valid JSON text (null stays SQL NULL).
const jb = (v: unknown) => v == null ? null : JSON.stringify(v)

const sessionsSql = `select id, source, external_id, project, host, machine_id, cwd,
  git_branch, git_commit, git_remote, app_version, title, summary,
  started_at, last_active, ended_at, message_count, tool_count, metadata
  from sess_sessions where source = $1 order by last_active asc nulls first ${limit ? 'limit ' + limit : ''}`
const { rows: bSessions } = await src.query(sessionsSql, [source])
console.log(`found ${bSessions.length} bridget sessions`)

let nSess = 0, nMsg = 0, nTool = 0
for (const bs of bSessions) {
  const ms = mapSession(bs)
  if (dryRun) { nSess++; continue }

  // 1. Upsert session, get MyMind id
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

  // 2. Import messages
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

  // 3. Build externalUuid -> MyMind message id, and bridget msg id -> externalUuid
  const { rows: mMsgs } = await dst.query<{ id: string, external_uuid: string | null }>(
    `select id, external_uuid from messages where session_id = $1`, [mid])
  const midByUuid = new Map(mMsgs.map(r => [r.external_uuid, r.id]))
  const uuidByBId = new Map(bMsgs.map((r: any) => [r.id, r.external_uuid]))

  // 4. Import tool events (remap session + message ids)
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

  // 5. Recompute MyMind aggregates from the imported rows
  await dst.query(
    `update sessions s set
       message_count = (select count(*) from messages where session_id = s.id),
       tool_count = (select count(*) from tool_events where session_id = s.id),
       input_tokens = (select coalesce(sum( coalesce((usage->>'input_tokens')::int,0)
         + coalesce((usage->>'cache_read_input_tokens')::int,0)
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
```

- [ ] **Step 2: Typecheck** — `pnpm typecheck` → 0 errors. (The script is ESM top-level-await like `scripts/migrate-ai-config-litellm.ts`; confirm it typechecks under the project config.)

- [ ] **Step 3: Commit**
```bash
git add scripts/migrate-bridget-sessions.ts
git commit -m "feat(migrate): one-time bridget raw session import script"
```

---

## Task 3: Connectivity + dry-run (needs `BRIDGET_DATABASE_URL`)

**Files:** none. **Requires** `BRIDGET_DATABASE_URL` set in `.env` and bridget reachable.

- [ ] **Step 1: Connectivity** — confirm both DBs reachable and the source columns exist:
```bash
node --import tsx --env-file=.env -e "import('pg').then(async ({default:{Client}})=>{const c=new Client({connectionString:process.env.BRIDGET_DATABASE_URL});await c.connect();const {rows}=await c.query(\"select count(*)::int n from sess_sessions where source='claude_code'\");console.log('bridget claude_code sessions:',rows[0].n);await c.end();})"
```
Expected: a non-zero count (no connection/column error).

- [ ] **Step 2: Dry-run** — `node --import tsx --env-file=.env scripts/migrate-bridget-sessions.ts --dry-run`
Expected: `DRY RUN: would import N sessions` with N matching Step 1's count. Any SQL/column error here means bridget's live schema differs from the map — fix the SELECT column list in the script to match the live columns and re-run.

---

## Task 4: Real import + verify + enrich

**Files:** none. **Requires** Task 3 green.

- [ ] **Step 1: Import a small slice first** — `node --import tsx --env-file=.env scripts/migrate-bridget-sessions.ts --limit=5`
Verify in MyMind: `GET /api/sessions?source=claude_code` shows the 5; open one in `/sessions/{id}` → real transcript with thinking + tool events + git/machine.

- [ ] **Step 2: Idempotency** — re-run `--limit=5` → message/tool counts do NOT grow (unique constraints hold).

- [ ] **Step 3: Full import** — `node --import tsx --env-file=.env scripts/migrate-bridget-sessions.ts`
Confirm the printed totals; spot-check session count via `GET /api/sessions`.

- [ ] **Step 4: Re-enrich locally** — the `enrich-memories` task (`*/15`) now has real sessions to chew; trigger it manually (`POST /api/admin/memory-enrich-run` if present, else wait for the schedule) and confirm memories are generated (`GET /api/memories`), reviewable at `/review`. (Phase 5 will improve the enrichment intelligence; this just proves the imported data feeds it.)

---

## Done criteria
- `scripts/migrate-bridget-sessions.ts` imports bridget `claude_code` sessions/messages/tool_events idempotently; no memories/embeddings copied.
- Imported sessions render in MyMind with full transcript + tool events + git/machine.
- Re-run is a no-op; aggregates correct.
- Local enrichment produces memories from the imported sessions.
- **Next:** Phase 4 (summaries + session/message search).
