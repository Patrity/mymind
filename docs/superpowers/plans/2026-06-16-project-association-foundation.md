# Project-Association Foundation (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give MyMind a canonical `projects` entity keyed on the git remote, resolve every session (and enriched memory) to a real project id, and stamp memories with the date the work happened — so the upcoming bulk enrich run buckets correctly.

**Architecture:** A pure `normalizeGitRemote` + helpers (unit-tested), a thin DB-orchestrating `findOrCreateProject` in the existing `server/services/projects.ts`, called from session ingest; memory enrichment sets `project_id` (by scope) + `source_date`. A migration adds `projects.id` (uuid PK) + richer columns + `session.project_id` + `memories.project_id`/`source_date`. A backfill script repopulates existing rows.

**Tech Stack:** Nuxt 4 / Nitro, Drizzle ORM + Postgres 16 (`gen_random_uuid()` built-in), Vitest (pure-function tests only — no DB harness in this repo).

**Spec:** `docs/superpowers/specs/2026-06-16-project-association-foundation-design.md`

**Deviation from spec (approved-pending):** spec said replace `projects.active` with `archived_at`. Discovered the existing projects CRUD + `/projects` UI (active toggle) depend on `active`. To avoid tangential UI churn we **keep `active`** and run the enrichment selector off the `project_id` join. Everything else follows the spec.

**Conventions (from CLAUDE.md + memories):**
- Gates: `pnpm typecheck` (0 errors), `pnpm test`, `pnpm build`. Lint is red repo-wide — NOT a gate.
- Migrations: `pnpm db:generate` then **hand-append** raw SQL drizzle-kit can't emit (partial-unique, GIN, the PK swap, the seed). Then `pnpm db:migrate` (local).
- Run TS scripts with `node_modules/.bin/tsx --env-file=.env scripts/...` (NOT `node --import tsx`).
- Live data: every successful mutation in a service/handler calls `publishChange({resource,action,id})`. (Existing project CRUD does not emit; we are not changing that here.)

---

## File Structure

- **Create** `server/lib/projects/git-remote.ts` — pure: `normalizeGitRemote`, `repoNameFromKey`, `nextUniqueSlug`.
- **Create** `test/git-remote.test.ts` — unit tests for the above.
- **Create** `server/lib/projects/memory-project.ts` — pure: `projectIdForScope(scope, sessionProjectId)`.
- **Create** `test/memory-project.test.ts` — unit tests for the above.
- **Modify** `server/db/schema/projects.ts` — add `id` PK + new columns (keep `active`).
- **Modify** `server/db/schema/sessions.ts` — add `projectId`.
- **Modify** `server/db/schema/memories.ts` — add `projectId`, `sourceDate`.
- **Create** `server/db/migrations/0019_*.sql` — generated + hand-appended.
- **Modify** `server/services/projects.ts` — add `findOrCreateProject` (existing CRUD untouched).
- **Modify** `server/services/sessions.ts` — `upsertSession` resolves `projectId`.
- **Modify** `server/services/memory-resolve.ts` — thread `projectId`/`sourceDate`; bucket by `projectId`.
- **Modify** `server/services/memory-enrich.ts` — pass `projectId`/`sourceDate`/`sessionDate`; selector by `project_id`+`active`.
- **Create** `scripts/backfill-projects.ts` — backfill sessions + memories.
- **Create** `docs/wiki/projects.md`; **Modify** `docs/wiki/memory.md`, `docs/wiki/sessions.md`.

---

## Task 1: Pure git-remote helpers (TDD)

**Files:**
- Create: `server/lib/projects/git-remote.ts`
- Test: `test/git-remote.test.ts`

- [ ] **Step 1: Write the failing test**

`test/git-remote.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { normalizeGitRemote, repoNameFromKey, nextUniqueSlug } from '../server/lib/projects/git-remote'

describe('normalizeGitRemote', () => {
  it('normalizes scp, https, creds, ssh+port, .git, case', () => {
    expect(normalizeGitRemote('git@github.com:Patrity/mymind.git')).toBe('github.com/patrity/mymind')
    expect(normalizeGitRemote('https://github.com/Patrity/mymind.git')).toBe('github.com/patrity/mymind')
    expect(normalizeGitRemote('https://x-access-token:TOK@github.com/Patrity/mymind')).toBe('github.com/patrity/mymind')
    expect(normalizeGitRemote('ssh://git@git.costanzoclan.com:2222/tony/foo.git')).toBe('git.costanzoclan.com/tony/foo')
    expect(normalizeGitRemote('https://github.com/Patrity/mymind/')).toBe('github.com/patrity/mymind')
  })
  it('returns null for empty / unparseable', () => {
    expect(normalizeGitRemote('')).toBeNull()
    expect(normalizeGitRemote(null)).toBeNull()
    expect(normalizeGitRemote(undefined)).toBeNull()
    expect(normalizeGitRemote('not-a-remote')).toBeNull()
  })
})

describe('repoNameFromKey', () => {
  it('takes the last path segment', () => {
    expect(repoNameFromKey('github.com/patrity/mymind')).toBe('mymind')
  })
})

describe('nextUniqueSlug', () => {
  it('returns base when free, else suffixes', () => {
    expect(nextUniqueSlug('mymind', new Set())).toBe('mymind')
    expect(nextUniqueSlug('mymind', new Set(['mymind']))).toBe('mymind-2')
    expect(nextUniqueSlug('mymind', new Set(['mymind', 'mymind-2']))).toBe('mymind-3')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node_modules/.bin/vitest run test/git-remote.test.ts`
Expected: FAIL — module `server/lib/projects/git-remote` not found.

- [ ] **Step 3: Implement**

`server/lib/projects/git-remote.ts`:
```ts
/**
 * Normalize a git remote URL to a canonical match key `host/owner/repo`
 * (lowercased, no scheme/credentials/port/.git). Returns null when there is no
 * parseable host+path. Pure.
 */
export function normalizeGitRemote(remote: string | null | undefined): string | null {
  if (!remote) return null
  let s = remote.trim()
  if (!s) return null
  let host: string, path: string
  if (/:\/\//.test(s)) {
    // scheme URL: https:// ssh:// git://
    s = s.replace(/^[a-z]+:\/\//i, '').replace(/^[^@/]+@/, '') // strip scheme + credentials
    const slash = s.indexOf('/')
    if (slash < 0) return null
    host = s.slice(0, slash); path = s.slice(slash + 1)
  } else {
    const scp = s.match(/^[^@]+@([^:]+):(.+)$/) // git@host:owner/repo(.git)
    if (scp) { host = scp[1]!; path = scp[2]! }
    else {
      const slash = s.indexOf('/')
      if (slash < 0) return null
      host = s.slice(0, slash); path = s.slice(slash + 1)
    }
  }
  host = host.split(':')[0]! // strip port
  path = path.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
  if (!host || !path) return null
  return `${host}/${path}`.toLowerCase()
}

/** Repo name = last path segment of a git_remote_key. Pure. */
export function repoNameFromKey(key: string): string {
  const seg = key.split('/').filter(Boolean)
  return seg[seg.length - 1] ?? key
}

/** First free slug in base, base-2, base-3, … given the taken set. Pure. */
export function nextUniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node_modules/.bin/vitest run test/git-remote.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add server/lib/projects/git-remote.ts test/git-remote.test.ts
git commit -m "feat(projects): pure git-remote normalization + slug helpers"
```

---

## Task 2: Pure scope→project helper (TDD)

**Files:**
- Create: `server/lib/projects/memory-project.ts`
- Test: `test/memory-project.test.ts`

(The "last observed = max" source-date semantics are done in-DB via SQL `greatest()` in Task 6 — null-safe in Postgres — so no JS helper is needed for it.)

- [ ] **Step 1: Write the failing test**

`test/memory-project.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { projectIdForScope } from '../server/lib/projects/memory-project'

describe('projectIdForScope', () => {
  it('agent scope inherits the session project; user/world are global (null)', () => {
    expect(projectIdForScope('agent', 'p1')).toBe('p1')
    expect(projectIdForScope('user', 'p1')).toBeNull()
    expect(projectIdForScope('world', 'p1')).toBeNull()
    expect(projectIdForScope('agent', null)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node_modules/.bin/vitest run test/memory-project.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/lib/projects/memory-project.ts`:
```ts
import type { MemoryScope } from '../../../shared/types/memory'

/** Agent-scope memories inherit the session's project; user/world are global. Pure. */
export function projectIdForScope(scope: MemoryScope, sessionProjectId: string | null): string | null {
  return scope === 'agent' ? (sessionProjectId ?? null) : null
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node_modules/.bin/vitest run test/memory-project.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/projects/memory-project.ts test/memory-project.test.ts
git commit -m "feat(projects): pure scope->project helper"
```

---

## Task 3: Schema + migration

**Files:**
- Modify: `server/db/schema/projects.ts`
- Modify: `server/db/schema/sessions.ts`
- Modify: `server/db/schema/memories.ts`
- Create: `server/db/migrations/0019_*.sql` (generated then hand-edited)

- [ ] **Step 1: Update `server/db/schema/projects.ts`**

Replace the file with (adds `id` PK + columns; **keeps `active`**):
```ts
import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, boolean, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  active: boolean('active').notNull().default(true),
  gitRemoteKey: text('git_remote_key'),
  repositoryUrl: text('repository_url'),
  productionUrl: text('production_url'),
  stagingUrl: text('staging_url'),
  aliases: text('aliases').array().notNull().default(sql`'{}'::text[]`),
  localPaths: text('local_paths').array().notNull().default(sql`'{}'::text[]`),
  details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  uniqueIndex('projects_slug_uidx').on(t.slug),
  index('projects_git_remote_key_idx').on(t.gitRemoteKey)
])

export type Project = typeof projects.$inferSelect
```

- [ ] **Step 2: Update `server/db/schema/sessions.ts`** — add the column after `project`:
```ts
  project: text('project'),
  projectId: uuid('project_id'),
```
and add to the index array:
```ts
  index('sessions_project_id_idx').on(t.projectId)
```

- [ ] **Step 3: Update `server/db/schema/memories.ts`** — add after `project`:
```ts
  project: text('project'),
  projectId: uuid('project_id'),
  sourceDate: timestamp('source_date', { withTimezone: true }),
```
and add to the index array:
```ts
  index('memories_project_id_idx').on(t.projectId)
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `server/db/migrations/0019_*.sql` is created. drizzle-kit will likely mishandle the projects PK swap (slug→id) — **do not trust it for that part**.

- [ ] **Step 5: Hand-write/verify the migration SQL**

Open the generated `0019_*.sql` and ensure it reads exactly like this (replace the projects section entirely; keep whatever drizzle emitted for sessions/memories columns if correct). First confirm the existing PK constraint name with `psql "$DATABASE_URL" -c '\d projects'` (drizzle default is `projects_pkey`):
```sql
-- projects: add surrogate id PK (slug stays unique), richer columns
ALTER TABLE "projects" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;
ALTER TABLE "projects" DROP CONSTRAINT "projects_pkey";
ALTER TABLE "projects" ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");
CREATE UNIQUE INDEX "projects_slug_uidx" ON "projects" ("slug");
ALTER TABLE "projects" ADD COLUMN "git_remote_key" text;
ALTER TABLE "projects" ADD COLUMN "repository_url" text;
ALTER TABLE "projects" ADD COLUMN "production_url" text;
ALTER TABLE "projects" ADD COLUMN "staging_url" text;
ALTER TABLE "projects" ADD COLUMN "aliases" text[] DEFAULT '{}'::text[] NOT NULL;
ALTER TABLE "projects" ADD COLUMN "local_paths" text[] DEFAULT '{}'::text[] NOT NULL;
ALTER TABLE "projects" ADD COLUMN "details" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "projects" ADD COLUMN "last_activity_at" timestamptz;

-- match index (partial unique on non-null key) + alias containment
CREATE UNIQUE INDEX "projects_git_remote_key_uidx" ON "projects" ("git_remote_key") WHERE "git_remote_key" IS NOT NULL;
CREATE INDEX "projects_aliases_gin" ON "projects" USING gin ("aliases");

-- seed the Uncategorized bucket
INSERT INTO "projects" ("slug","name") VALUES ('uncategorized','Uncategorized') ON CONFLICT ("slug") DO NOTHING;

-- sessions + memories: project_id (+ memory source_date)
ALTER TABLE "sessions" ADD COLUMN "project_id" uuid REFERENCES "projects"("id");
CREATE INDEX "sessions_project_id_idx" ON "sessions" ("project_id");
ALTER TABLE "memories" ADD COLUMN "project_id" uuid REFERENCES "projects"("id");
ALTER TABLE "memories" ADD COLUMN "source_date" timestamptz;
CREATE INDEX "memories_project_id_idx" ON "memories" ("project_id");
```
Note: the `index('projects_git_remote_key_idx')` from the schema file and the hand-written partial-unique `projects_git_remote_key_uidx` both exist — that's fine (drizzle's plain index is harmless), but you may drop the plain one from the schema if `pnpm db:generate` complains about drift on the next run. Keep the schema's `uniqueIndex('projects_slug_uidx')` aligned with the SQL.

- [ ] **Step 6: Apply + verify**

```bash
pnpm db:migrate
psql "$DATABASE_URL" -c "\d projects" -c "SELECT slug FROM projects WHERE slug='uncategorized';"
```
Expected: `projects` has `id` PK, `git_remote_key`, the partial-unique index, and one `uncategorized` row.

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm typecheck   # expect 0 errors
git add server/db/schema/ server/db/migrations/
git commit -m "feat(projects): migration — uuid id PK, git_remote_key + columns, session/memory project_id, memory source_date"
```

---

## Task 4: `findOrCreateProject` service

**Files:**
- Modify: `server/services/projects.ts` (add the function + imports; leave existing CRUD untouched)

- [ ] **Step 1: Add imports** at the top of `server/services/projects.ts`:
```ts
import { eq, sql } from 'drizzle-orm'
import { normalizeGitRemote, repoNameFromKey, nextUniqueSlug } from '../lib/projects/git-remote'
```
(merge with the existing `import { eq } from 'drizzle-orm'` line — it becomes `import { eq, sql } from 'drizzle-orm'`.)

- [ ] **Step 2: Append the function** to `server/services/projects.ts`:
```ts
/**
 * Resolve a session's project. Matches on the normalized git remote (then aliases),
 * creating a project on first sight; sessions with no remote return the seeded
 * Uncategorized bucket. Race on git_remote_key falls back to re-select.
 */
export async function findOrCreateProject(input: { gitRemote?: string | null, cwd?: string | null }): Promise<typeof projects.$inferSelect> {
  const db = useDb()
  const key = normalizeGitRemote(input.gitRemote)
  const cwd = input.cwd ?? null

  if (!key) {
    const [u] = await db.select().from(projects).where(eq(projects.slug, 'uncategorized')).limit(1)
    return u! // seeded by migration 0019
  }

  let [proj] = await db.select().from(projects).where(eq(projects.gitRemoteKey, key)).limit(1)
  if (!proj) {
    ;[proj] = await db.select().from(projects).where(sql`${projects.aliases} @> ARRAY[${key}]::text[]`).limit(1)
  }
  if (proj) {
    const localPaths = (proj.localPaths ?? [])
    const nextPaths = cwd && !localPaths.includes(cwd) ? [...localPaths, cwd] : localPaths
    await db.update(projects).set({ localPaths: nextPaths, lastActivityAt: new Date(), updatedAt: new Date() }).where(eq(projects.id, proj.id))
    return { ...proj, localPaths: nextPaths, lastActivityAt: new Date() }
  }

  const taken = new Set((await db.select({ slug: projects.slug }).from(projects)).map(r => r.slug))
  const slug = nextUniqueSlug(slugify(repoNameFromKey(key)) || 'project', taken)
  try {
    const [created] = await db.insert(projects).values({
      slug, name: repoNameFromKey(key), gitRemoteKey: key,
      repositoryUrl: input.gitRemote ?? null,
      localPaths: cwd ? [cwd] : [], lastActivityAt: new Date()
    }).returning()
    return created!
  } catch {
    // unique race on git_remote_key — another ingest created it first
    const [racer] = await db.select().from(projects).where(eq(projects.gitRemoteKey, key)).limit(1)
    if (racer) return racer
    throw new Error(`findOrCreateProject: failed to create or find project for key ${key}`)
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors. (No vitest — `findOrCreateProject` is DB-bound; it is exercised in Task 7's backfill verification.)

- [ ] **Step 4: Commit**

```bash
git add server/services/projects.ts
git commit -m "feat(projects): findOrCreateProject (git-remote match -> alias -> create -> uncategorized)"
```

---

## Task 5: Wire session ingestion

**Files:**
- Modify: `server/services/sessions.ts` (`upsertSession`)

Context: `upsertSession` (server/services/sessions.ts) builds `insertValues` + `updateSet` and upserts on `(source, externalId)`. It receives `gitRemote`/`cwd` on the `/api/hooks/cc/[event]` path. We resolve a project when git info is present and set `projectId` (+ keep `project` slug denormalized). The transcript path calls `upsertSession({source, externalId})` only — no git → we leave `projectId` untouched.

- [ ] **Step 1: Import** at top of `server/services/sessions.ts`:
```ts
import { findOrCreateProject } from './projects'
```

- [ ] **Step 2: Resolve the project** inside `upsertSession`, right after `const now = new Date()`:
```ts
  // Resolve canonical project when we have git/cwd signal (event path). Never
  // clobber an existing project_id when this call carries no signal (transcript path).
  let resolvedProjectId: string | undefined
  let resolvedProjectSlug: string | undefined
  if (input.gitRemote != null || input.cwd != null) {
    const proj = await findOrCreateProject({ gitRemote: input.gitRemote, cwd: input.cwd })
    resolvedProjectId = proj.id
    resolvedProjectSlug = proj.slug
  }
```

- [ ] **Step 3: Write the columns.** In the `updateSet` block add (after the existing `project` handling):
```ts
  if (resolvedProjectId) { updateSet.projectId = resolvedProjectId; updateSet.project = resolvedProjectSlug }
```
and in `insertValues` add:
```ts
    ...(resolvedProjectId ? { projectId: resolvedProjectId, project: resolvedProjectSlug } : {}),
```
(Leave the existing `input.project`-based handling as a fallback for callers that pass a slug directly; `resolvedProjectId` wins when present.)

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add server/services/sessions.ts
git commit -m "feat(sessions): resolve canonical project_id on ingest via findOrCreateProject"
```

---

## Task 6: Wire memory enrichment (project_id + source_date)

**Files:**
- Modify: `server/services/memory-resolve.ts`
- Modify: `server/services/memory-enrich.ts`

- [ ] **Step 1: Extend `ResolveInput` + bucket by project_id** in `server/services/memory-resolve.ts`.

Add to the `ResolveInput` interface:
```ts
  projectId?: string | null
  sourceDate?: Date | null
```
Change the near-neighbour `projectFilter` (currently keyed on `memories.project` string) to bucket on `project_id`:
```ts
  const projectFilter = input.projectId ? eq(memories.projectId, input.projectId) : isNull(memories.projectId)
```

- [ ] **Step 2: Persist the new fields in `insertFresh`.** In the `db.insert(memories).values({...})` call add:
```ts
    project: input.project ?? null,
    projectId: input.projectId ?? null,
    sourceDate: input.sourceDate ?? null,
```
(Add `projectId` + `sourceDate` next to the existing `project` line.)

- [ ] **Step 3: Bump source_date on evidence merge.** Change `mergeEvidence` to also advance `source_date` to the most recent (uses SQL `greatest`, null-safe):
```ts
async function mergeEvidence(targetId: string, evidence: unknown[], sourceDate: Date | null) {
  const db = useDb()
  await db.update(memories).set({
    evidence: sql`${memories.evidence} || ${JSON.stringify(evidence)}::jsonb`,
    sourceDate: sql`greatest(${memories.sourceDate}, ${sourceDate ?? null})`,
    updatedAt: new Date()
  }).where(eq(memories.id, targetId))
  publishChange({ resource: 'memory', action: 'updated', id: targetId })
}
```
Update both `mergeEvidence(...)` call sites in `resolveEnrichedMemory` to pass `input.sourceDate ?? null` as the third arg.

- [ ] **Step 4: Set project_id + source_date + sessionDate in enrichment.** In `server/services/memory-enrich.ts`:

(a) The candidate-session query selects `id, messageCount, project`. Add `projectId` and `startedAt`:
```ts
    .select({
      id: sessions.id,
      messageCount: sessions.messageCount,
      project: sessions.project,
      projectId: sessions.projectId,
      startedAt: sessions.startedAt
    })
```

(b) Replace the project-active filter in the selector. The current condition:
```ts
sql`(${sessions.project} is null or ${sessions.project} not in (select slug from ${projects} where active = false))`
```
becomes:
```ts
sql`not exists (select 1 from ${projects} p where p.id = ${sessions.projectId} and p.active = false)`
```

(c) Where each candidate memory is persisted via `resolveEnrichedMemory`, import the helper and pass the new fields:
```ts
import { projectIdForScope } from '../lib/projects/memory-project'
```
and in the `resolveEnrichedMemory({...})` call:
```ts
            projectId: projectIdForScope(candidate.scope, session.projectId ?? null),
            sourceDate: session.startedAt ?? null,
            evidence: [{
              sessionId: session.id,
              sessionDate: session.startedAt?.toISOString() ?? null,
              msgIds: candidate.evidenceMsgIds ?? [],
              quote: candidate.quote ?? null,
              reasoning: candidate.reasoning ?? null,
              mergedAt: new Date().toISOString()
            }]
```
(Add `projectId`, `sourceDate`, and the `sessionDate` evidence field to the existing object.)

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add server/services/memory-resolve.ts server/services/memory-enrich.ts
git commit -m "feat(memory): bucket+stamp enriched memories by canonical project_id + source_date"
```

---

## Task 7: Backfill script + docs

**Files:**
- Create: `scripts/backfill-projects.ts`
- Create: `docs/wiki/projects.md`
- Modify: `docs/wiki/memory.md`, `docs/wiki/sessions.md`

- [ ] **Step 1: Write the backfill script** `scripts/backfill-projects.ts`:
```ts
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

// in-memory slug set for unique-slug generation
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

// Sessions
const { rows: sessions } = await db.query(`select id, git_remote, cwd, project_id from sessions`)
let sCount = 0
for (const s of sessions) {
  const pid = await resolveProject(s.git_remote, s.cwd)
  const { rows: slugRow } = await db.query(`select slug from projects where id=$1`, [pid])
  await db.query(`update sessions set project_id=$2, project=$3 where id=$1`, [s.id, pid, slugRow[0].slug])
  sCount++
}

// Memories: project_id (scope-based) + source_date from the session
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
```

- [ ] **Step 2: Run it on dev + verify**

```bash
node_modules/.bin/tsx --env-file=.env scripts/backfill-projects.ts
psql "$DATABASE_URL" -c "SELECT count(*) total, count(project_id) with_project FROM sessions;" \
  -c "SELECT slug, git_remote_key FROM projects ORDER BY last_activity_at DESC NULLS LAST LIMIT 10;" \
  -c "SELECT count(*) FILTER (WHERE source_date IS NOT NULL) dated FROM memories;"
```
Expected: every session has a `project_id`; real projects created from git remotes; memory `source_date` populated where a session exists.

- [ ] **Step 3: Write `docs/wiki/projects.md`** — a new wiki page (`status: shipped`, `cycle: 14`, `phase: 1`) documenting: the `projects` schema (uuid id, slug unique, `git_remote_key` canonical key, richer columns, `active` kept), `findOrCreateProject` matching (normalize → key → alias → create → Uncategorized), the session + memory wiring, `source_date` semantics, the backfill script, and the explicit phase-2/3 deferrals (merge, doc/task association, auto-move, UI). Mirror the structure/voice of `docs/wiki/sessions.md`.

- [ ] **Step 4: Update `docs/wiki/memory.md` and `docs/wiki/sessions.md`** — note `memories.project_id`/`source_date` and the scope-based project rule (memory.md); note `sessions.project_id` + that ingest resolves it via `findOrCreateProject` (sessions.md). Link both to `projects.md`.

- [ ] **Step 5: Full gates + commit**

```bash
pnpm typecheck && pnpm test && pnpm build   # all green
git add scripts/backfill-projects.ts docs/wiki/
git commit -m "feat(projects): backfill script + wiki (projects/memory/sessions)"
```

---

## Self-Review (run after implementation)

- **Spec coverage:** projects schema (T3) · normalizeGitRemote/findOrCreateProject (T1,T4) · Uncategorized (T3 seed, T4 fallback) · scope→project_id + source_date (T2,T6) · session wiring (T5) · enrichment wiring + selector (T6) · backfill (T7) · out-of-scope respected (no merge/UI/docs-move). The one spec deviation (`active` kept, not `archived_at`) is flagged in the header.
- **Deferred to rollout (not code tasks):** re-enable the `enrich-memories` cron in `nuxt.config.ts`; run the bridget import on prod. Do these only after this plan ships + backfill runs on prod.
- **Manual-verification note:** `findOrCreateProject`, session wiring, and enrichment DB writes have no vitest (no DB harness in this repo) — they are verified by the Task-7 backfill run + `psql` checks and, for live ingest, by a `/api/hooks/cc/SessionStart` curl on dev with a known git repo cwd (confirm `sessions.project_id` is set).
