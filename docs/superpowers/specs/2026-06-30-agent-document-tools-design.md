---
title: Agent-usable document tools — surgical edit / read / move / delete + second-brain descriptions
status: approved (2026-06-30)
date: 2026-06-30
cycle: 40
related:
  - docs/wiki/mcp.md (the MCP tool surface — update in the same change)
  - server/lib/agent/tools.ts (tool registry — shared by MCP + in-app Bridget)
  - server/services/documents.ts (existing CRUD the tools wrap; updateDoc/moveDoc/deleteDoc already exist)
  - server/lib/mcp/server.ts (MCP registration; ServerOptions.instructions verified available)
---

# Agent-usable document tools

## Problem

The MCP/agent tool surface exposes documents as **create-and-read only**:
`save_document`, `quick_capture` (create) and `search_docs`, `search_passages`,
`list_documents`, `get_document` (read). There is **no way for an agent to edit,
move, or delete a document**, and the only read (`get_document`) returns the entire
body — unusable on a long document. The backend already supports all of this
(`updateDoc`, `moveDoc`, `deleteDoc` soft-delete, used by the web UI); the gap is
purely the agent-facing tool surface.

Separately, the existing tool descriptions are terse (e.g. *"Semantic + keyword
search over stored memories."*) and do little to steer an agent toward actually
using MyMind as a second brain — searching before answering, persisting durable
work, filing under projects.

## Goals

1. Make documents fully **agent-editable** with a surface that is cheap on long
   docs: locate → read a slice → surgically patch, without ever round-tripping the
   whole body.
2. Round out **delete/move** for documents and fill the parallel cleanup gaps
   (`delete_task`, `forget_memory`) so the agent's CRUD across the memory/docs/tasks
   triad is symmetric.
3. **Re-voice** the tool descriptions and add a server-level `instructions` preamble
   so agents reliably reach for memory/docs/tasks.

## Non-goals

- No DB migration, no new schema/columns, no new service data model — this cycle is
  thin wrappers + pure string helpers + copy.
- No chunk-level *editing* (chunks are derived; edits re-index automatically via the
  existing embed/chunk cron on `content_hash` drift).
- No UI changes (this is the agent/MCP surface, not the `/documents` editor).
- No bulk/multi-document operations.
- No `dangerous:true` hard-gating on any new tool.

## Decisions (locked in brainstorm 2026-06-30)

- **Maximal edit surface**: find/replace + section ops + whole-content update.
- **Long-doc reads**: add both a section/range read and an in-doc grep.
- **Symmetry**: also add `delete_task` and `forget_memory`.
- **Edits ungated**: the only hard runtime gate is `dangerous:true` (checked at
  `server/lib/agent/ai-tools.ts:35`). `kind:destructive` is *descriptive only* today
  (it drives the "confirm with the user" phrasing + signals undo). To honor "leave
  edits ungated" **robustly** — even if someone later gates on `kind`:
  - **Edit tools use `kind:create`** (structurally ungated write; no confirm-language).
  - **Delete tools use `kind:destructive`** (accurate: removal; still not `dangerous`,
    so not hard-gated; description notes the action is reversible via undo).
- **Consolidate** the section operations: `append_to_document` + `replace_section`
  collapse into one `edit_section` tool with a `mode`.

## Tool surface (9 new tools)

All tools live in `server/lib/agent/tools.ts`, are auto-exposed to the MCP server
(all except `dangerous` ones) **and** in-app Bridget, and every mutation calls
`publishChange({ resource, action, id })` after commit (live-data rule) and returns
an `undo`.

### Reads (`kind:read`)

**`read_document(id, { heading?, offset?, limit? })`** — long-doc-friendly read.
- No selector → returns a **map**, not the body: `{ path, title, lineCount, charCount,
  outline: [{ level, text, line }] }` (heading outline with line numbers). This lets
  the agent narrow before pulling text.
- `heading` (string) → the text of just that section (heading line through the line
  before the next heading of the same-or-higher level), plus its `{ startLine, endLine }`.
- `offset` (1-indexed line) + `limit` (line count) → that line window.
- `heading` and `offset` are mutually exclusive; if both are given, `heading` wins.
- Errors: `{ error: 'heading not found: "<h>"' }` (with the outline attached so the
  agent can retry). Missing doc → `{ error: 'document not found' }`.

**`grep_document(id, pattern, { regex?, context?, max? })`** — search within one doc.
- Default substring match; `regex:true` compiles `pattern` as a JS regex (invalid regex
  → `{ error }`, never throws). `context` (default 2) = lines of surrounding context.
  `max` (default 50) caps matches; result reports `truncated:true` when capped.
- Returns `{ matches: [{ line, text, context: [{ line, text }] }], total, truncated }`.
- Pairs with `edit_document`: grep to find the exact unique string, then patch it.

### Edits (`kind:create` — ungated writes, undo-backed)

**`edit_document(id, old_string, new_string, replace_all?)`** — the workhorse. Exact
find/replace, mirroring Claude Code's `Edit`.
- `old_string` absent → `{ error: 'old_string not found in document' }`.
- `old_string` matches >1 time and `replace_all` is not `true` →
  `{ error: 'old_string is not unique (N matches) — add surrounding context or pass
  replace_all' }`.
- `replace_all:true` replaces every occurrence.
- On success: `updateDoc(id, { content })`; returns the updated `DocumentDTO`.

**`edit_section(id, { mode, text, heading? })`** — structure-aware edit (consolidates
append + replace-section).
- `mode:'append'`, no `heading` → append `text` to the end of the document.
- `mode:'append'`, `heading` → append `text` to the end of that section (before the
  next same/higher heading).
- `mode:'replace'`, `heading` → replace that section's **body** (the heading line is
  preserved; `text` becomes the content beneath it).
- `mode:'replace'` with no `heading` → `{ error }` (that is `update_document`'s job).
- Heading absent/ambiguous (repeated identical heading) → `{ error }` with the outline.

**`update_document(id, { title?, content?, frontmatter?, tags?, domain?, type?, project? })`**
— whole-content replace + metadata edits. Passing `project` relocates the doc under
`/projects/<slug>/` (assign-project; `updateDoc`'s existing path-wins logic). No `path`
field here — use `move_document`. At least one field required.

**`move_document(id, path)`** — relocate/rename by explicit path (must start with `/`).
Wraps `moveDoc`. Reversible (undo moves it back).

### Deletes (`kind:destructive` — not hard-gated; reversible)

**`delete_document(id)`** — soft-delete (`deleteDoc`; sets `deletedAt`). Undo restores.
**`delete_task(id)`** — soft-delete a task (`deleteTask`). Undo restores.
**`forget_memory(id)`** — archive a memory (`archiveMemory`; sets `archivedAt`). Undo
unarchives.

### Undo & restore helpers

Undo requires un-soft-delete, which the services don't yet expose. Add three one-line
helpers:
- `restoreDoc(id)` in `documents.ts` — `set({ deletedAt: null })` where id matches.
- `restoreTask(id)` in `tasks.ts` — `set({ deletedAt: null })`.
- `unarchiveMemory(id)` in `memory.ts` — `set({ archivedAt: null })`.

Undo contracts per tool:
- `edit_document` / `edit_section` / `update_document`: capture prior `content` (and
  for `update_document`, prior metadata/path) → undo re-applies via `updateDoc`.
- `move_document`: capture prior `path` → undo `moveDoc(id, priorPath)`.
- `delete_*` / `forget_memory`: undo calls the matching restore helper.
- Every undo re-emits the inverse `publishChange`.

## Architecture

### Pure edit-ops module — `server/lib/documents/edit-ops.ts`

All string transforms, **zero DB**, unit-tested first (TDD). Operate on and return the
document `content` string; the tool handlers do the DB I/O around them.

```
outline(content): { level, text, line }[]                       // markdown ATX headings
readSection(content, { heading?, offset?, limit? }): { text, startLine, endLine } | { error }
grepContent(content, pattern, opts): { matches, total, truncated }
applyReplace(content, oldStr, newStr, replaceAll): { content } | { error }   // uniqueness-checked
applyEditSection(content, { mode, text, heading? }): { content } | { error }
findSection(content, heading): { startLine, endLine, level } | null           // internal
```

Contracts: line numbers are 1-indexed; a "section" runs from its heading line to the
line before the next heading whose level ≤ the section heading's level (or EOF). Repeated
identical headings are treated as ambiguous (error) rather than silently picking the
first. Operates on `\n`-split lines; preserves the document's existing newline content.

### Handler shape

Each mutation handler is trivial and uniform:

```
const doc = await getDoc(id)                        // 404 → { result: { error }, summary }
if (!doc) return notFound
const out = applyX(doc.content, ...args)            // pure
if ('error' in out) return { result: { error: out.error }, summary }
const updated = await updateDoc(id, { content: out.content })
publishChange({ resource: 'document', action: 'updated', id })
return { result: updated, summary, undo: async () => { await updateDoc(id, { content: doc.content }); publishChange(...) } }
```

`updateDoc` already recomputes `content_hash`, so the embed/chunk cron re-indexes the
edited doc automatically — edits stay searchable with no extra work here.

### Failure policy

Tool handlers **never throw** for expected outcomes (not-found, no-match, ambiguous,
invalid regex) — they return `{ result: { error }, summary }` so the model can react and
the activity log doesn't record a spurious error-severity row (matches the `web_fetch` /
`edit_image` convention). Only genuinely unexpected infra failures propagate.

## Descriptions & server instructions

### Server-level `instructions` (`buildMcpServer`)

Set `new McpServer({ name, version }, { instructions })` — verified supported by the SDK
(`ServerOptions.instructions`). Short preamble establishing the second-brain workflow,
e.g.:

> MyMind is Tony's second brain — a persistent store of his documents, memories, tasks,
> and projects across every session. Before answering from your own recollection, SEARCH
> here (`search_memories`, `search_docs`). Persist durable facts with `save_memory` and
> substantive work as documents; file everything under its project. Prefer surgical
> `edit_document` over rewriting whole documents. Records here outlive this conversation —
> keep them accurate.

### Re-voiced tool descriptions

Rewrite the memory / document / task / project tool descriptions with *when-to-use*
guidance and cross-references. Representative rewrites:

- `search_memories` → "…**Check here before answering from your own recollection** — these
  are durable facts from every past session."
- `save_document` → "…**Search first (`search_docs`) to avoid duplicates.** Prefer this
  over `quick_capture` for anything substantive or project-scoped; pass `project` to file
  and associate it."
- `search_tasks` / `create_task` → nudge to check existing tasks and record deferred work.
- New edit tools carry explicit long-doc guidance ("read/grep to locate the exact string
  first, then patch — do not fetch the whole document to make a small change").

Web/image tool descriptions already read well and are left unchanged.

## Testing & gates

- **TDD** on `edit-ops.ts`: uniqueness enforcement, replace_all, section boundary math
  (nested/repeated/absent headings, EOF sections), outline extraction, grep
  (substring/regex/invalid-regex/context/cap), readSection windows. New unit-test file.
- Handler-level: not-found, error-passthrough, undo round-trips, `publishChange` emitted.
- Gates: `pnpm typecheck` 0 · full `pnpm test` green (new tests added) · `pnpm build`.
- **Playwright E2E** driving a full MCP round-trip against the dev app:
  create → `read_document` (outline) → `grep_document` → `edit_document` →
  `edit_section` → `move_document` → `delete_document` → undo/restore, asserting each
  step and that the edited doc re-appears in `search_docs`.

## Rollout

Ships as **Cycle 40**. Same-change updates: `docs/wiki/mcp.md` (the real, current tool
list + server instructions), a handover in `docs/handovers/`, and the roadmap row. No
migration → no deploy-time DB step.
