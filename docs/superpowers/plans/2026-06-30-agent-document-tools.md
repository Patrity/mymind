# Agent-Usable Document Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agents (MCP clients + in-app Bridget) surgical edit / slice-read / move / delete tools over documents, plus `delete_task`/`forget_memory`, and re-voice descriptions to steer agents toward the second brain.

**Architecture:** All tools are thin wrappers over existing services (`updateDoc`/`moveDoc`/`deleteDoc`/`deleteTask`/`archiveMemory`), registered in the one shared `agentTools` registry (auto-exposed to MCP + Bridget). All string transforms live in a new **pure** module `server/lib/documents/edit-ops.ts` (TDD, no DB). Each handler is `getDoc → pure transform → updateDoc`, with `undo` + `publishChange` on every mutation. No DB migration.

**Tech Stack:** TypeScript, Nitro/Nuxt 4, Drizzle, Zod, `@modelcontextprotocol/sdk`, Vitest (`pnpm test` = `vitest run`), Playwright (`playwright-cli`).

## Global Constraints

- **No DB migration, no schema changes** — thin wrappers only.
- **Tests are pure-logic only.** The repo has NO DB test harness (`useDb()` is lazy; no vitest test touches it). Unit-test `edit-ops.ts` and tool-registration metadata; validate DB behavior via Playwright E2E — never introduce a DB-backed vitest test.
- **The only hard gate is `dangerous:true`** (checked at `server/lib/agent/ai-tools.ts:35`). `kind` does NOT gate. Edit tools use `kind:'create'` (ungated); delete tools use `kind:'destructive'`. **No new tool sets `dangerous`.**
- **Every mutation** calls `publishChange({ resource, action, id })` after commit AND returns an `undo` (live-data rule, `server/utils/live-bus.ts`). `resource` ∈ existing `ResourceName` union (`document`|`task`|`memory` already exist — no union change).
- **Handlers never throw for expected outcomes** (not-found, no-match, ambiguous, invalid regex) — return `{ result: { error }, summary }` (matches the `web_fetch`/`edit_image` convention). Only unexpected infra errors propagate.
- Line numbers in `edit-ops` are **1-indexed**. Sections span heading line → line before the next heading of level ≤ the section heading's level (or EOF). Repeated identical headings are **ambiguous → error** (never silently pick the first).
- Match the existing file's style in `tools.ts` (object literal per tool, `z` schema, `a.x as T` arg casts).

---

## File Structure

- **Create** `server/lib/documents/edit-ops.ts` — pure string transforms (outline, findSection, readSection, documentStats, grepContent, applyReplace, applyEditSection).
- **Create** `server/lib/documents/edit-ops.test.ts` — unit tests for the above.
- **Create** `server/lib/agent/tools.test.ts` — tool-registration/metadata tests (no DB).
- **Modify** `server/services/documents.ts` — add `restoreDoc(id)`.
- **Modify** `server/services/tasks.ts` — add `restoreTask(id)`.
- **Modify** `server/services/memory.ts` — add `unarchiveMemory(id)`.
- **Modify** `server/lib/agent/tools.ts` — add 9 tools + re-voice descriptions.
- **Modify** `server/lib/mcp/server.ts` — server-level `instructions`.
- **Modify** `docs/wiki/mcp.md` — document the new surface.
- **Create** `docs/handovers/2026-06-30-agent-document-tools.md` — handover.
- **Modify** `docs/superpowers/plans/00-roadmap.md` — cycle 40 row.

---

### Task 1: Read-side pure helpers (`edit-ops.ts`)

**Files:**
- Create: `server/lib/documents/edit-ops.ts`
- Test: `server/lib/documents/edit-ops.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `interface Heading { level: number; text: string; line: number }`
  - `outline(content: string): Heading[]`
  - `interface Section { startLine: number; endLine: number; level: number }`
  - `findSection(content: string, heading: string): Section | { error: string }`
  - `interface ReadResult { text: string; startLine: number; endLine: number }`
  - `readSection(content: string, opts: { heading?: string; offset?: number; limit?: number }): ReadResult | { error: string }`
  - `documentStats(content: string): { lineCount: number; charCount: number }`
  - `interface GrepMatch { line: number; text: string; context: { line: number; text: string }[] }`
  - `interface GrepResult { matches: GrepMatch[]; total: number; truncated: boolean }`
  - `grepContent(content: string, pattern: string, opts?: { regex?: boolean; context?: number; max?: number }): GrepResult | { error: string }`

- [ ] **Step 1: Write the failing tests**

```typescript
// server/lib/documents/edit-ops.test.ts
import { describe, it, expect } from 'vitest'
import { outline, findSection, readSection, documentStats, grepContent } from './edit-ops'

const DOC = [
  '# Title',            // 1
  'intro line',         // 2
  '',                   // 3
  '## Alpha',           // 4
  'alpha body',         // 5
  '',                   // 6
  '## Beta',            // 7
  'beta body 1',        // 8
  'beta body 2',        // 9
  '### Beta child',     // 10
  'child body',         // 11
  '## Alpha',           // 12  (duplicate heading → ambiguous)
  'second alpha',       // 13
].join('\n')

describe('outline', () => {
  it('lists ATX headings with 1-indexed lines and levels', () => {
    expect(outline(DOC)).toEqual([
      { level: 1, text: 'Title', line: 1 },
      { level: 2, text: 'Alpha', line: 4 },
      { level: 2, text: 'Beta', line: 7 },
      { level: 3, text: 'Beta child', line: 10 },
      { level: 2, text: 'Alpha', line: 12 },
    ])
  })
  it('ignores # inside fenced code blocks', () => {
    const c = ['# Real', '```', '# not a heading', '```', '## Also real'].join('\n')
    expect(outline(c).map(h => h.text)).toEqual(['Real', 'Also real'])
  })
})

describe('findSection', () => {
  it('spans a section to the next same-or-higher heading', () => {
    // "Beta" (level 2) body runs line 7..9 — stops before its level-3 child? No: child is deeper, so it is INCLUDED. Next level<=2 is line 12.
    expect(findSection(DOC, 'Beta')).toEqual({ startLine: 7, endLine: 11, level: 2 })
  })
  it('errors when the heading is missing', () => {
    expect(findSection(DOC, 'Nope')).toEqual({ error: 'heading not found: "Nope"' })
  })
  it('errors when the heading is ambiguous', () => {
    expect(findSection(DOC, 'Alpha')).toEqual({ error: 'heading "Alpha" is ambiguous (2 matches)' })
  })
})

describe('readSection', () => {
  it('returns a heading section text + span', () => {
    expect(readSection(DOC, { heading: 'Beta' })).toEqual({
      text: ['## Beta', 'beta body 1', 'beta body 2', '### Beta child', 'child body'].join('\n'),
      startLine: 7, endLine: 11,
    })
  })
  it('returns a line window for offset+limit', () => {
    expect(readSection(DOC, { offset: 4, limit: 2 })).toEqual({
      text: ['## Alpha', 'alpha body'].join('\n'), startLine: 4, endLine: 5,
    })
  })
  it('passes through a findSection error', () => {
    expect(readSection(DOC, { heading: 'Nope' })).toEqual({ error: 'heading not found: "Nope"' })
  })
})

describe('documentStats', () => {
  it('counts lines and chars', () => {
    expect(documentStats('a\nb')).toEqual({ lineCount: 2, charCount: 3 })
  })
})

describe('grepContent', () => {
  it('finds substring matches with context', () => {
    const r = grepContent(DOC, 'beta body 1', { context: 1 })
    expect(r).toMatchObject({ total: 1, truncated: false })
    if ('matches' in r) {
      expect(r.matches[0]).toEqual({
        line: 8, text: 'beta body 1',
        context: [{ line: 7, text: '## Beta' }, { line: 9, text: 'beta body 2' }],
      })
    }
  })
  it('supports regex and caps at max', () => {
    const r = grepContent(DOC, '^## ', { regex: true, context: 0, max: 2 })
    expect(r).toMatchObject({ total: 3, truncated: true })
    if ('matches' in r) expect(r.matches.map(m => m.line)).toEqual([4, 7])
  })
  it('returns an error for an invalid regex instead of throwing', () => {
    const r = grepContent(DOC, '(', { regex: true })
    expect('error' in r).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run server/lib/documents/edit-ops.test.ts`
Expected: FAIL — "Cannot find module './edit-ops'".

- [ ] **Step 3: Implement `edit-ops.ts` (read-side)**

```typescript
// server/lib/documents/edit-ops.ts
// Pure string transforms over a document's markdown `content`. No DB, no I/O.
// Line numbers are 1-indexed throughout.

export interface Heading { level: number; text: string; line: number }
export interface Section { startLine: number; endLine: number; level: number }
export interface ReadResult { text: string; startLine: number; endLine: number }
export interface GrepMatch { line: number; text: string; context: { line: number; text: string }[] }
export interface GrepResult { matches: GrepMatch[]; total: number; truncated: boolean }

const ATX = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const FENCE = /^\s*(```|~~~)/

/** ATX headings, skipping fenced code blocks. */
export function outline(content: string): Heading[] {
  const lines = content.split('\n')
  const out: Heading[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (FENCE.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const m = ATX.exec(line)
    if (m) out.push({ level: m[1]!.length, text: m[2]!.trim(), line: i + 1 })
  }
  return out
}

/** The span of a uniquely-named section: heading line → line before the next heading of level <= its own (or EOF). */
export function findSection(content: string, heading: string): Section | { error: string } {
  const heads = outline(content)
  const target = heading.trim()
  const matches = heads.filter(h => h.text === target)
  if (matches.length === 0) return { error: `heading not found: "${heading}"` }
  if (matches.length > 1) return { error: `heading "${heading}" is ambiguous (${matches.length} matches)` }
  const h = matches[0]!
  const next = heads.find(x => x.line > h.line && x.level <= h.level)
  const endLine = next ? next.line - 1 : content.split('\n').length
  return { startLine: h.line, endLine, level: h.level }
}

export function readSection(
  content: string,
  opts: { heading?: string; offset?: number; limit?: number },
): ReadResult | { error: string } {
  const lines = content.split('\n')
  if (opts.heading !== undefined) {
    const sec = findSection(content, opts.heading)
    if ('error' in sec) return sec
    return { text: lines.slice(sec.startLine - 1, sec.endLine).join('\n'), startLine: sec.startLine, endLine: sec.endLine }
  }
  const offset = Math.max(1, opts.offset ?? 1)
  const limit = Math.max(1, opts.limit ?? 200)
  const start = offset - 1
  const end = Math.min(lines.length, start + limit)
  return { text: lines.slice(start, end).join('\n'), startLine: offset, endLine: end }
}

export function documentStats(content: string): { lineCount: number; charCount: number } {
  return { lineCount: content.split('\n').length, charCount: content.length }
}

function contextLines(lines: string[], idx: number, ctx: number): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = []
  for (let j = Math.max(0, idx - ctx); j <= Math.min(lines.length - 1, idx + ctx); j++) {
    if (j === idx) continue
    out.push({ line: j + 1, text: lines[j]! })
  }
  return out
}

export function grepContent(
  content: string,
  pattern: string,
  opts: { regex?: boolean; context?: number; max?: number } = {},
): GrepResult | { error: string } {
  const ctx = opts.context ?? 2
  const max = opts.max ?? 50
  const lines = content.split('\n')
  let test: (s: string) => boolean
  if (opts.regex) {
    let re: RegExp
    try { re = new RegExp(pattern) } catch (e) { return { error: `invalid regex: ${(e as Error).message}` } }
    test = (s) => re.test(s)
  } else {
    test = (s) => s.includes(pattern)
  }
  const hits: number[] = []
  for (let i = 0; i < lines.length; i++) if (test(lines[i]!)) hits.push(i)
  const kept = hits.slice(0, max)
  return {
    matches: kept.map(i => ({ line: i + 1, text: lines[i]!, context: contextLines(lines, i, ctx) })),
    total: hits.length,
    truncated: hits.length > kept.length,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run server/lib/documents/edit-ops.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add server/lib/documents/edit-ops.ts server/lib/documents/edit-ops.test.ts
git commit -m "feat(docs): pure read-side edit-ops (outline/findSection/readSection/grep)"
```

---

### Task 2: Edit-side pure helpers (`edit-ops.ts`)

**Files:**
- Modify: `server/lib/documents/edit-ops.ts` (append two functions)
- Test: `server/lib/documents/edit-ops.test.ts` (append two describe blocks)

**Interfaces:**
- Consumes: `findSection` from Task 1.
- Produces:
  - `applyReplace(content: string, oldStr: string, newStr: string, replaceAll?: boolean): { content: string } | { error: string }`
  - `applyEditSection(content: string, args: { mode: 'append' | 'replace'; text: string; heading?: string }): { content: string } | { error: string }`

- [ ] **Step 1: Write the failing tests (append to the test file)**

```typescript
// append to server/lib/documents/edit-ops.test.ts
import { applyReplace, applyEditSection } from './edit-ops'

describe('applyReplace', () => {
  it('replaces a unique occurrence', () => {
    expect(applyReplace('a foo b', 'foo', 'bar')).toEqual({ content: 'a bar b' })
  })
  it('errors when old_string is absent', () => {
    expect(applyReplace('abc', 'zzz', 'x')).toEqual({ error: 'old_string not found in document' })
  })
  it('errors when old_string is non-unique without replace_all', () => {
    expect(applyReplace('x x x', 'x', 'y')).toEqual({
      error: 'old_string is not unique (3 matches) — add surrounding context or pass replace_all',
    })
  })
  it('replaces all occurrences with replace_all', () => {
    expect(applyReplace('x x x', 'x', 'y', true)).toEqual({ content: 'y y y' })
  })
  it('treats $ in new_string literally (no regex specials)', () => {
    expect(applyReplace('cost is HERE', 'HERE', '$5')).toEqual({ content: 'cost is $5' })
  })
})

describe('applyEditSection', () => {
  const DOC = ['# T', 'intro', '', '## A', 'a body', '', '## B', 'b body'].join('\n')
  it('appends to the end of the document (no heading)', () => {
    const r = applyEditSection(DOC, { mode: 'append', text: 'NEW' })
    expect(r).toEqual({ content: DOC.replace(/\n*$/, '') + '\n\nNEW\n' })
  })
  it('replaces a section body, keeping the heading', () => {
    const r = applyEditSection(DOC, { mode: 'replace', heading: 'A', text: 'fresh a' })
    if ('error' in r) throw new Error(r.error)
    expect(r.content).toBe(['# T', 'intro', '', '## A', 'fresh a', '## B', 'b body'].join('\n'))
  })
  it('appends inside a section, before the next heading', () => {
    const r = applyEditSection(DOC, { mode: 'append', heading: 'A', text: 'more a' })
    if ('error' in r) throw new Error(r.error)
    expect(r.content).toBe(['# T', 'intro', '', '## A', 'a body', '', 'more a', '## B', 'b body'].join('\n'))
  })
  it('errors on replace with no heading', () => {
    expect(applyEditSection(DOC, { mode: 'replace', text: 'x' })).toEqual({
      error: 'replace mode requires a heading; use update_document to replace whole content',
    })
  })
  it('passes through a missing-heading error', () => {
    expect(applyEditSection(DOC, { mode: 'replace', heading: 'Z', text: 'x' })).toEqual({ error: 'heading not found: "Z"' })
  })
})
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `pnpm exec vitest run server/lib/documents/edit-ops.test.ts`
Expected: FAIL — "applyReplace is not a function" / "applyEditSection is not a function".

- [ ] **Step 3: Implement (append to `edit-ops.ts`)**

```typescript
// append to server/lib/documents/edit-ops.ts

function countOccurrences(hay: string, needle: string): number {
  let n = 0, i = 0
  for (;;) { const idx = hay.indexOf(needle, i); if (idx === -1) break; n++; i = idx + needle.length }
  return n
}

/** Exact find/replace with a uniqueness guard (mirrors Claude Code's Edit tool). */
export function applyReplace(
  content: string, oldStr: string, newStr: string, replaceAll?: boolean,
): { content: string } | { error: string } {
  if (oldStr === '') return { error: 'old_string must not be empty' }
  const count = countOccurrences(content, oldStr)
  if (count === 0) return { error: 'old_string not found in document' }
  if (count > 1 && !replaceAll) {
    return { error: `old_string is not unique (${count} matches) — add surrounding context or pass replace_all` }
  }
  if (replaceAll) return { content: content.split(oldStr).join(newStr) } // split/join → no regex/$ specials
  const idx = content.indexOf(oldStr)
  return { content: content.slice(0, idx) + newStr + content.slice(idx + oldStr.length) }
}

/** Structure-aware append/replace by heading. */
export function applyEditSection(
  content: string, args: { mode: 'append' | 'replace'; text: string; heading?: string },
): { content: string } | { error: string } {
  if (args.heading === undefined) {
    if (args.mode === 'replace') return { error: 'replace mode requires a heading; use update_document to replace whole content' }
    return { content: content.replace(/\n*$/, '') + '\n\n' + args.text + '\n' } // append to end of doc
  }
  const sec = findSection(content, args.heading)
  if ('error' in sec) return sec
  const lines = content.split('\n')
  const body = args.text.split('\n')
  if (args.mode === 'replace') {
    // keep the heading line (index sec.startLine-1); replace the body lines startLine..endLine
    const before = lines.slice(0, sec.startLine)   // through the heading line
    const after = lines.slice(sec.endLine)          // from the next heading on
    return { content: [...before, ...body, ...after].join('\n') }
  }
  // append: insert at the end of the section, before the next heading
  const before = lines.slice(0, sec.endLine)
  const after = lines.slice(sec.endLine)
  return { content: [...before, ...body, ...after].join('\n') }
}
```

- [ ] **Step 4: Run to verify all edit-ops tests pass**

Run: `pnpm exec vitest run server/lib/documents/edit-ops.test.ts`
Expected: PASS (Task 1 + Task 2 blocks green).

- [ ] **Step 5: Commit**

```bash
git add server/lib/documents/edit-ops.ts server/lib/documents/edit-ops.test.ts
git commit -m "feat(docs): pure edit-side edit-ops (applyReplace/applyEditSection)"
```

---

### Task 3: Restore helpers in the three services

**Files:**
- Modify: `server/services/documents.ts` (after `deleteDoc`, ~line 151)
- Modify: `server/services/tasks.ts` (after `deleteTask`, ~line 139)
- Modify: `server/services/memory.ts` (after `archiveMemory`, ~line 581)

**Interfaces:**
- Produces: `restoreDoc(id: string): Promise<boolean>`, `restoreTask(id: string): Promise<boolean>`, `unarchiveMemory(id: string): Promise<MemoryDTO | null>`.

DB-touching code → verified by `pnpm typecheck` (no vitest test, per Global Constraints).

- [ ] **Step 1: Add `restoreDoc` to `server/services/documents.ts`**

```typescript
// after deleteDoc (~line 151)
/** Reverse a soft-delete (undo for delete_document). Best-effort: fails if the path is now taken by a live doc. */
export async function restoreDoc(id: string): Promise<boolean> {
  const [r] = await useDb().update(documents).set({ deletedAt: null })
    .where(eq(documents.id, id)).returning({ id: documents.id })
  return !!r
}
```

- [ ] **Step 2: Add `restoreTask` to `server/services/tasks.ts`**

```typescript
// after deleteTask (~line 139)
export async function restoreTask(id: string): Promise<boolean> {
  const [r] = await useDb().update(tasks).set({ deletedAt: null })
    .where(eq(tasks.id, id)).returning({ id: tasks.id })
  return !!r
}
```

- [ ] **Step 3: Add `unarchiveMemory` to `server/services/memory.ts`**

Look at `archiveMemory` (~line 575) and mirror it. It returns `MemoryDTO | null` via the file's existing `toDTO`/return pattern — copy that pattern exactly:

```typescript
// after archiveMemory (~line 581)
export async function unarchiveMemory(id: string): Promise<MemoryDTO | null> {
  const [r] = await useDb().update(memories).set({ archivedAt: null, updatedAt: new Date() })
    .where(eq(memories.id, id)).returning()
  return r ? toDTO(r) : null
}
```

(If `archiveMemory` uses a different return shape than `toDTO(r)`, match whatever it does — read lines 575–582 first.)

- [ ] **Step 4: Verify types**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add server/services/documents.ts server/services/tasks.ts server/services/memory.ts
git commit -m "feat(services): add restoreDoc/restoreTask/unarchiveMemory (undo support)"
```

---

### Task 4: Read tools — `read_document`, `grep_document`

**Files:**
- Modify: `server/lib/agent/tools.ts` (imports at top; insert both tools in the `// ---- documents ----` block, after `get_document` ~line 111)
- Create: `server/lib/agent/tools.test.ts`

**Interfaces:**
- Consumes: `outline`, `readSection`, `documentStats`, `grepContent` (Task 1); `getDoc` (already imported); `toolByName`/`agentTools` (existing exports).
- Produces: two `kind:'read'` tools registered in `agentTools`.

- [ ] **Step 1: Write the failing registration test**

```typescript
// server/lib/agent/tools.test.ts
import { describe, it, expect } from 'vitest'
import { toolByName } from './tools'

describe('read tools', () => {
  it('read_document is a read tool with id/heading/offset/limit', () => {
    const t = toolByName('read_document')
    expect(t?.kind).toBe('read')
    expect(Object.keys(t!.schema)).toEqual(expect.arrayContaining(['id', 'heading', 'offset', 'limit']))
  })
  it('grep_document is a read tool with id/pattern', () => {
    const t = toolByName('grep_document')
    expect(t?.kind).toBe('read')
    expect(Object.keys(t!.schema)).toEqual(expect.arrayContaining(['id', 'pattern']))
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run server/lib/agent/tools.test.ts`
Expected: FAIL — `t` is undefined (tools not registered).

- [ ] **Step 3: Add the import and the two tools**

Add to the top import from documents service (extend the existing line 5 import):

```typescript
import { searchDocs, searchPassages, createDoc, listDocs, getDoc, deleteDoc, updateDoc, moveDoc, restoreDoc } from '../../services/documents'
import { outline, readSection, documentStats, grepContent, applyReplace, applyEditSection } from '../documents/edit-ops'
```

Insert after `get_document` (after line 111), inside the documents block:

```typescript
  {
    name: 'read_document',
    description: 'Read part of a document without pulling the whole body — use this for long docs. With no selector it returns a MAP: the heading outline (with line numbers) + line/char counts, so you can then read just what you need. Pass `heading` for one section, or `offset`+`limit` for a line window. Locate first (this or grep_document), then edit_document.',
    kind: 'read',
    schema: {
      id: z.string().describe('Document id'),
      heading: z.string().optional().describe('Return just this section (exact heading text)'),
      offset: z.number().int().min(1).optional().describe('1-indexed start line for a line window'),
      limit: z.number().int().min(1).optional().describe('Lines to read from offset (default 200)')
    },
    handler: async (a) => {
      const doc = await getDoc(a.id as string)
      if (!doc) return { result: { error: 'document not found' }, summary: 'read_document: not found' }
      const content = doc.content ?? ''
      if (a.heading === undefined && a.offset === undefined) {
        return {
          result: { path: doc.path, title: doc.title, ...documentStats(content), outline: outline(content) },
          summary: `read_document map ${doc.path}`
        }
      }
      const res = readSection(content, {
        heading: a.heading as string | undefined,
        offset: a.offset as number | undefined,
        limit: a.limit as number | undefined
      })
      if ('error' in res) return { result: { error: res.error, outline: outline(content) }, summary: `read_document: ${res.error}` }
      return { result: { path: doc.path, ...res }, summary: `read_document ${doc.path} lines ${res.startLine}-${res.endLine}` }
    }
  },
  {
    name: 'grep_document',
    description: 'Search within ONE document for a pattern (substring by default; set regex:true for a JS regexp). Returns matching lines with line numbers + surrounding context. Use it to find the exact text to pass to edit_document as old_string.',
    kind: 'read',
    schema: {
      id: z.string().describe('Document id'),
      pattern: z.string().min(1).describe('Substring (or regex if regex:true)'),
      regex: z.boolean().optional().describe('Treat pattern as a JS regular expression'),
      context: z.number().int().min(0).max(10).optional().describe('Context lines around each match (default 2)'),
      max: z.number().int().min(1).max(200).optional().describe('Max matches (default 50)')
    },
    handler: async (a) => {
      const doc = await getDoc(a.id as string)
      if (!doc) return { result: { error: 'document not found' }, summary: 'grep_document: not found' }
      const res = grepContent(doc.content ?? '', a.pattern as string, {
        regex: a.regex as boolean | undefined,
        context: a.context as number | undefined,
        max: a.max as number | undefined
      })
      if ('error' in res) return { result: { error: res.error }, summary: `grep_document: ${res.error}` }
      return { result: res, summary: `grep_document (${res.total} matches)` }
    }
  },
```

(Note: the import line adds `updateDoc`, `moveDoc`, `restoreDoc`, `applyReplace`, `applyEditSection` now even though they're used in Tasks 5/6 — that keeps the import edit to one step. If your linter flags unused imports mid-task, that's fine; the repo's lint is non-blocking and Tasks 5/6 consume them.)

- [ ] **Step 4: Run the registration test + typecheck**

Run: `pnpm exec vitest run server/lib/agent/tools.test.ts && pnpm typecheck`
Expected: PASS + 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add server/lib/agent/tools.ts server/lib/agent/tools.test.ts
git commit -m "feat(agent): read_document + grep_document tools"
```

---

### Task 5: Edit tools — `edit_document`, `edit_section`, `update_document`, `move_document`

**Files:**
- Modify: `server/lib/agent/tools.ts` (insert after `save_document`, ~line 137)
- Modify: `server/lib/agent/tools.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `applyReplace`, `applyEditSection` (Task 2); `getDoc`, `updateDoc`, `moveDoc` (services); `publishChange`.
- Produces: four `kind:'create'` tools (ungated), each with `undo` + `publishChange`.

- [ ] **Step 1: Write the failing metadata test (append)**

```typescript
// append to server/lib/agent/tools.test.ts
describe('edit tools', () => {
  it('edit tools are ungated (kind create, not dangerous)', () => {
    for (const name of ['edit_document', 'edit_section', 'update_document', 'move_document']) {
      const t = toolByName(name)
      expect(t, name).toBeDefined()
      expect(t!.kind, name).toBe('create')
      expect(t!.dangerous, name).toBeFalsy()
    }
  })
  it('edit_document takes old_string/new_string/replace_all', () => {
    expect(Object.keys(toolByName('edit_document')!.schema))
      .toEqual(expect.arrayContaining(['id', 'old_string', 'new_string', 'replace_all']))
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run server/lib/agent/tools.test.ts`
Expected: FAIL — the four tools are undefined.

- [ ] **Step 3: Insert the four tools after `save_document`**

```typescript
  {
    name: 'edit_document',
    description: 'Surgically edit a document by exact find/replace (like a code editor\'s edit). `old_string` must appear exactly once (add surrounding lines to disambiguate) unless you pass replace_all. Cheap on long docs — do NOT rewrite the whole document for a small change. Tip: grep_document/read_document to get the exact old_string first.',
    kind: 'create',
    schema: {
      id: z.string().describe('Document id'),
      old_string: z.string().min(1).describe('Exact text to replace (must be unique unless replace_all)'),
      new_string: z.string().describe('Replacement text'),
      replace_all: z.boolean().optional().describe('Replace every occurrence')
    },
    handler: async (a) => {
      const id = a.id as string
      const doc = await getDoc(id)
      if (!doc) return { result: { error: 'document not found' }, summary: 'edit_document: not found' }
      const prior = doc.content ?? ''
      const res = applyReplace(prior, a.old_string as string, a.new_string as string, a.replace_all as boolean | undefined)
      if ('error' in res) return { result: { error: res.error }, summary: `edit_document: ${res.error}` }
      const updated = await updateDoc(id, { content: res.content })
      publishChange({ resource: 'document', action: 'updated', id })
      return {
        result: updated, summary: `edited document ${doc.path}`,
        undo: async () => { await updateDoc(id, { content: prior }); publishChange({ resource: 'document', action: 'updated', id }) }
      }
    }
  },
  {
    name: 'edit_section',
    description: 'Edit a document by markdown heading section. mode:"append" with no heading appends to the end of the doc; with a heading it appends inside that section. mode:"replace" needs a heading and replaces that section\'s body (the heading line is kept). For whole-content or metadata changes use update_document.',
    kind: 'create',
    schema: {
      id: z.string().describe('Document id'),
      mode: z.enum(['append', 'replace']).describe('append or replace a section'),
      text: z.string().describe('Markdown to append / replace with'),
      heading: z.string().optional().describe('Exact heading text (required for replace)')
    },
    handler: async (a) => {
      const id = a.id as string
      const doc = await getDoc(id)
      if (!doc) return { result: { error: 'document not found' }, summary: 'edit_section: not found' }
      const prior = doc.content ?? ''
      const res = applyEditSection(prior, {
        mode: a.mode as 'append' | 'replace', text: a.text as string, heading: a.heading as string | undefined
      })
      if ('error' in res) return { result: { error: res.error, outline: outline(prior) }, summary: `edit_section: ${res.error}` }
      const updated = await updateDoc(id, { content: res.content })
      publishChange({ resource: 'document', action: 'updated', id })
      return {
        result: updated, summary: `edited section of ${doc.path}`,
        undo: async () => { await updateDoc(id, { content: prior }); publishChange({ resource: 'document', action: 'updated', id }) }
      }
    }
  },
  {
    name: 'update_document',
    description: 'Update a document\'s whole content and/or metadata (title, frontmatter, tags, domain, type). Passing `project` (a slug) files/associates it under /projects/<slug>/. For a small content change prefer edit_document; to relocate by explicit path use move_document. At least one field is required.',
    kind: 'create',
    schema: {
      id: z.string().describe('Document id'),
      content: z.string().optional().describe('New whole-document markdown body'),
      title: z.string().optional(),
      frontmatter: z.record(z.string(), z.unknown()).optional(),
      tags: z.array(z.string()).optional(),
      domain: z.string().optional(),
      type: z.string().optional(),
      project: z.string().optional().describe('Project slug to file/associate under')
    },
    handler: async (a) => {
      const id = a.id as string
      const doc = await getDoc(id)
      if (!doc) return { result: { error: 'document not found' }, summary: 'update_document: not found' }
      const { id: _id, ...patch } = a
      if (Object.keys(patch).length === 0) return { result: { error: 'no fields to update' }, summary: 'update_document: empty' }
      const updated = await updateDoc(id, patch as Record<string, unknown>)
      publishChange({ resource: 'document', action: 'updated', id })
      // Undo restores prior content + metadata + original path (path wins → also reverses an assign-project relocate).
      const prior = doc
      return {
        result: updated ?? { error: 'not found', id }, summary: `updated document ${doc.path}`,
        undo: async () => {
          await updateDoc(id, {
            path: prior.path, title: prior.title ?? undefined, content: prior.content ?? '',
            frontmatter: prior.frontmatter, tags: prior.tags ?? [],
            domain: prior.domain ?? undefined, type: prior.type ?? undefined
          })
          publishChange({ resource: 'document', action: 'updated', id })
        }
      }
    }
  },
  {
    name: 'move_document',
    description: 'Move or rename a document to a new absolute path (must start with "/"). Filing it under /projects/<slug>/... associates it with that project. Reversible.',
    kind: 'create',
    schema: {
      id: z.string().describe('Document id'),
      path: z.string().regex(/^\//, 'path must start with /').describe('New absolute path, e.g. /projects/mymind/notes.md')
    },
    handler: async (a) => {
      const id = a.id as string
      const doc = await getDoc(id)
      if (!doc) return { result: { error: 'document not found' }, summary: 'move_document: not found' }
      const prior = doc.path
      const updated = await moveDoc(id, a.path as string)
      publishChange({ resource: 'document', action: 'updated', id })
      return {
        result: updated, summary: `moved document to ${a.path}`,
        undo: async () => { await moveDoc(id, prior); publishChange({ resource: 'document', action: 'updated', id }) }
      }
    }
  },
```

Note: `update_document`'s undo references `outline` (from Task 4's import) via `edit_section` — ensure `outline` is imported (it is, from Task 4's import line).

- [ ] **Step 4: Run metadata test + typecheck**

Run: `pnpm exec vitest run server/lib/agent/tools.test.ts && pnpm typecheck`
Expected: PASS + 0 type errors. (If `z.record(z.string(), z.unknown())` errors on the installed Zod v4, use `z.record(z.unknown())` — check the signature used elsewhere in the file for frontmatter-like fields.)

- [ ] **Step 5: Commit**

```bash
git add server/lib/agent/tools.ts server/lib/agent/tools.test.ts
git commit -m "feat(agent): edit_document/edit_section/update_document/move_document"
```

---

### Task 6: Delete tools — `delete_document`, `delete_task`, `forget_memory`

**Files:**
- Modify: `server/lib/agent/tools.ts` (imports; insert `delete_document` in the documents block; `delete_task` in the tasks block; `forget_memory` in the memory block)
- Modify: `server/lib/agent/tools.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `deleteDoc`/`restoreDoc`, `deleteTask`/`restoreTask`, `archiveMemory`/`unarchiveMemory`.
- Produces: three `kind:'destructive'` tools (NOT `dangerous`), each with `undo`.

- [ ] **Step 1: Write the failing metadata test (append)**

```typescript
// append to server/lib/agent/tools.test.ts
describe('delete tools', () => {
  it('delete tools are destructive but not hard-gated', () => {
    for (const name of ['delete_document', 'delete_task', 'forget_memory']) {
      const t = toolByName(name)
      expect(t, name).toBeDefined()
      expect(t!.kind, name).toBe('destructive')
      expect(t!.dangerous, name).toBeFalsy() // never dangerous → stays MCP-exposed, no approval channel needed
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run server/lib/agent/tools.test.ts`
Expected: FAIL — the three tools are undefined.

- [ ] **Step 3: Extend imports and add the three tools**

Extend the memory-service import (line 4) and tasks-service import (line 7):

```typescript
import { searchMemories, createMemory, listMemories, archiveMemory, unarchiveMemory } from '../../services/memory'
import { createTask, listTasks, updateTask, getTask, deleteTask, restoreTask } from '../../services/tasks'
```

Add `delete_document` in the documents block (e.g. right after `move_document`):

```typescript
  {
    name: 'delete_document',
    description: 'Soft-delete a document. Reversible — undo restores it. Use for cleanup of docs the agent created or that are obsolete.',
    kind: 'destructive',
    schema: { id: z.string().describe('Document id') },
    handler: async (a) => {
      const id = a.id as string
      const doc = await getDoc(id)
      if (!doc) return { result: { error: 'document not found' }, summary: 'delete_document: not found' }
      await deleteDoc(id)
      publishChange({ resource: 'document', action: 'deleted', id })
      return {
        result: { ok: true, id, path: doc.path }, summary: `deleted document ${doc.path}`,
        undo: async () => { await restoreDoc(id); publishChange({ resource: 'document', action: 'created', id }) }
      }
    }
  },
```

Add `delete_task` in the tasks block (after `edit_task`):

```typescript
  {
    name: 'delete_task',
    description: 'Soft-delete a task. Reversible — undo restores it.',
    kind: 'destructive',
    schema: { id: z.string().describe('Task id') },
    handler: async (a) => {
      const id = a.id as string
      const ok = await deleteTask(id)
      if (!ok) return { result: { error: 'task not found' }, summary: 'delete_task: not found' }
      publishChange({ resource: 'task', action: 'deleted', id })
      return {
        result: { ok: true, id }, summary: 'deleted task',
        undo: async () => { await restoreTask(id); publishChange({ resource: 'task', action: 'updated', id }) }
      }
    }
  },
```

Add `forget_memory` in the memory block (after `save_memory`):

```typescript
  {
    name: 'forget_memory',
    description: 'Archive a memory so it no longer surfaces in search/recall. Reversible — undo unarchives it. Use to retire a fact that is wrong or obsolete.',
    kind: 'destructive',
    schema: { id: z.string().describe('Memory id') },
    handler: async (a) => {
      const id = a.id as string
      const m = await archiveMemory(id)
      if (!m) return { result: { error: 'memory not found' }, summary: 'forget_memory: not found' }
      publishChange({ resource: 'memory', action: 'deleted', id })
      return {
        result: { ok: true, id }, summary: 'archived memory',
        undo: async () => { await unarchiveMemory(id); publishChange({ resource: 'memory', action: 'updated', id }) }
      }
    }
  },
```

- [ ] **Step 4: Run metadata test + typecheck**

Run: `pnpm exec vitest run server/lib/agent/tools.test.ts && pnpm typecheck`
Expected: PASS + 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add server/lib/agent/tools.ts server/lib/agent/tools.test.ts
git commit -m "feat(agent): delete_document/delete_task/forget_memory (undo-backed)"
```

---

### Task 7: Server instructions + description re-voice

**Files:**
- Modify: `server/lib/mcp/server.ts`
- Modify: `server/lib/agent/tools.ts` (description strings only)

**Interfaces:**
- Consumes: `McpServer` (SDK `ServerOptions.instructions` — verified available).
- Produces: no new tools; behavior-only (server instructions + copy).

- [ ] **Step 1: Add server-level `instructions`**

Replace the `buildMcpServer` server construction in `server/lib/mcp/server.ts`:

```typescript
const MCP_INSTRUCTIONS = `MyMind is Tony's second brain — a persistent, cross-session store of his documents, memories, tasks, and projects.

Work with it, not around it:
- Before answering from your own recollection, SEARCH here first (search_memories, search_docs, search_passages). What you remember may be stale; this is the source of truth.
- Persist durable outcomes: save_memory for a one-sentence fact; save_document for substantive work. File things under their project (pass a project slug).
- Edit in place. For a long document, read_document (outline/section) or grep_document to locate, then edit_document (exact find/replace) or edit_section — do NOT rewrite a whole document for a small change.
- Keep it tidy: move_document to file, delete_document / delete_task / forget_memory to retire. All are reversible via undo.

Records here outlive this conversation — keep them accurate and well-filed.`

export function buildMcpServer() {
  const server = new McpServer({ name: 'mymind', version: '1.0.0' }, { instructions: MCP_INSTRUCTIONS })
  for (const tool of agentTools) {
    if (tool.dangerous) continue // MCP has no approval channel — never expose a gated tool here
    server.tool(tool.name, tool.description, tool.schema, async (args: Record<string, unknown>) => {
      const ac = new AbortController()
      const exec = await tool.handler(args, { signal: ac.signal })
      return { content: [{ type: 'text' as const, text: JSON.stringify(exec.result) }] }
    })
  }
  return server
}
```

- [ ] **Step 2: Re-voice the existing terse descriptions (string edits in `tools.ts`)**

Apply these exact description replacements (the tools already exist; only the `description:` string changes):

- `search_memories`: `'Search Tony\'s durable memories (semantic + keyword). Check here before answering from your own recollection — these are facts distilled from every past session.'`
- `get_recent_memories`: `'List recent memories, newest first (optionally by scope). A quick way to see what\'s top-of-mind before you act.'`
- `search_docs`: `'Semantic + keyword search over stored documents — search here before creating a new one to avoid duplicates. Pass `project` (a slug) to scope to one project.'`
- `list_documents`: `'List documents, newest first. Pass `project` (a slug) to list only that project\'s docs. Use search_docs when you know what you\'re looking for.'`
- `get_document`: `'Get a whole document by id (full Markdown + frontmatter). For a long document, prefer read_document (outline/section) or grep_document so you don\'t pull the entire body.'`
- `save_document`: `'Create a Markdown document. Search first (search_docs) to avoid duplicates. Pass `project` (a slug) to file it under /projects/<slug>/ and associate it; otherwise it lands in /input for triage. Prefer this over quick_capture for anything substantive or project-scoped; to change an existing doc use edit_document/update_document.'`
- `search_tasks`: `'List tasks (optionally by status or project). Check existing tasks before creating one, and when deciding what to work on.'`
- `create_task`: `'Create a task. Record follow-ups and deferred work here so it isn\'t lost between sessions. Search first to avoid duplicates.'`
- `search_projects`: `'List projects (optionally active-only). Projects are the top-level buckets everything files under.'`

(Leave `save_memory`, `edit_task`, `edit_project`, `create_project`, `get_project`, `search_passages`, `quick_capture`, and the web/image tools as-is — they already read well or were set this cycle.)

- [ ] **Step 3: Typecheck + full test suite**

Run: `pnpm typecheck && pnpm test`
Expected: 0 type errors; full suite green (edit-ops + tools registration + all prior tests).

- [ ] **Step 4: Build**

Run: `pnpm build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add server/lib/mcp/server.ts server/lib/agent/tools.ts
git commit -m "feat(mcp): second-brain server instructions + re-voiced tool descriptions"
```

---

### Task 8: E2E round-trip + docs (wiki, handover, roadmap)

**Files:**
- Create: `docs/handovers/2026-06-30-agent-document-tools.md`
- Modify: `docs/wiki/mcp.md`
- Modify: `docs/superpowers/plans/00-roadmap.md` (add the cycle 40 row)

**Interfaces:** none (validation + docs).

- [ ] **Step 1: Prove the surface end-to-end (browser-testing skill)**

Use the `browser-testing` skill / `playwright-cli` against `pnpm dev`. Because MCP calls go through the same `agentTools` handlers the HTTP API uses, drive the round-trip via authenticated `fetch` to the document endpoints (which call the same services) AND verify the tool handlers directly where possible. Concretely, in the dev app:

1. Create a doc (`POST /api/documents` or `save_document`) with a multi-section markdown body.
2. Confirm `read_document` with no selector returns an `outline` with the right headings/line numbers, and `charCount`/`lineCount`.
3. `grep_document` for a known phrase → correct line number + context.
4. `edit_document` (find/replace a unique string) → GET the doc, assert the change; assert a non-unique old_string returns an error (no throw).
5. `edit_section` replace a section → assert only that section changed.
6. `move_document` to `/projects/<slug>/...` → assert path + project association updated.
7. `delete_document` → assert it drops out of `list_documents`/`search_docs`; run its `undo` (or `restoreDoc`) → reappears.

Record evidence (assertions/screenshots) in the handover. Fix any failures before proceeding.

- [ ] **Step 2: Update the wiki (`docs/wiki/mcp.md`)**

Bump the tool list to the real current surface: add the 9 new tools with one-line descriptions, note the server-level `instructions`, and the `kind` policy (edits `create`/ungated, deletes `destructive`/not-`dangerous`, only `dangerous` is hidden from MCP). Ensure `status`/date reflect this change.

- [ ] **Step 3: Write the handover (`docs/handovers/2026-06-30-agent-document-tools.md`)**

Accurate frontmatter (title, date, status, branch `feat/agent-doc-tools`, cycle 40). Cover: what shipped (the 9 tools + restore helpers + instructions + re-voice), the pure `edit-ops` module + test coverage, the gates (`typecheck 0` / `test <N>` / `build`), the E2E evidence, and the non-goals/deferrals (no migration; no UI; multi-doc/bulk ops deferred).

- [ ] **Step 4: Add the roadmap row**

In `docs/superpowers/plans/00-roadmap.md`, add a cycle 40 row linking the spec, this plan, and the handover, with the shipped summary + gate counts.

- [ ] **Step 5: Final gates + commit**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all green.

```bash
git add docs/wiki/mcp.md docs/handovers/2026-06-30-agent-document-tools.md docs/superpowers/plans/00-roadmap.md
git commit -m "docs(agent): wiki + handover + roadmap for agent-usable document tools (cycle 40)"
```

---

## Self-Review

**Spec coverage:**
- Surgical edit (find/replace) → Task 2 (`applyReplace`) + Task 5 (`edit_document`). ✓
- Section ops (consolidated `edit_section`) → Task 2 (`applyEditSection`) + Task 5. ✓
- Whole-content/metadata update + assign-project → Task 5 (`update_document`). ✓
- Move/rename → Task 5 (`move_document`). ✓
- Long-doc reads (outline/section/range + in-doc grep) → Task 1 + Task 4 (`read_document`, `grep_document`). ✓
- Delete doc + parallel cleanup (task/memory) → Task 3 (restore helpers) + Task 6. ✓
- Ungated edits / destructive deletes / no `dangerous` → enforced in Tasks 5/6 + metadata tests. ✓
- Undo + `publishChange` on every mutation → Tasks 5/6 handlers. ✓
- Server `instructions` + description re-voice → Task 7. ✓
- No migration; auto re-index via `content_hash` → inherent (handlers call `updateDoc`). ✓
- E2E + wiki + handover + roadmap → Task 8. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; tests have real assertions. ✓

**Type consistency:** `applyReplace`/`applyEditSection`/`readSection`/`grepContent`/`outline`/`documentStats` signatures match between Task 1/2 definitions and Task 4/5 call sites. Service helpers `restoreDoc`/`restoreTask`/`unarchiveMemory` (Task 3) match Task 6 call sites. Import lines in Task 4 pre-add symbols consumed in Tasks 5/6 (noted). ✓
