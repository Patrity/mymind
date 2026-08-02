# File↔MyMind Sync Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `sync_document` MCP tool so an agent can make a MyMind document match a local file in one call, safely, without echoing bodies.

**Architecture:** Local files carry `mymind_id` + `mymind_hash` in frontmatter. `documents.content_hash` becomes a Postgres generated column so it can never drift, and writes go through an atomic compare-and-swap (`UPDATE … WHERE content_hash = $expected`). The decision logic — create / adopt / update / unchanged / conflict — is a pure function tested without a database; the tool handler does DB I/O around it.

**Tech Stack:** Nuxt 4 + Nitro, drizzle-orm 0.45.2 / drizzle-kit 0.31.10, PostgreSQL 16 (pgvector), Zod, Vitest, `@modelcontextprotocol/sdk`.

**Spec:** `docs/superpowers/specs/2026-08-01-file-sync-primitive-design.md`

## Global Constraints

- Package manager is **pnpm**. Never npm/yarn.
- Gates that must pass before any commit: `pnpm typecheck`, `pnpm test`, `pnpm build`. Lint is red repo-wide and is NOT a gate.
- **Database-backed tests use the `*.db.test.ts` suffix and are excluded from `pnpm test`.** CI has no Postgres service and `deploy` has `needs: test`, so a real-DB test in the default suite would block every deploy. Run them with `pnpm test:db` against the local `mymind-db` on port 5433. Task 0 sets this up.
- The hash covers the document **body only** (`documents.content`). Frontmatter lives in a separate `jsonb` column and is never hashed.
- Every successful mutation calls `publishChange({ resource: 'document', action })` after the DB commit (see `.claude/rules/live-data.md`). Non-writing outcomes (`unchanged`, `adopted`, probe) must NOT emit.
- Document write tools return the body-free `DocReceipt` from `server/lib/agent/receipt.ts`. Never return `content` from a write.
- `sync_document` is `kind: 'create'`, never `dangerous` — `server/lib/mcp/server.ts` refuses to expose dangerous tools over MCP.
- Tool `description` strings are the agent-facing interface; every new parameter and return field must be described there.
- Deletes are out of scope. A sync never removes a document.

---

### Task 0: Split DB-backed tests out of the CI gate

CI runs `pnpm test` with no Postgres service, and `deploy` has `needs: test`. Tasks 1 and 3 add real-database tests, so without this split every push would fail CI and block deploys.

**Files:**
- Modify: `vitest.config.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: the `*.db.test.ts` convention and a `pnpm test:db` script. Every later task's DB test uses this suffix.

- [ ] **Step 1: Exclude the DB suffix from the default run**

In `vitest.config.ts`, add `'**/*.db.test.ts'` as the last entry of the `exclude` array, with a comment:

```ts
      '**/.claude/**',
      // DB-backed tests (*.db.test.ts) need a real Postgres. CI has no database service and
      // `deploy` needs `test`, so they run via `pnpm test:db` locally, never in the CI gate.
      '**/*.db.test.ts'
```

- [ ] **Step 2: Add the script**

In `package.json` scripts, after `"test:watch"`:

```json
    "test:db": "vitest run --exclude '**/node_modules/**' --exclude '**/.claude/**' --dir test",
```

Verify it can actually select a DB test once one exists; if `--exclude` overrides rather than extends the config, use `vitest run --config vitest.db.config.ts` with a config whose `include` is `['**/*.db.test.ts']` and whose `exclude` mirrors the base config minus the `.db` entry. Prove whichever form you choose actually runs a `.db.test.ts` file and that `pnpm test` does not.

- [ ] **Step 3: Verify the split both ways**

Create a throwaway `test/split-probe.db.test.ts` containing `import { describe, it, expect } from 'vitest'; describe('probe', () => { it('runs', () => { expect(1).toBe(1) }) })`.

```bash
pnpm test 2>&1 | grep -c "split-probe"     # expect 0 — excluded from the CI gate
pnpm test:db 2>&1 | grep -c "split-probe"  # expect >0 — picked up by the DB runner
rm test/split-probe.db.test.ts
```

- [ ] **Step 4: Confirm the existing suite is untouched**

```bash
pnpm test
```

Expected: 950 tests pass, exactly as before.

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts package.json
git commit -m "test: split DB-backed tests (*.db.test.ts) out of the CI gate"
```

---

### Task 1: Make `content_hash` a generated column

Closes the drift hole: `server/services/image-enrich.ts:90` writes `content` via a raw `db.update()` that bypasses `updateDoc`, leaving `content_hash` stale. A CAS built on a hash any writer can silently desync is unsafe.

**Files:**
- Modify: `server/db/schema/documents.ts:18`
- Create: `server/db/migrations/<NNNN>_<generated_name>.sql` (drizzle-kit names it; hand-append custom SQL)
- Modify: `server/services/documents.ts:153,189` (delete the JS hashing)
- Test: `test/documents-content-hash.db.test.ts` (DB-backed — excluded from `pnpm test`)

**Interfaces:**
- Consumes: nothing.
- Produces: `documents.contentHash` is read-only at the ORM layer; `createDoc`/`updateDoc` no longer accept or set it.

- [ ] **Step 1: Write the failing test**

Create `test/documents-content-hash.db.test.ts`. This is a real-DB test — it must run against the local `mymind-db` (port 5433), because the behaviour under test is enforced by Postgres, not by TypeScript.

```ts
// test/documents-content-hash.db.test.ts
import { describe, it, expect } from 'vitest'
import { sql } from 'drizzle-orm'
import { useDb } from '../server/db'

const SHA = (t: string) => sql`encode(sha256(convert_to(${t}, 'UTF8')), 'hex')`

describe('documents.content_hash is database-generated', () => {
  it('stays correct even when a writer bypasses updateDoc entirely', async () => {
    const db = useDb()
    const [row] = await db.execute(sql`
      insert into documents (path, content) values ('/input/hash-probe.md', 'original body')
      returning id, content_hash
    `) as unknown as { id: string, content_hash: string }[]

    expect(row!.content_hash).toBe(
      (await db.execute(sql`select ${SHA('original body')} as h`) as unknown as { h: string }[])[0]!.h
    )

    // A raw UPDATE that "forgets" the hash — exactly what image-enrich.ts does.
    await db.execute(sql`update documents set content = 'rewritten by a raw update' where id = ${row!.id}`)

    const [after] = await db.execute(sql`
      select content_hash = ${SHA('rewritten by a raw update')} as matches from documents where id = ${row!.id}
    `) as unknown as { matches: boolean }[]
    expect(after!.matches).toBe(true)

    await db.execute(sql`delete from documents where id = ${row!.id}`)
  })

  it('refuses a direct write to the generated column', async () => {
    const db = useDb()
    await expect(db.execute(sql`
      insert into documents (path, content, content_hash) values ('/input/x.md', 'a', 'deadbeef')
    `)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test:db test/documents-content-hash.db.test.ts
```

Expected: FAIL. The second test fails because the column is currently writable; the first may pass by luck only if no raw update runs — it will fail once the raw update leaves the hash stale.

- [ ] **Step 3: Change the drizzle schema**

In `server/db/schema/documents.ts`, replace line 18:

```ts
  contentHash: text('content_hash'),
```

with:

```ts
  // Generated by Postgres (see the doc_content_hash migration) so no writer can leave it
  // stale — image-enrich.ts writes `content` via a raw db.update() that bypasses updateDoc.
  contentHash: text('content_hash').generatedAlwaysAs(sql`doc_content_hash(content)`),
```

`sql` is already imported at the top of that file.

- [ ] **Step 4: Generate the migration**

```bash
pnpm db:generate
```

Then hand-append the custom SQL to the newly created file in `server/db/migrations/`, following the `-- Custom:` convention already used in `0000_nifty_eternals.sql`. Replace drizzle's generated `content_hash` statements with exactly:

```sql
--> statement-breakpoint
-- Custom: content_hash must be maintained by the database, not by application code.
-- A bare generated expression is rejected ("generation expression is not immutable")
-- because convert_to() is not marked immutable; this wrapper is explicitly immutable,
-- which holds as long as the database encoding is UTF8.
CREATE OR REPLACE FUNCTION doc_content_hash(t text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "content_hash";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "content_hash" text
  GENERATED ALWAYS AS (doc_content_hash(content)) STORED;
```

- [ ] **Step 5: Apply the migration locally**

```bash
pnpm db:migrate
```

Expected: succeeds. Verify the backfill is correct and complete:

```bash
psql -h 127.0.0.1 -p 5433 -U mymind -d mymind -tAc \
  "select count(*) filter (where content_hash = encode(sha256(convert_to(content,'UTF8')),'hex')) || '/' || count(*) from documents where deleted_at is null;"
```

Expected: matching count equals total (e.g. `8/8`).

- [ ] **Step 6: Delete the JS hashing**

In `server/services/documents.ts`:

- Remove `contentHash: createHash('sha256').update(input.content ?? '').digest('hex')` from the `createDoc` insert values (line ~153).
- Remove `if (input.content !== undefined) patch.contentHash = createHash('sha256').update(input.content).digest('hex')` from `updateDoc` (line ~189).
- Remove the now-unused `createHash` import if nothing else in the file uses it (check first: `grep -n createHash server/services/documents.ts`).

- [ ] **Step 7: Run the tests to verify they pass**

```bash
pnpm test:db test/documents-content-hash.db.test.ts
pnpm typecheck && pnpm test && pnpm build
```

Expected: all PASS. `test/agent-doc-receipts.test.ts` must still pass — it mocks the service, so it is unaffected.

- [ ] **Step 8: Commit**

```bash
git add server/db/schema/documents.ts server/db/migrations server/services/documents.ts test/documents-content-hash.db.test.ts
git commit -m "fix(documents): make content_hash a generated column so it cannot drift"
```

---

### Task 2: Pure sync decision logic

The branching is where the safety lives, so it is isolated from the database and tested exhaustively.

**Files:**
- Create: `server/lib/agent/sync.ts`
- Test: `server/lib/agent/sync.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type SyncTarget = { id: string, contentHash: string | null }
  export type SyncDecision =
    | { kind: 'create' }
    | { kind: 'adopt', id: string }
    | { kind: 'unchanged', id: string }
    | { kind: 'write', id: string, expected: string | null }
    | { kind: 'error', error: 'not_found' | 'expected_hash_required' | 'adopt_conflict' | 'hash_mismatch' }
  export function decideSync(
    input: { id?: string, expectedHash?: string, force?: boolean },
    incomingHash: string,
    target: SyncTarget | null
  ): SyncDecision
  export function hashBody(content: string): string
  ```

- [ ] **Step 1: Write the failing test**

```ts
// server/lib/agent/sync.test.ts
import { describe, it, expect } from 'vitest'
import { decideSync, hashBody } from './sync'

const H_LOCAL = hashBody('local body')
const H_SERVER = hashBody('server body')
const target = (contentHash: string | null) => ({ id: 'doc-1', contentHash })

describe('hashBody', () => {
  it('is sha256 hex of the body', () => {
    expect(hashBody('hello world')).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9')
  })
})

describe('decideSync', () => {
  it('creates when nothing matches the path', () => {
    expect(decideSync({}, H_LOCAL, null)).toEqual({ kind: 'create' })
  })

  it('errors when an explicit id resolves to nothing', () => {
    expect(decideSync({ id: 'doc-1' }, H_LOCAL, null)).toEqual({ kind: 'error', error: 'not_found' })
  })

  it('adopts a path match whose content already agrees', () => {
    expect(decideSync({}, H_LOCAL, target(H_LOCAL))).toEqual({ kind: 'adopt', id: 'doc-1' })
  })

  it('reports unchanged when an id-addressed doc already agrees', () => {
    expect(decideSync({ id: 'doc-1', expectedHash: H_LOCAL }, H_LOCAL, target(H_LOCAL)))
      .toEqual({ kind: 'unchanged', id: 'doc-1' })
  })

  it('writes under CAS when expected_hash matches the server', () => {
    expect(decideSync({ id: 'doc-1', expectedHash: H_SERVER }, H_LOCAL, target(H_SERVER)))
      .toEqual({ kind: 'write', id: 'doc-1', expected: H_SERVER })
  })

  it('refuses an id-addressed write with no expected_hash', () => {
    expect(decideSync({ id: 'doc-1' }, H_LOCAL, target(H_SERVER)))
      .toEqual({ kind: 'error', error: 'expected_hash_required' })
  })

  it('refuses to adopt a divergent path match', () => {
    expect(decideSync({}, H_LOCAL, target(H_SERVER)))
      .toEqual({ kind: 'error', error: 'adopt_conflict' })
  })

  it('reports hash_mismatch when expected_hash is stale', () => {
    expect(decideSync({ id: 'doc-1', expectedHash: 'stale' }, H_LOCAL, target(H_SERVER)))
      .toEqual({ kind: 'error', error: 'hash_mismatch' })
  })

  it('force overrides every divergence case', () => {
    const forced = { kind: 'write', id: 'doc-1', expected: null }
    expect(decideSync({ id: 'doc-1', force: true }, H_LOCAL, target(H_SERVER))).toEqual(forced)
    expect(decideSync({ force: true }, H_LOCAL, target(H_SERVER))).toEqual(forced)
    expect(decideSync({ id: 'doc-1', expectedHash: 'stale', force: true }, H_LOCAL, target(H_SERVER))).toEqual(forced)
  })

  it('prefers unchanged over force — a no-op write is still a no-op', () => {
    expect(decideSync({ id: 'doc-1', force: true }, H_LOCAL, target(H_LOCAL)))
      .toEqual({ kind: 'unchanged', id: 'doc-1' })
  })

  it('treats a null stored hash as divergent rather than equal', () => {
    expect(decideSync({ id: 'doc-1', expectedHash: H_SERVER }, H_LOCAL, target(null)))
      .toEqual({ kind: 'error', error: 'hash_mismatch' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run server/lib/agent/sync.test.ts
```

Expected: FAIL — `Cannot find module './sync'`.

- [ ] **Step 3: Write the implementation**

```ts
// server/lib/agent/sync.ts
import { createHash } from 'node:crypto'

/** The body hash both sides compare. Body only — frontmatter is a separate column and is never hashed. */
export function hashBody(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export type SyncTarget = { id: string, contentHash: string | null }

export type SyncDecision =
  | { kind: 'create' }
  | { kind: 'adopt', id: string }
  | { kind: 'unchanged', id: string }
  | { kind: 'write', id: string, expected: string | null }
  | { kind: 'error', error: 'not_found' | 'expected_hash_required' | 'adopt_conflict' | 'hash_mismatch' }

/**
 * Decide what a sync should do. Pure: the caller resolves `target` from the DB first.
 *
 * Fails closed — every divergent path needs either a matching `expected_hash` or an explicit
 * `force`. A first sync must never silently clobber a doc that was edited in the MyMind UI.
 */
export function decideSync(
  input: { id?: string, expectedHash?: string, force?: boolean },
  incomingHash: string,
  target: SyncTarget | null
): SyncDecision {
  if (!target) return input.id ? { kind: 'error', error: 'not_found' } : { kind: 'create' }

  // A no-op is a no-op regardless of force — never write, never emit a change event.
  if (target.contentHash === incomingHash) {
    return input.id ? { kind: 'unchanged', id: target.id } : { kind: 'adopt', id: target.id }
  }

  if (input.force) return { kind: 'write', id: target.id, expected: null }
  if (!input.expectedHash) {
    return { kind: 'error', error: input.id ? 'expected_hash_required' : 'adopt_conflict' }
  }
  if (input.expectedHash !== target.contentHash) return { kind: 'error', error: 'hash_mismatch' }
  return { kind: 'write', id: target.id, expected: input.expectedHash }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run server/lib/agent/sync.test.ts
```

Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add server/lib/agent/sync.ts server/lib/agent/sync.test.ts
git commit -m "feat(agent): pure sync decision logic with fail-closed divergence handling"
```

---

### Task 3: Path lookup + atomic compare-and-swap in the documents service

**Files:**
- Modify: `server/services/documents.ts`
- Test: `test/documents-cas.db.test.ts` (DB-backed — excluded from `pnpm test`)

**Interfaces:**
- Consumes: `SyncTarget` from Task 2 (shape only).
- Produces:
  ```ts
  export async function findDocByPath(path: string): Promise<{ id: string, contentHash: string | null } | null>
  export async function casUpdateContent(
    id: string, content: string, expectedHash: string | null
  ): Promise<DocumentDTO | null>
  ```
  `casUpdateContent` returns `null` when the CAS loses (row missing, soft-deleted, or hash moved).

- [ ] **Step 1: Write the failing test**

```ts
// test/documents-cas.db.test.ts
import { describe, it, expect } from 'vitest'
import { createDoc, casUpdateContent, findDocByPath, deleteDoc } from '../server/services/documents'
import { hashBody } from '../server/lib/agent/sync'

describe('casUpdateContent', () => {
  it('writes when the expected hash matches and refuses when it does not', async () => {
    const doc = await createDoc({ path: `/input/cas-${Date.now()}.md`, content: 'v1' })
    expect(doc.contentHash).toBe(hashBody('v1'))

    const ok = await casUpdateContent(doc.id, 'v2', hashBody('v1'))
    expect(ok?.contentHash).toBe(hashBody('v2'))

    // Stale expectation — the row moved on, so this must lose.
    const stale = await casUpdateContent(doc.id, 'v3', hashBody('v1'))
    expect(stale).toBeNull()

    // The losing write must not have changed anything.
    const still = await findDocByPath(doc.path)
    expect(still?.contentHash).toBe(hashBody('v2'))

    // expected = null is the forced path and always wins.
    const forced = await casUpdateContent(doc.id, 'v4', null)
    expect(forced?.contentHash).toBe(hashBody('v4'))

    await deleteDoc(doc.id)
  })

  it('will not resurrect a soft-deleted document', async () => {
    const doc = await createDoc({ path: `/input/cas-del-${Date.now()}.md`, content: 'v1' })
    await deleteDoc(doc.id)
    expect(await casUpdateContent(doc.id, 'v2', hashBody('v1'))).toBeNull()
  })
})

describe('findDocByPath', () => {
  it('finds a live document and ignores a deleted one', async () => {
    const path = `/input/find-${Date.now()}.md`
    const doc = await createDoc({ path, content: 'body' })
    expect((await findDocByPath(path))?.id).toBe(doc.id)
    await deleteDoc(doc.id)
    expect(await findDocByPath(path)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test:db test/documents-cas.db.test.ts
```

Expected: FAIL — `casUpdateContent is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `server/services/documents.ts`, after `updateDoc`:

```ts
/** Resolve a sync target by exact live path. Uses the existing unique index on live paths. */
export async function findDocByPath(path: string): Promise<{ id: string, contentHash: string | null } | null> {
  const [r] = await useDb()
    .select({ id: documents.id, contentHash: documents.contentHash })
    .from(documents)
    .where(and(eq(documents.path, path), live()))
    .limit(1)
  return r ?? null
}

/**
 * Atomic compare-and-swap on content. `expectedHash: null` forces the write.
 *
 * The guard lives in the UPDATE's WHERE clause, not in a preceding SELECT — a read-then-write
 * would let a concurrent edit slip in between the two statements. Zero affected rows means the
 * row is gone, soft-deleted, or its hash moved; the caller disambiguates with one follow-up read.
 */
export async function casUpdateContent(
  id: string, content: string, expectedHash: string | null
): Promise<DocumentDTO | null> {
  const [r] = await useDb()
    .update(documents)
    .set({ content, updatedAt: new Date() })
    .where(and(
      eq(documents.id, id),
      live(),
      expectedHash === null ? undefined : eq(documents.contentHash, expectedHash)
    ))
    .returning()
  return r ? toDTO(r) : null
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test:db test/documents-cas.db.test.ts && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/documents.ts test/documents-cas.db.test.ts
git commit -m "feat(documents): findDocByPath + atomic content compare-and-swap"
```

---

### Task 4: The `sync_document` tool

**Files:**
- Modify: `server/lib/agent/receipt.ts`
- Modify: `server/lib/agent/tools.ts`
- Test: `test/agent-sync-document.test.ts`

**Interfaces:**
- Consumes: `decideSync`, `hashBody`, `SyncDecision` (Task 2); `findDocByPath`, `casUpdateContent` (Task 3); `docReceipt`, `docNotFound` (already shipped).
- Produces: the `sync_document` agent tool; `divergenceReport()` in `receipt.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// test/agent-sync-document.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { hashBody } from '../server/lib/agent/sync'

let rows: Record<string, { id: string, path: string, content: string }> = {}
const changes: string[] = []

const toRow = (r: { id: string, path: string, content: string }) => ({
  id: r.id, path: r.path, title: 'T', content: r.content, language: 'markdown',
  frontmatter: {}, project: null, domain: null, type: null, tags: [], topic: null,
  contentHash: hashBody(r.content), isPublic: false, publicSlug: null, ocrId: null,
  updatedAt: '2026-08-01T00:00:00.000Z'
})

vi.mock('../server/services/documents', () => ({
  findDocByPath: async (p: string) => {
    const r = Object.values(rows).find(x => x.path === p)
    return r ? { id: r.id, contentHash: hashBody(r.content) } : null
  },
  getDoc: async (id: string) => (rows[id] ? toRow(rows[id]!) : null),
  casUpdateContent: async (id: string, content: string, expected: string | null) => {
    const r = rows[id]
    if (!r) return null
    if (expected !== null && hashBody(r.content) !== expected) return null
    r.content = content
    return toRow(r)
  },
  createDoc: async (input: { path: string, content?: string }) => {
    const id = 'new-' + Object.keys(rows).length
    rows[id] = { id, path: input.path, content: input.content ?? '' }
    return toRow(rows[id]!)
  },
  updateDoc: async (id: string) => (rows[id] ? toRow(rows[id]!) : null),
  moveDoc: async () => null, deleteDoc: async () => true, restoreDoc: async () => true,
  searchPassages: async () => [], listDocsSummary: async () => [],
  countDocs: async () => 0, searchDocsPage: async () => ({ items: [], total: 0 })
}))

vi.mock('../server/utils/live-bus', () => ({
  publishChange: (c: { action: string }) => { changes.push(c.action) }, publishActivity: () => {}
}))

const { agentTools } = await import('../server/lib/agent/tools')
const run = async (args: Record<string, unknown>) => (await agentTools.find(t => t.name === 'sync_document')!
  .handler(args, { signal: new AbortController().signal })).result as Record<string, any>

beforeEach(() => {
  rows = { 'doc-1': { id: 'doc-1', path: '/projects/x/a.md', content: 'server body' } }
  changes.length = 0
})

describe('sync_document', () => {
  it('creates when the path matches nothing', async () => {
    const res = await run({ path: '/projects/x/new.md', content: 'fresh' })
    expect(res.ok).toBe(true)
    expect(res.action).toBe('created')
    expect(res.hash).toBe(hashBody('fresh'))
    expect(res).not.toHaveProperty('content')
    expect(changes).toEqual(['created'])
  })

  it('adopts a path match that already agrees, without writing', async () => {
    const res = await run({ path: '/projects/x/a.md', content: 'server body' })
    expect(res.action).toBe('adopted')
    expect(res.id).toBe('doc-1')
    expect(res.hash).toBe(hashBody('server body'))
    expect(changes).toEqual([])
  })

  it('refuses to adopt a divergent path match', async () => {
    const res = await run({ path: '/projects/x/a.md', content: 'local body' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('adopt_conflict')
    expect(res.server.hash).toBe(hashBody('server body'))
    expect(res.local.bytes).toBe('local body'.length)
    expect(res).not.toHaveProperty('content')
    expect(rows['doc-1']!.content).toBe('server body')
    expect(changes).toEqual([])
  })

  it('updates under a matching expected_hash', async () => {
    const res = await run({ id: 'doc-1', content: 'local body', expected_hash: hashBody('server body') })
    expect(res.action).toBe('updated')
    expect(res.hash).toBe(hashBody('local body'))
    expect(res.bytes).toEqual({ before: 'server body'.length, after: 'local body'.length })
    expect(changes).toEqual(['updated'])
  })

  it('reports unchanged without writing or emitting', async () => {
    const res = await run({ id: 'doc-1', content: 'server body', expected_hash: hashBody('server body') })
    expect(res.action).toBe('unchanged')
    expect(changes).toEqual([])
  })

  it('fails closed on a stale expected_hash', async () => {
    const res = await run({ id: 'doc-1', content: 'local body', expected_hash: hashBody('ancient') })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('hash_mismatch')
    expect(rows['doc-1']!.content).toBe('server body')
    expect(changes).toEqual([])
  })

  it('refuses an id-addressed write with no expected_hash', async () => {
    const res = await run({ id: 'doc-1', content: 'local body' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('expected_hash_required')
    expect(changes).toEqual([])
  })

  it('force overrides divergence', async () => {
    const res = await run({ id: 'doc-1', content: 'local body', force: true })
    expect(res.action).toBe('updated')
    expect(rows['doc-1']!.content).toBe('local body')
  })

  it('reports not_found for an unknown id', async () => {
    const res = await run({ id: 'nope', content: 'x', expected_hash: 'y' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('not_found')
  })

  it('requires a path when there is no id', async () => {
    const res = await run({ content: 'x' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('path_required')
  })

  it('loses the CAS race without corrupting anything', async () => {
    // expected_hash agrees with the pre-read, but the row moves before the write lands.
    const expected = hashBody('server body')
    rows['doc-1']!.content = 'someone else got there first'
    const res = await run({ id: 'doc-1', content: 'local body', expected_hash: expected })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('hash_mismatch')
    expect(rows['doc-1']!.content).toBe('someone else got there first')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run test/agent-sync-document.test.ts
```

Expected: FAIL — no tool named `sync_document`.

- [ ] **Step 3: Add the divergence report helper**

Append to `server/lib/agent/receipt.ts`:

```ts
import { outline } from '../documents/edit-ops'
import type { DocumentDTO } from '../../../shared/types/documents'

/**
 * Why a sync refused to write. Deliberately body-free: enough for the agent to decide whether
 * to inspect, without pulling the document and re-creating the overflow receipts prevent.
 */
export function divergenceReport(
  error: 'adopt_conflict' | 'hash_mismatch' | 'expected_hash_required',
  server: DocumentDTO,
  localContent: string
) {
  const body = server.content ?? ''
  return {
    ok: false as const,
    error,
    id: server.id,
    server: {
      hash: server.contentHash,
      bytes: body.length,
      updatedAt: server.updatedAt,
      headings: outline(body).map(h => h.text).slice(0, 25)
    },
    local: { bytes: localContent.length },
    hint: 'inspect with read_document/grep_document, then re-call with force:true (or sync with the server hash as expected_hash)'
  }
}
```

- [ ] **Step 4: Add the tool**

In `server/lib/agent/tools.ts`, extend the documents-service import to include `findDocByPath, casUpdateContent`, add `import { decideSync, hashBody } from './sync'` and `divergenceReport` to the receipt import. Insert this tool immediately after `move_document`:

```ts
  {
    name: 'sync_document',
    description: 'Make a MyMind document match a local file in one call. Pass the file body as `content` (frontmatter stripped) plus the file\'s `mymind_id` as `id` and `mymind_hash` as `expected_hash`; if the file has no id yet, pass an absolute `path` instead and this adopts an existing doc at that path or creates one. Returns a receipt with `action`: created | adopted | updated | unchanged — write the returned `id` and `hash` back into the file\'s frontmatter. Fails closed: if the MyMind copy changed since your last sync you get ok:false with error "hash_mismatch" / "adopt_conflict" / "expected_hash_required" plus a body-free divergence report; re-call with force:true only after genuinely reconciling. Never deletes.',
    kind: 'create',
    schema: {
      id: z.string().optional().describe('Document id (the file\'s mymind_id)'),
      path: z.string().regex(/^\//, 'path must start with /').optional()
        .describe('Absolute path; required when there is no id. Filing under /projects/<slug>/ associates the project.'),
      content: z.string().describe('The file body with frontmatter stripped'),
      expected_hash: z.string().optional().describe('The file\'s mymind_hash — required when the target already exists, unless force'),
      force: z.boolean().optional().describe('Write even though the MyMind copy diverged')
    },
    handler: async (a) => {
      const id = a.id as string | undefined
      const path = a.path as string | undefined
      const content = a.content as string
      if (!id && !path) {
        return { result: { ok: false, error: 'path_required', message: 'pass `path` when there is no `id`' }, summary: 'sync_document: path required' }
      }

      const incoming = hashBody(content)
      const current = id ? await getDoc(id) : null
      const target = id
        ? (current ? { id: current.id, contentHash: current.contentHash } : null)
        : await findDocByPath(path!)

      const decision = decideSync(
        { id, expectedHash: a.expected_hash as string | undefined, force: a.force as boolean | undefined },
        incoming, target
      )

      if (decision.kind === 'create') {
        const doc = await createDoc({ path: path!, content, title: (a.title as string) ?? undefined })
        publishChange({ resource: 'document', action: 'created', id: doc.id })
        return {
          result: { ...docReceipt(doc, { before: 0 }), action: 'created' },
          summary: `synced (created) ${doc.path}`,
          undo: async () => { await deleteDoc(doc.id) }
        }
      }

      if (decision.kind === 'error' && decision.error === 'not_found') {
        return { result: docNotFound(id!), summary: 'sync_document: not found' }
      }

      // Every remaining branch needs the server row.
      const server = current ?? await getDoc(decision.kind === 'error' ? target!.id : decision.id)
      if (!server) return { result: docNotFound(id ?? target!.id), summary: 'sync_document: not found' }

      if (decision.kind === 'error') {
        return { result: divergenceReport(decision.error, server, content), summary: `sync_document: ${decision.error}` }
      }

      if (decision.kind === 'adopt' || decision.kind === 'unchanged') {
        return {
          result: { ...docReceipt(server, { before: (server.content ?? '').length }), action: decision.kind === 'adopt' ? 'adopted' : 'unchanged' },
          summary: `sync_document: ${decision.kind} ${server.path}`
        }
      }

      const prior = server.content ?? ''
      const updated = await casUpdateContent(decision.id, content, decision.expected)
      if (!updated) {
        // Lost the race: the row moved between our read and the write landing.
        const fresh = await getDoc(decision.id)
        if (!fresh) return { result: docNotFound(decision.id), summary: 'sync_document: not found' }
        return { result: divergenceReport('hash_mismatch', fresh, content), summary: 'sync_document: hash_mismatch' }
      }
      publishChange({ resource: 'document', action: 'updated', id: decision.id })
      return {
        result: { ...docReceipt(updated, { before: prior.length }), action: 'updated' },
        summary: `synced (updated) ${updated.path}`,
        undo: async () => {
          await casUpdateContent(decision.id, prior, null)
          publishChange({ resource: 'document', action: 'updated', id: decision.id })
        }
      }
    }
  },
```

Add `title: z.string().optional().describe('Title for a created document')` to the schema so the `createDoc` call above type-checks. The remaining metadata passthrough (`tags`, `type`, `frontmatter`) and path relocation are Task 5 — keep this task to content only.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm vitest run test/agent-sync-document.test.ts && pnpm typecheck && pnpm test && pnpm build
```

Expected: all PASS. `test/agent-tools.test.ts` asserts the exact tool-name list — add `sync_document` to it (alphabetically, after `search_tasks`).

- [ ] **Step 6: Commit**

```bash
git add server/lib/agent/tools.ts server/lib/agent/receipt.ts test/agent-sync-document.test.ts test/agent-tools.test.ts
git commit -m "feat(agent,mcp): sync_document — CAS-guarded file to document sync"
```

---

### Task 5: Metadata passthrough and rename-follows-id

The spec requires two things Task 4 deliberately left out: optional `tags`/`type`/`frontmatter` passthrough, and relocation when `path` is passed alongside `id` — which is what makes a renamed or moved local file converge instead of forking a second document.

**Files:**
- Modify: `server/lib/agent/tools.ts` (the `sync_document` schema + handler tail)
- Test: `test/agent-sync-document.test.ts` (append)

**Interfaces:**
- Consumes: `updateDoc` (existing), which already routes `path` through `computeFinalPath` + `resolveDocProjectFromPath`, so relocating also re-files the project.
- Produces: no new exports. The receipt's `path` reflects the post-relocation path.

- [ ] **Step 1: Write the failing test**

Append to `test/agent-sync-document.test.ts`. Extend the `updateDoc` mock at the top of the file first, replacing the existing one-liner:

```ts
  updateDoc: async (id: string, patch: { path?: string }) => {
    const r = rows[id]
    if (!r) return null
    if (patch.path !== undefined) r.path = patch.path
    return toRow(r)
  },
```

```ts
describe('sync_document metadata and relocation', () => {
  it('relocates the document when path is passed alongside id', async () => {
    const res = await run({
      id: 'doc-1', path: '/projects/x/renamed.md',
      content: 'local body', expected_hash: hashBody('server body')
    })
    expect(res.action).toBe('updated')
    expect(res.path).toBe('/projects/x/renamed.md')
    expect(rows['doc-1']!.path).toBe('/projects/x/renamed.md')
  })

  it('relocates even when the body is unchanged', async () => {
    const res = await run({
      id: 'doc-1', path: '/projects/x/moved.md',
      content: 'server body', expected_hash: hashBody('server body')
    })
    expect(res.action).toBe('unchanged')
    expect(rows['doc-1']!.path).toBe('/projects/x/moved.md')
  })

  it('does not relocate when path already matches', async () => {
    const res = await run({
      id: 'doc-1', path: '/projects/x/a.md',
      content: 'server body', expected_hash: hashBody('server body')
    })
    expect(res.action).toBe('unchanged')
    expect(rows['doc-1']!.path).toBe('/projects/x/a.md')
  })

  it('never relocates on a refused write', async () => {
    const res = await run({ id: 'doc-1', path: '/projects/x/nope.md', content: 'local body' })
    expect(res.ok).toBe(false)
    expect(rows['doc-1']!.path).toBe('/projects/x/a.md')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run test/agent-sync-document.test.ts -t "metadata and relocation"
```

Expected: FAIL — the handler ignores `path` when `id` is present, so `res.path` is still `/projects/x/a.md`.

- [ ] **Step 3: Extend the schema**

Add to the `sync_document` schema:

```ts
      tags: z.array(z.string()).optional().describe('Replace the document\'s tags'),
      type: z.string().optional().describe('Document type'),
      frontmatter: z.record(z.string(), z.unknown()).optional()
        .describe('The file\'s non-mymind frontmatter keys. Stored separately from the body and NOT covered by the hash.'),
```

- [ ] **Step 4: Apply metadata after a successful content outcome**

Add this helper immediately above the `sync_document` tool definition in `tools.ts`:

```ts
/**
 * Apply path/metadata after a sync's content decision has already succeeded.
 *
 * Relocation is what makes a renamed local file converge instead of forking a second doc:
 * the file keeps its mymind_id, so passing the new path moves the existing document (and
 * re-files its project, via updateDoc's path⟺project choke point) rather than creating one.
 * Runs only on non-error outcomes — a refused write must leave everything untouched.
 */
async function applySyncMeta(
  doc: DocumentDTO, a: Record<string, unknown>
): Promise<DocumentDTO> {
  const patch: Record<string, unknown> = {}
  const path = a.path as string | undefined
  if (path !== undefined && path !== doc.path) patch.path = path
  for (const k of ['title', 'tags', 'type', 'frontmatter'] as const) {
    if (a[k] !== undefined) patch[k] = a[k]
  }
  if (Object.keys(patch).length === 0) return doc
  const updated = await updateDoc(doc.id, patch)
  if (updated) publishChange({ resource: 'document', action: 'updated', id: doc.id })
  return updated ?? doc
}
```

Add `import type { DocumentDTO } from '../../../shared/types/documents'` to the top of `tools.ts` if it is not already imported.

- [ ] **Step 5: Call it from the adopt/unchanged and updated branches**

Replace the adopt/unchanged return in the handler with:

```ts
      if (decision.kind === 'adopt' || decision.kind === 'unchanged') {
        const before = (server.content ?? '').length
        const final = await applySyncMeta(server, a)
        return {
          result: { ...docReceipt(final, { before }), action: decision.kind === 'adopt' ? 'adopted' : 'unchanged' },
          summary: `sync_document: ${decision.kind} ${final.path}`
        }
      }
```

And in the successful-write branch, replace `docReceipt(updated, { before: prior.length })` with:

```ts
      const final = await applySyncMeta(updated, a)
      return {
        result: { ...docReceipt(final, { before: prior.length }), action: 'updated' },
        summary: `synced (updated) ${final.path}`,
```

Leave the `undo` closure as written — it restores content, which is the destructive part.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm vitest run test/agent-sync-document.test.ts && pnpm typecheck && pnpm test && pnpm build
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add server/lib/agent/tools.ts test/agent-sync-document.test.ts
git commit -m "feat(agent): sync_document metadata passthrough + rename-follows-id relocation"
```

---

### Task 6: Probe mode

The upload is the real cost: syncing a 121 KB doc means putting 121 KB into tool input even on a day nothing changed, which is the common day.

**Files:**
- Modify: `server/lib/agent/tools.ts` (the `sync_document` schema + handler head)
- Test: `test/agent-sync-document.test.ts` (append)

**Interfaces:**
- Consumes: `findDocByPath`, `getDoc`.
- Produces: `sync_document({ id, local_hash })` → `{ ok: true, in_sync: boolean, server_hash: string | null, id }`. Never writes.

- [ ] **Step 1: Write the failing test**

Append to `test/agent-sync-document.test.ts`:

```ts
describe('sync_document probe mode', () => {
  it('confirms agreement without transferring a body', async () => {
    const res = await run({ id: 'doc-1', local_hash: hashBody('server body') })
    expect(res).toEqual({ ok: true, in_sync: true, server_hash: hashBody('server body'), id: 'doc-1' })
    expect(changes).toEqual([])
  })

  it('reports divergence without writing', async () => {
    const res = await run({ id: 'doc-1', local_hash: hashBody('local body') })
    expect(res.ok).toBe(true)
    expect(res.in_sync).toBe(false)
    expect(res.server_hash).toBe(hashBody('server body'))
    expect(rows['doc-1']!.content).toBe('server body')
    expect(changes).toEqual([])
  })

  it('probes by path too', async () => {
    const res = await run({ path: '/projects/x/a.md', local_hash: hashBody('server body') })
    expect(res.in_sync).toBe(true)
  })

  it('reports not_found when probing an unknown target', async () => {
    const res = await run({ id: 'nope', local_hash: 'abc' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('not_found')
  })

  it('rejects a call with neither content nor local_hash', async () => {
    const res = await run({ id: 'doc-1' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('content_required')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run test/agent-sync-document.test.ts -t "probe"
```

Expected: FAIL — `content` is currently required by the Zod schema, so these calls are rejected before the handler runs.

- [ ] **Step 3: Implement probe mode**

Make `content` optional and add `local_hash` in the `sync_document` schema:

```ts
      content: z.string().optional().describe('The file body with frontmatter stripped. Omit only in probe mode.'),
      local_hash: z.string().optional().describe('Probe mode: pass this INSTEAD of content to ask whether the two sides agree, with no body transferred and no write.'),
```

Insert this block at the top of the handler, immediately after the `path_required` guard:

```ts
      // Probe: answer "do we agree?" without moving a body. Never writes.
      const localHash = a.local_hash as string | undefined
      if (a.content === undefined) {
        if (!localHash) {
          return { result: { ok: false, error: 'content_required', message: 'pass `content`, or `local_hash` for a probe' }, summary: 'sync_document: content required' }
        }
        const t = id ? await getDoc(id).then(d => d && { id: d.id, contentHash: d.contentHash }) : await findDocByPath(path!)
        if (!t) return { result: docNotFound(id ?? path!), summary: 'sync_document: not found' }
        return {
          result: { ok: true, in_sync: t.contentHash === localHash, server_hash: t.contentHash, id: t.id },
          summary: `sync_document probe: ${t.contentHash === localHash ? 'in sync' : 'diverged'}`
        }
      }
      const content = a.content as string
```

Delete the earlier `const content = a.content as string` line so it is not declared twice. Update the tool description to document probe mode:

> ` … Probe mode: pass `local_hash` INSTEAD of `content` to ask whether the two sides agree without transferring the body — returns { in_sync, server_hash } and never writes.`

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm vitest run test/agent-sync-document.test.ts && pnpm typecheck && pnpm test && pnpm build
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/agent/tools.ts test/agent-sync-document.test.ts
git commit -m "feat(agent): sync_document probe mode — hash check with no body transfer"
```

---

### Task 7: Live end-to-end verification and wiki

Unit tests mock the database, so they cannot prove the CAS actually guards a real `UPDATE`. This task proves it against a real Postgres through the real MCP transport — the same method that caught two defects while shipping write receipts.

**Files:**
- Create: `scripts/sync-document-e2e.mjs`
- Modify: `docs/wiki/mcp.md`

**Interfaces:**
- Consumes: the running app at `http://127.0.0.1:3000/api/mcp`.
- Produces: nothing importable; a verification script and updated docs.

- [ ] **Step 1: Build and start the app against the local database**

```bash
pnpm build
node .output/server/index.mjs &
sleep 3
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/api/health   # expect 200
```

If another process holds `[::1]:3000`, use `127.0.0.1` (not `localhost`) for every request — `localhost` resolves to IPv6 first and will reach the wrong app.

- [ ] **Step 2: Mint a local API token**

```bash
export PGPASSWORD=$(grep -m1 -oE '^DATABASE_URL=.*' .env | sed -E 's#.*://[^:]+:([^@]+)@.*#\1#')
TOK="mm_e2e_$(date +%s)"
HASH=$(node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" "$TOK")
psql -h 127.0.0.1 -p 5433 -U mymind -d mymind -c \
  "insert into api_tokens (name, token_hash, last_four) values ('e2e-sync', '$HASH', '${TOK: -4}');"
echo "$TOK"
```

- [ ] **Step 3: Write and run the E2E script**

```js
// scripts/sync-document-e2e.mjs — run: node scripts/sync-document-e2e.mjs <token>
import { createHash } from 'node:crypto'
const TOK = process.argv[2]
const h = s => createHash('sha256').update(s).digest('hex')
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${cond ? '' : extra}`) }

async function call(name, args) {
  const r = await fetch('http://127.0.0.1:3000/api/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  })
  const text = await r.text()
  const line = text.split('\n').find(l => l.startsWith('data: ') || l.startsWith('{'))
  return JSON.parse(JSON.parse(line.replace(/^data: /, '')).result.content[0].text)
}

const path = `/input/e2e-sync-${Date.now()}.md`
const big = '# E2E\n\n' + 'filler line\n'.repeat(6000)

const created = await call('sync_document', { path, content: big })
ok('created', created.action === 'created' && created.hash === h(big), JSON.stringify(created).slice(0, 200))
ok('receipt is body-free', !('content' in created) && JSON.stringify(created).length < 600)

const adopted = await call('sync_document', { path, content: big })
ok('adopted (idempotent re-sync)', adopted.action === 'adopted' && adopted.id === created.id)

const conflict = await call('sync_document', { path, content: big + 'local change\n' })
ok('adopt_conflict on divergence', conflict.ok === false && conflict.error === 'adopt_conflict')
ok('divergence report is body-free', !('content' in conflict) && JSON.stringify(conflict).length < 1200)

const updated = await call('sync_document', { id: created.id, content: big + 'local change\n', expected_hash: created.hash })
ok('updated under matching CAS', updated.action === 'updated' && updated.hash === h(big + 'local change\n'))

const stale = await call('sync_document', { id: created.id, content: 'clobber', expected_hash: created.hash })
ok('stale expected_hash fails closed', stale.ok === false && stale.error === 'hash_mismatch')

const unchanged = await call('sync_document', { id: created.id, content: big + 'local change\n', expected_hash: updated.hash })
ok('unchanged', unchanged.action === 'unchanged')

const probeSame = await call('sync_document', { id: created.id, local_hash: updated.hash })
ok('probe in_sync', probeSame.in_sync === true && probeSame.server_hash === updated.hash)
const probeDiff = await call('sync_document', { id: created.id, local_hash: h('something else') })
ok('probe diverged', probeDiff.in_sync === false)

const forced = await call('sync_document', { id: created.id, content: 'forced body', force: true })
ok('force overrides', forced.action === 'updated' && forced.hash === h('forced body'))

await call('delete_document', { id: created.id })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
```

```bash
node scripts/sync-document-e2e.mjs "$TOK"
```

Expected: `11 passed, 0 failed`.

- [ ] **Step 4: Verify the database agrees**

```bash
psql -h 127.0.0.1 -p 5433 -U mymind -d mymind -tAc \
  "select count(*) filter (where content_hash = encode(sha256(convert_to(content,'UTF8')),'hex')) || '/' || count(*) from documents where deleted_at is null;"
```

Expected: matching equals total.

- [ ] **Step 5: Clean up the local environment**

```bash
psql -h 127.0.0.1 -p 5433 -U mymind -d mymind -c "delete from api_tokens where name='e2e-sync';"
kill %1
```

- [ ] **Step 6: Update the wiki**

In `docs/wiki/mcp.md`, add this immediately after the "Write receipts + typed edit failures" section:

````markdown
### File sync (`sync_document`)

Makes a MyMind document match a local file in one call, so an agent stops simulating a sync with
N hand-replayed `edit_document` calls.

The local file carries its own MyMind identity, so this works identically for a git repo, a
directory that isn't version-controlled, and MyMind-native docs (which simply have no file):

```markdown
---
mymind_id: 6d14a9c3-c421-4e49-a162-86536b8f534c
mymind_hash: 189d0cfb…
---
```

**The hash covers the body only — frontmatter is excluded.** A hash over the whole file changes
the moment you write it back into that file, so it never converges. MyMind stores `content` and
`frontmatter` as separate columns and `content_hash` is `sha256(content)`, so both sides hash the
same bytes with no normalisation layer.

| `action` | Condition | Writes |
|---|---|---|
| `created` | no `id`, `path` matches no live doc | yes |
| `adopted` | no `id`, `path` matches a live doc that already agrees | no — returns its `id` + `hash` |
| `updated` | `expected_hash` matches stored, or `force: true` | yes |
| `unchanged` | incoming content already equals stored | no, and no `publishChange` |

Writes **fail closed** — `hash_mismatch` (stale `expected_hash`), `adopt_conflict` (a path match
that diverges), `expected_hash_required` (an `id` write with nothing to compare). Each returns a
body-free divergence report (`server.hash`/`bytes`/`updatedAt`/`headings`, `local.bytes`) so the
agent can decide without pulling the document. Gated adoption is what stops a first sync from
clobbering a doc that was edited in the MyMind UI.

The guard is in the `UPDATE`'s `WHERE content_hash = $expected`, not a preceding `SELECT` — a
read-then-write would let a concurrent edit slip between the two statements.

**Probe mode**: pass `local_hash` instead of `content` to ask whether the two sides agree with no
body transferred and no write → `{ ok, in_sync, server_hash, id }`. The real cost of syncing a
121 KB doc is the upload, and most days nothing changed.

Passing `path` alongside `id` **relocates** the document (and re-files its project through the
path⟺project choke point), which is how a renamed local file converges instead of forking.

**Deletes are out of scope.** A deleted local file does not remove its document — a sync that
deletes on absence is one bad glob away from wiping the wiki. Retirement stays deliberate via
`delete_document`.

`documents.content_hash` is a **Postgres generated column** (`doc_content_hash(content)`, an
explicitly-immutable wrapper — a bare `convert_to()` expression is rejected as not immutable).
Application code cannot leave it stale, which matters because `image-enrich.ts` writes `content`
via a raw `db.update()` that bypasses `updateDoc`.
````

Add to the tool table, after the `move_document` row:

```markdown
| `sync_document(id?, path?, content?, local_hash?, expected_hash?, force?, title?, tags?, type?, frontmatter?)` | create | edit-ops-free; `findDocByPath` + `casUpdateContent` → receipt + `action` |
```

Bump `updated:` in the frontmatter to the date of the change.

- [ ] **Step 7: Final gates and commit**

```bash
pnpm typecheck && pnpm test && pnpm build
git add scripts/sync-document-e2e.mjs docs/wiki/mcp.md
git commit -m "test(mcp): live E2E for sync_document; document it in the wiki"
```

---

## Deployment note

`pnpm db:migrate` runs in CD before cutover, so the generated-column migration applies automatically on push to `master`. It rewrites the `documents` table (≈103 live rows in prod — trivial). The prod MCP surface only changes once deployed; the external agent that reported these issues will keep seeing the old tool list until then, and must reconnect its MCP client to pick up the new schema.
