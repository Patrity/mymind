# MCP Document-Tool Ergonomics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the MCP document tools one error shape, an undo that refuses rather than clobbers, and a preamble that points agents at the right workflow.

**Architecture:** Error codes are owned by the pure `edit-ops.ts` module and passed through by the tools, so there is one vocabulary and one place to extend it. The undo contract widens *additively* (`Promise<void | {ok, reason?}>`) so the ~18 closures outside the document tools are untouched, and `runUndo` normalises. Nothing here needs a migration.

**Tech Stack:** Nuxt 4 / Nitro, TypeScript, Drizzle + Postgres, Vitest, MCP (`@modelcontextprotocol/sdk`).

**Spec:** [`../specs/2026-08-07-mcp-doc-tool-ergonomics-design.md`](../specs/2026-08-07-mcp-doc-tool-ergonomics-design.md)

## Global Constraints

- Package manager is **pnpm**. Never npm/yarn.
- Gates: `pnpm typecheck` (0 errors), `pnpm test` (all pass), `pnpm build` (clean). Lint is red repo-wide and is **not** a gate.
- Any DB-backed test must be named `*.db.test.ts` — excluded from `pnpm test`, run via `pnpm test:db`. **CI has no Postgres; a DB test in the normal suite breaks every deploy.**
- **No migration.** No schema change in this cycle.
- Unified failure shape, everywhere: `{ ok: false, error: <code>, message: <prose> }`.
- Error codes live in `server/lib/documents/edit-ops.ts` and are passed through by tools. A tool must never invent its own spelling of a code.
- `MAX_ERROR_OUTLINE = 50`. This is a **different** cap from the existing `MAX_CANDIDATES = 10` (`edit-ops.ts:113`), which bounds candidate lines on an ambiguous match.
- Undo contract: `type UndoFn = () => Promise<void | { ok: boolean; reason?: string }>`. Existing `void` closures must keep working unchanged.
- Every new test gets a mutation check: break the code it guards, watch it go red, revert. Cycle 43 shipped eight assertions that could not fail; the green suite caught none of them.

---

### Task 1: Typed error codes in `edit-ops`

Cycle 52 coded two of this module's six error returns. This finishes the other four.

**Files:**
- Modify: `server/lib/documents/edit-ops.ts:37-47` (`findSection`), `:79-104` (`grepContent`), `:181-190` (`applyEditSection`)
- Test: `server/lib/documents/edit-ops.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export interface OpFailure { error: string; message: string }`; codes `heading_not_found`, `ambiguous_heading`, `invalid_regex`, `replace_needs_heading`.

- [ ] **Step 1: Write the failing tests**

Append to `server/lib/documents/edit-ops.test.ts`:

```ts
describe('typed error codes', () => {
  it('findSection reports heading_not_found with the prose in message', () => {
    const r = findSection('# A\n\ntext', 'Missing') as { error: string; message: string }
    expect(r.error).toBe('heading_not_found')
    expect(r.message).toBe('heading not found: "Missing"')
  })

  it('findSection reports ambiguous_heading and names the count', () => {
    const r = findSection('# Dup\n\na\n\n# Dup\n\nb', 'Dup') as { error: string; message: string }
    expect(r.error).toBe('ambiguous_heading')
    expect(r.message).toMatch(/2 matches/)
  })

  it('grepContent reports invalid_regex', () => {
    const r = grepContent('body', '([', { regex: true }) as { error: string; message: string }
    expect(r.error).toBe('invalid_regex')
    expect(r.message).toMatch(/invalid regex/)
  })

  it('applyEditSection reports replace_needs_heading', () => {
    const r = applyEditSection('# A\n\nx', { mode: 'replace', text: 'y' }) as { error: string; message: string }
    expect(r.error).toBe('replace_needs_heading')
    expect(r.message).toMatch(/requires a heading/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/lib/documents/edit-ops.test.ts -t "typed error codes"`
Expected: FAIL — `expected 'heading not found: "Missing"' to be 'heading_not_found'`.

- [ ] **Step 3: Add the shared failure type and convert the four returns**

Add near the other interfaces at the top of `edit-ops.ts`:

```ts
/** Every failure this module returns: a stable machine code plus human prose. */
export interface OpFailure { error: string; message: string }
```

Widen the three signatures to return `| OpFailure` instead of `| { error: string }` (`findSection`, `grepContent`, `applyEditSection`), and — because `readSection` propagates `findSection`'s failure — widen `readSection`'s return type the same way. Then replace the four returns:

```ts
// findSection (was :41, :42)
if (matches.length === 0) return { error: 'heading_not_found', message: `heading not found: "${heading}"` }
if (matches.length > 1) return { error: 'ambiguous_heading', message: `heading "${heading}" is ambiguous (${matches.length} matches)` }

// grepContent (was :90)
try { re = new RegExp(pattern) } catch (e) { return { error: 'invalid_regex', message: `invalid regex: ${(e as Error).message}` } }

// applyEditSection (was :185)
if (args.mode === 'replace') return { error: 'replace_needs_heading', message: 'replace mode requires a heading; use update_document to replace whole content' }
```

Leave `applyReplace`'s existing `empty_old_string` / `no_match` returns alone — they are already correct.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/lib/documents/edit-ops.test.ts`
Expected: PASS. Existing tests that asserted on the old prose in `.error` will fail — update them to assert `.message`, since the prose moved, and note each one you changed in your report.

- [ ] **Step 5: Prove one test can fail**

Revert the `findSection` heading_not_found line to its old prose, re-run, confirm RED, restore.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck && pnpm vitest run server/lib/documents/edit-ops.test.ts
git add server/lib/documents/edit-ops.ts server/lib/documents/edit-ops.test.ts
git commit -m "feat(edit-ops): finish the typed error codes cycle 52 started"
```

---

### Task 2: Clipped failure outlines and the grep hint

**Files:**
- Modify: `server/lib/documents/edit-ops.ts`
- Test: `server/lib/documents/edit-ops.test.ts`

**Interfaces:**
- Consumes: `OpFailure` (Task 1).
- Produces: `export const MAX_ERROR_OUTLINE = 50`; `export function clipOutline(content: string): { outline: Heading[]; outlineTruncated: boolean }`; `GrepResult` gains an optional `hint?: string`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('clipOutline', () => {
  it('caps a large outline and flags it', () => {
    const content = Array.from({ length: 80 }, (_, i) => `# H${i}`).join('\n\n')
    const r = clipOutline(content)
    expect(r.outline).toHaveLength(MAX_ERROR_OUTLINE)
    expect(r.outlineTruncated).toBe(true)
  })

  it('leaves a small outline whole and unflagged', () => {
    const r = clipOutline('# A\n\n# B')
    expect(r.outline).toHaveLength(2)
    expect(r.outlineTruncated).toBe(false)
  })
})

describe('grepContent hint', () => {
  it('suggests regex:true when a 0-match pattern looks like a regex', () => {
    const r = grepContent('plain text', 'foo.*bar', {}) as { total: number; hint?: string }
    expect(r.total).toBe(0)
    expect(r.hint).toMatch(/regex: true/)
  })

  it('stays silent when the pattern has no metacharacters', () => {
    const r = grepContent('plain text', 'zebra', {}) as { hint?: string }
    expect(r.hint).toBeUndefined()
  })

  it('stays silent when regex was already requested', () => {
    const r = grepContent('plain text', 'foo.*bar', { regex: true }) as { hint?: string }
    expect(r.hint).toBeUndefined()
  })

  it('stays silent when there are matches', () => {
    const r = grepContent('foo zzz bar', 'foo.*bar', {}) as { hint?: string }
    expect(r.hint).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/lib/documents/edit-ops.test.ts -t "clipOutline"`
Expected: FAIL — `clipOutline is not a function`.

- [ ] **Step 3: Implement**

```ts
/**
 * Cap on headings returned in a FAILURE payload. Distinct from MAX_CANDIDATES (10), which bounds
 * candidate lines on an ambiguous match: an outline entry is one short heading line, so it stays
 * cheap where a candidate line can be arbitrarily wide. 50 is enough to orient in a large document
 * without the error result becoming the oversized payload it exists to report.
 */
export const MAX_ERROR_OUTLINE = 50

export function clipOutline(content: string): { outline: Heading[]; outlineTruncated: boolean } {
  const full = outline(content)
  return { outline: full.slice(0, MAX_ERROR_OUTLINE), outlineTruncated: full.length > MAX_ERROR_OUTLINE }
}

/** Characters that only mean something under `regex: true`. */
const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/
```

In `grepContent`, at the single success return, add the hint when it applies:

```ts
  const hint = (!opts.regex && hits.length === 0 && REGEX_METACHARS.test(pattern))
    ? 'pattern looks like a regex — retry with regex: true'
    : undefined
  return {
    matches: kept.map(i => ({ line: i + 1, text: lines[i]!, context: contextLines(lines, i, ctx) })),
    total: hits.length,
    truncated: hits.length > kept.length,
    ...(hint ? { hint } : {})
  }
```

Add `hint?: string` to the `GrepResult` interface.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/lib/documents/edit-ops.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the hint test can fail**

Drop the `hits.length === 0` condition so the hint fires on every non-regex search, re-run, confirm *"stays silent when there are matches"* goes RED, revert.

- [ ] **Step 6: Commit**

```bash
pnpm typecheck && pnpm vitest run server/lib/documents/edit-ops.test.ts
git add server/lib/documents/edit-ops.ts server/lib/documents/edit-ops.test.ts
git commit -m "feat(edit-ops): clip failure outlines; hint at regex:true on a 0-match pattern"
```

---

### Task 3: One error shape across the document tools

**Files:**
- Modify: `server/lib/agent/tools.ts` — `read_document`, `grep_document` (`:241`, `:247`), `edit_section` (`:321`), `update_document` (`:353`), `delete_document`
- Test: `server/lib/agent/tools.test.ts` — **it already exists; extend it.** (`test/agent-tools.test.ts` is a different file that guards the registry count — do not repurpose that one.)

**Interfaces:**
- Consumes: `OpFailure`, `clipOutline` (Tasks 1-2); `docNotFound(id)` → `{ok:false, error:'not_found', message:'document not found', id}` (`server/lib/agent/receipt.ts:35`).
- Produces: every document tool failure is `{ok:false, error:<code>, message:<prose>}`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from 'vitest'
import { agentTools } from './tools'

// The mock must export EVERY name tools.ts imports (see tools.ts:5) or the module fails to load.
vi.mock('../../services/documents', () => ({
  searchPassages: vi.fn(), createDoc: vi.fn(), getDoc: vi.fn(async () => null),
  deleteDoc: vi.fn(), updateDoc: vi.fn(), moveDoc: vi.fn(), restoreDoc: vi.fn(),
  listDocsSummary: vi.fn(), countDocs: vi.fn(), searchDocsPage: vi.fn(),
  findDocByPath: vi.fn(), casUpdateContent: vi.fn()
}))

const tool = (n: string) => agentTools.find(t => t.name === n)!
const ctx = { signal: new AbortController().signal }

describe('document tools: unified failure shape', () => {
  for (const name of ['read_document', 'grep_document', 'delete_document']) {
    it(`${name} returns {ok:false, error:'not_found'} for a missing doc`, async () => {
      const r = await tool(name).handler({ id: 'nope', pattern: 'x' }, ctx as never)
      expect(r.result).toMatchObject({ ok: false, error: 'not_found', message: 'document not found' })
    })
  }

  it('update_document returns no_fields when the patch is empty', async () => {
    const r = await tool('update_document').handler({ id: 'x' }, ctx as never)
    expect(r.result).toMatchObject({ ok: false, error: 'no_fields' })
  })
})
```

> `update_document`'s empty-patch check runs *after* `getDoc`, so the mock must return a document for that one case. Adjust the mock per-test with `vi.mocked(getDoc).mockResolvedValueOnce({ id: 'x', content: '', path: '/p.md' } as never)` — read the handler before writing the test so the ordering is right.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/lib/agent/tools.test.ts`
Expected: FAIL — received `{ error: 'document not found' }` with no `ok`.

- [ ] **Step 3: Convert every failure site**

```ts
// grep_document (:241, :247)
if (!doc) return { result: docNotFound(a.id as string), summary: 'grep_document: not found' }
...
if ('error' in res) return { result: { ok: false, ...res }, summary: `grep_document: ${res.error}` }

// read_document — the not-found site
if (!doc) return { result: docNotFound(a.id as string), summary: 'read_document: not found' }
// read_document — the op-failure site, now clipped
if ('error' in res) return { result: { ok: false, ...res, ...clipOutline(content) }, summary: `read_document: ${res.error}` }

// edit_section (:321)
if ('error' in res) return { result: { ok: false, ...res, ...clipOutline(prior) }, summary: `edit_section: ${res.error}` }

// update_document (:353)
if (Object.keys(patch).length === 0) {
  return { result: { ok: false, error: 'no_fields', message: 'no fields to update' }, summary: 'update_document: empty' }
}

// delete_document — the not-found site
if (!doc) return { result: docNotFound(a.id as string), summary: 'delete_document: not found' }
```

- [ ] **Step 4: Update the tool descriptions**

Each converted tool's `description` gains its failure codes, in the style `edit_document`'s already uses. For example `grep_document`: append `On failure returns ok:false with error "not_found" or "invalid_regex".` Do this for all five — an agent cannot branch on a code it was never told about.

- [ ] **Step 5: Run tests and gates**

Run: `pnpm vitest run server/lib/agent/tools.test.ts && pnpm typecheck && pnpm test`
Expected: PASS, 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add server/lib/agent/tools.ts server/lib/agent/tools.test.ts
git commit -m "feat(mcp): one failure shape across the document tools"
```

---

### Task 4: Widen the undo contract additively

**Files:**
- Modify: `server/lib/agent/undo.ts`, `server/api/agent/undo.post.ts`, `server/lib/agent/types.ts` (the `undo?` field on `ToolExecution`)
- Test: `server/lib/agent/undo.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `export type UndoFn = () => Promise<void | { ok: boolean; reason?: string }>`; `runUndo(token)` → `Promise<{ ok: boolean; reason?: string }>`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { registerUndo, runUndo, hasUndo } from './undo'

describe('runUndo', () => {
  it('normalises a void-returning closure to ok:true — the ~18 untouched closures', async () => {
    let ran = false
    const token = registerUndo(async () => { ran = true })
    expect(await runUndo(token)).toEqual({ ok: true })
    expect(ran).toBe(true)
  })

  it('passes a refusal through with its reason', async () => {
    const token = registerUndo(async () => ({ ok: false, reason: 'document changed' }))
    expect(await runUndo(token)).toEqual({ ok: false, reason: 'document changed' })
  })

  it('KEEPS the token when the closure refuses, so the caller can retry', async () => {
    const token = registerUndo(async () => ({ ok: false, reason: 'document changed' }))
    await runUndo(token)
    expect(hasUndo(token)).toBe(true)
  })

  it('consumes the token on success', async () => {
    const token = registerUndo(async () => {})
    await runUndo(token)
    expect(hasUndo(token)).toBe(false)
  })

  it('reports an unknown token without throwing', async () => {
    expect(await runUndo('nope')).toEqual({ ok: false, reason: 'undo expired or already used' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/lib/agent/undo.test.ts`
Expected: FAIL — `runUndo` returns a boolean, not an object.

- [ ] **Step 3: Implement**

```ts
export type UndoResult = { ok: boolean; reason?: string }
export type UndoFn = () => Promise<void | UndoResult>

interface Entry { fn: UndoFn, expires: number }

export function registerUndo(fn: UndoFn): string { /* unchanged body */ }

export async function runUndo(token: string): Promise<UndoResult> {
  const e = store.get(token)
  if (!e || e.expires < Date.now()) { store.delete(token); return { ok: false, reason: 'undo expired or already used' } }
  const res = (await e.fn()) ?? { ok: true }
  // Consume ONLY on success: a refused undo must stay retryable once the caller reconciles.
  if (res.ok) store.delete(token)
  return res
}
```

Update `ToolExecution.undo` in `server/lib/agent/types.ts` to `UndoFn`.

- [ ] **Step 4: Update the endpoint**

`server/api/agent/undo.post.ts`:

```ts
const res = await runUndo(token)
return res    // { ok, reason? }
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run server/lib/agent/undo.test.ts && pnpm typecheck && pnpm test`
Expected: PASS. Any caller asserting `runUndo` is a boolean must be updated — report each.

- [ ] **Step 6: Prove the token-retention test can fail**

Move `store.delete(token)` back above the `await`, re-run, confirm *"KEEPS the token when the closure refuses"* goes RED, restore.

- [ ] **Step 7: Commit**

```bash
git add server/lib/agent/undo.ts server/lib/agent/undo.test.ts server/api/agent/undo.post.ts server/lib/agent/types.ts
git commit -m "feat(agent): undo can refuse; token survives a refusal"
```

---

### Task 5: CAS-guard the document undo closures

**Files:**
- Modify: `server/lib/agent/tools.ts:299` (`edit_document`), `:327` (`edit_section`), and the `sync_document` `write` branch's undo
- Test: `test/undo-cas.db.test.ts` (create — **must** carry the `.db.test.ts` suffix, and DB tests live in `test/`: see `test/documents-cas.db.test.ts`, which already exercises `casUpdateContent` against a real database and is the file to model connection setup on)

**Interfaces:**
- Consumes: `UndoFn`, `UndoResult` (Task 4); `casUpdateContent(id, content, expectedHash)` → `Promise<DocumentDTO | null>` (`server/services/documents.ts:210`), null when the row is gone or the hash moved.

- [ ] **Step 1: Write the failing DB test**

Model it on an existing `*.db.test.ts` for connection setup. It must: create a document, run `edit_document`, then write different content directly, then run the undo and assert it refuses and left the third-party content intact.

```ts
it('refuses to undo when the document changed after the edit', async () => {
  const doc = await createDoc({ path: `/tmp-${Date.now()}.md`, content: 'original' })
  const exec = await tool('edit_document').handler(
    { id: doc.id, old_string: 'original', new_string: 'edited' }, ctx as never)

  await updateDoc(doc.id, { content: 'a third party wrote this' })

  const res = await exec.undo!()
  expect(res).toMatchObject({ ok: false })
  expect((await getDoc(doc.id))!.content).toBe('a third party wrote this')
})

it('undoes cleanly when nothing else touched the document', async () => {
  const doc = await createDoc({ path: `/tmp-${Date.now()}.md`, content: 'original' })
  const exec = await tool('edit_document').handler(
    { id: doc.id, old_string: 'original', new_string: 'edited' }, ctx as never)

  expect(await exec.undo!()).toMatchObject({ ok: true })
  expect((await getDoc(doc.id))!.content).toBe('original')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:db`
Expected: FAIL on the first test — content is `'original'`, because the unguarded undo clobbered the third-party write. **That failure IS the bug this task fixes; confirm you see it before implementing.**

- [ ] **Step 3: Implement**

For each of the three closures, capture the hash the write produced and CAS against it:

```ts
// edit_document — `updated` is the DTO returned by updateDoc, so updated.contentHash is what we wrote
undo: async () => {
  const restored = await casUpdateContent(id, prior, updated?.contentHash ?? null)
  if (!restored) return { ok: false, reason: 'document changed since the edit — nothing was undone' }
  publishChange({ resource: 'document', action: 'updated', id })
  return { ok: true }
}
```

Apply the same shape to `edit_section` and the `sync_document` `write` branch, using each site's own post-write DTO for the expected hash.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:db && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/agent/tools.ts test/undo-cas.db.test.ts
git commit -m "fix(agent): undo refuses rather than clobbering a newer write"
```

---

### Task 6: Undo for the sync adopt/unchanged branch

**Files:**
- Modify: `server/lib/agent/tools.ts` — `sync_document` handler, the `decision.kind === 'adopt' || decision.kind === 'unchanged'` branch
- Test: `test/undo-cas.db.test.ts` (extend)

**Interfaces:**
- Consumes: `UndoResult` (Task 4).

- [ ] **Step 1: Write the failing test**

```ts
it('a rename-only sync can be undone', async () => {
  const doc = await createDoc({ path: `/before-${Date.now()}.md`, content: 'body' })
  const newPath = `/after-${Date.now()}.md`
  const exec = await tool('sync_document').handler(
    { id: doc.id, content: 'body', expected_hash: doc.contentHash, path: newPath }, ctx as never)

  expect(await exec.undo!()).toMatchObject({ ok: true })
  expect((await getDoc(doc.id))!.path).toBe(doc.path)
})
```

> Read the sync handler before writing this: the exact arguments that produce an `adopt`/`unchanged`-with-`meta.changed` result depend on `decideSync`, and the test must actually reach that branch. If the arguments above land on `write` instead, adjust them and say so in your report — a test that exercises the wrong branch proves nothing.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:db`
Expected: FAIL — `exec.undo` is undefined; the branch registers none.

- [ ] **Step 3: Implement**

`server` is the pre-mutation row (captured above the branch) and `applySyncMeta` reports whether it changed anything. Register an undo only when it did — there is nothing to reverse otherwise:

```ts
      if (decision.kind === 'adopt' || decision.kind === 'unchanged') {
        const before = (server.content ?? '').length
        const meta = await applySyncMeta(server, a)
        if (meta.changed) publishChange({ resource: 'document', action: 'updated', id: decision.id })
        return {
          result: { ...docReceipt(meta.doc, { before }), action: decision.kind === 'adopt' ? 'adopted' : 'unchanged' },
          summary: `sync_document: ${decision.kind} ${meta.doc.path}`,
          // Only a mutating adopt/unchanged is undoable. No content was written on this
          // branch, so this reverses the relocation/metadata patch and needs no CAS.
          ...(meta.changed
            ? {
                undo: async () => {
                  await updateDoc(decision.id, { path: server.path, title: server.title ?? undefined })
                  publishChange({ resource: 'document', action: 'updated', id: decision.id })
                  return { ok: true }
                }
              }
            : {})
        }
      }
```

Read `applySyncMeta` before writing this: if it patches metadata fields beyond `path`/`title`, the undo must restore those too. State in your report exactly which fields it can change and which ones your undo reverses — a partial undo that silently leaves some fields patched is worse than none.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:db && pnpm test && pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add server/lib/agent/tools.ts test/undo-cas.db.test.ts
git commit -m "fix(agent): register undo on a mutating adopt/unchanged sync"
```

---

### Task 7: Preserve curated titles across a relocation

**Files:**
- Modify: `server/services/documents.ts:181`
- Test: `server/services/documents-title.test.ts` (create — pure helper, no DB)

**Interfaces:**
- Produces: `export function nextTitleOnMove(opts: { explicit?: string; currentTitle: string | null; currentPath: string; finalPath: string }): string | null | undefined` — `undefined` means "leave the title alone".

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { nextTitleOnMove } from './documents'

describe('nextTitleOnMove', () => {
  it('re-syncs a title that was tracking the filename', () => {
    expect(nextTitleOnMove({ currentTitle: 'mcp.md', currentPath: '/docs/mcp.md', finalPath: '/projects/x/guide.md' })).toBe('guide.md')
  })

  it('leaves a curated title alone', () => {
    expect(nextTitleOnMove({ currentTitle: 'MCP Server', currentPath: '/docs/mcp.md', finalPath: '/projects/x/guide.md' })).toBeUndefined()
  })

  it('an explicit title always wins', () => {
    expect(nextTitleOnMove({ explicit: 'Chosen', currentTitle: 'mcp.md', currentPath: '/docs/mcp.md', finalPath: '/projects/x/guide.md' })).toBeUndefined()
  })

  it('treats a null title as auto', () => {
    expect(nextTitleOnMove({ currentTitle: null, currentPath: '/docs/mcp.md', finalPath: '/x/guide.md' })).toBe('guide.md')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run server/services/documents-title.test.ts`
Expected: FAIL — `nextTitleOnMove is not a function`.

- [ ] **Step 3: Implement**

```ts
const basenameOfPath = (p: string) => p.split('/').filter(Boolean).pop() ?? null

/**
 * A title that still equals its old basename was never curated, so it keeps tracking the filename.
 * Anything else is a human's choice and survives the move. An explicit title always wins.
 * `undefined` means "do not touch the title".
 */
export function nextTitleOnMove(opts: {
  explicit?: string; currentTitle: string | null; currentPath: string; finalPath: string
}): string | null | undefined {
  if (opts.explicit !== undefined) return undefined
  const wasAuto = opts.currentTitle === null || opts.currentTitle === basenameOfPath(opts.currentPath)
  return wasAuto ? basenameOfPath(opts.finalPath) : undefined
}
```

Then in `updateDoc`, replace the unconditional line. The existing lightweight select fetches `path` only — it must also fetch `title`:

```ts
const next = nextTitleOnMove({
  explicit: input.title, currentTitle: existing.title, currentPath: existing.path, finalPath
})
if (next !== undefined) patch.title = next
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run server/services/documents-title.test.ts && pnpm typecheck && pnpm test`

- [ ] **Step 5: Prove it can fail**

Change `wasAuto` to a constant `true`, re-run, confirm *"leaves a curated title alone"* goes RED, revert.

- [ ] **Step 6: Commit**

```bash
git add server/services/documents.ts server/services/documents-title.test.ts
git commit -m "fix(documents): a relocation no longer clobbers a curated title"
```

---

### Task 8: An honest MCP preamble

**Files:**
- Modify: `server/lib/mcp/server.ts:8-16`
- Test: `test/agent-tools.test.ts` (extend — it already guards the registry)

**Interfaces:**
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

```ts
import { MCP_INSTRUCTIONS } from '../server/lib/mcp/server'

describe('MCP preamble', () => {
  it('points agents at sync_document', () => {
    expect(MCP_INSTRUCTIONS).toMatch(/sync_document/)
  })

  it('does not promise that every write is reversible', () => {
    expect(MCP_INSTRUCTIONS).not.toMatch(/All are reversible via undo/)
  })
})
```

Export `MCP_INSTRUCTIONS` from `server/lib/mcp/server.ts` to make it assertable.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/agent-tools.test.ts -t "MCP preamble"`
Expected: FAIL — no `sync_document` in the string.

- [ ] **Step 3: Rewrite the two lines**

Replace the "Edit in place" and "Keep it tidy" bullets:

```
- Editing: if you hold the file, sync_document makes the document match it in one call (probe with local_hash first when nothing may have changed). With no file behind it, read_document/grep_document to locate then edit_document (exact find/replace) or edit_section — do NOT rewrite a whole document for a small change.
- Keep it tidy: move_document to file, delete_document / delete_task / forget_memory to retire. Most writes are undoable; undo declines rather than clobbering if the record changed since.
```

Keep the block's overall length close to what it was — it costs every connecting agent context on every session.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run test/agent-tools.test.ts && pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add server/lib/mcp/server.ts test/agent-tools.test.ts
git commit -m "fix(mcp): preamble points at sync_document and stops overpromising undo"
```

---

### Task 9: Reconcile the three frontmatter-in-content documents

Data only. No code, no migration.

**Files:** none — this task changes prod data through the MCP.

- [ ] **Step 1: Identify them**

Their ids were never recorded. With LAN access to the box:

```sql
select id, path, title from documents
where deleted_at is null and content like '---%'
order by path;
```

Without LAN, use the MCP: `list_documents` (paged) then `read_document` with a small range on each candidate, checking whether the body opens with a `---` frontmatter block. **Record the ids you find in your report** — the next session should not have to rediscover them.

- [ ] **Step 2: Confirm each is genuinely affected**

For each candidate, call `sync_document` in **probe** mode (`local_hash` of the frontmatter-stripped body, no `content`). A doc that reports `in_sync: false` with a body that differs only by the leading block is affected. A doc whose body legitimately opens with `---` is not — do not touch it.

- [ ] **Step 3: Reconcile**

For each affected doc: parse the leading block, `update_document` with `frontmatter` set to those keys and `content` set to the body with the block removed. Preserve every key; do not invent or drop any.

- [ ] **Step 4: Verify**

Re-run the probe. Expected: `in_sync: true`, or a hash that now matches the frontmatter-stripped body.

- [ ] **Step 5: Record**

No commit — this is data. Put the ids, before/after hashes, and the probe results in your report so the handover can cite them.

---

### Task 10: Docs, wiki, handover, roadmap

**Files:**
- Modify: `docs/wiki/mcp.md`, `docs/superpowers/plans/00-roadmap.md`
- Create: `docs/handovers/2026-08-07-mcp-doc-tool-ergonomics.md`

- [ ] **Step 1: Update the wiki**

`docs/wiki/mcp.md` gains the unified failure shape with its code table, the outline cap, and the undo-refuses behaviour — in present tense, as current behaviour. The wiki is not a changelog.

- [ ] **Step 2: Write the handover**

Match the frontmatter shape of `docs/handovers/2026-08-05-structural-tool-history.md`. Record the real gate numbers, the three reconciled document ids from Task 9, and — plainly — that **the CAS guard's tests do not run in CI**, because `pnpm test:db` is not wired into the deploy gate. That is `70bcc740`, which stays open.

- [ ] **Step 3: Roadmap row**

Insert a **cycle 53** row. 43 was consumed by structural tool-history and the table currently ends at 52.

- [ ] **Step 4: Mirror to MyMind**

`sync_document` the handover to `/projects/mymind/handovers/2026-08-07-mcp-doc-tool-ergonomics.md`.

- [ ] **Step 5: Final gates and commit**

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm test:db
git add docs/
git commit -m "docs(cycle-53): wiki, handover and roadmap row for MCP doc-tool ergonomics"
```

---

## Verification checklist

- [ ] `pnpm typecheck` → 0 errors
- [ ] `pnpm test` → all pass, count recorded in the handover
- [ ] `pnpm test:db` → all pass (run manually; NOT in CI)
- [ ] `pnpm build` → clean
- [ ] Every mutation check in Tasks 1, 2, 4, 5, 7 was actually run and observed RED
- [ ] No migration added
- [ ] Every converted tool's `description` lists its failure codes
- [ ] The three reconciled document ids are recorded in the handover
