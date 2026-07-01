---
title: Agent-usable document tools — surgical edit / read / move / delete + second-brain descriptions — Cycle 40
cycle: 40
date: 2026-06-30
status: built + gates green + controller-run live E2E PASS — final whole-branch review PENDING
branch: feat/agent-doc-tools (off master c6600782; subagent-driven, 7 impl tasks + docs)
spec: ../superpowers/specs/2026-06-30-agent-document-tools-design.md
plan: ../superpowers/plans/2026-06-30-agent-document-tools.md
docs:
  - ../wiki/mcp.md (tool list 20→29, server instructions, kind policy, edit-ops module)
  - ../superpowers/plans/00-roadmap.md (cycle-40 row)
problem: >
  The MCP/agent surface exposed documents as create-and-read only (save_document, quick_capture, search_docs,
  search_passages, list_documents, get_document). No agent-facing edit, move, or delete existed; the only read
  (get_document) returns the full body — unusable on long documents. The backend already supported all of this
  (updateDoc/moveDoc/deleteDoc, used by the web UI); the gap was purely the agent-facing tool surface. Separately,
  tool descriptions were terse and did not steer agents toward MyMind as a second brain.
keydecision: >
  Edit tools use kind:create (structurally ungated writes, never blocked even if kind:destructive gets gated
  later). Delete tools use kind:destructive (accurate; not dangerous; reversible via undo). Only dangerous:true
  hard-gates a tool and hides it from MCP. No tool in this cycle is dangerous. Section ops consolidated into
  one edit_section tool (mode:'append'|'replace') rather than two separate tools.
shipped:
  - "**Pure `edit-ops.ts` module** (`server/lib/documents/edit-ops.ts`, 26 unit tests): `outline`, `findSection`, `readSection`, `documentStats`, `grepContent`, `applyReplace`, `applyEditSection`. Zero DB — operates on and returns the doc `content` string; tool handlers do DB I/O around them. TDD-first."
  - "**Restore helpers**: `restoreDoc(id)` in `documents.ts`, `restoreTask(id)` in `tasks.ts`, `unarchiveMemory(id)` in `memory.ts` — each a one-line `set({ deletedAt/archivedAt: null })` un-soft-delete, required by the delete tools' undo contracts."
  - "**9 new agent tools** in `server/lib/agent/tools.ts` (auto-exposed to MCP + in-app Bridget):"
  - "  • read_document(id, { heading?, offset?, limit? }) — kind:read. No selector → outline map + lineCount/charCount; heading → that section text + {startLine,endLine}; offset+limit → line window. Errors include the outline so the agent can retry."
  - "  • grep_document(id, pattern, { regex?, context?, max? }) — kind:read. Substring or regex (invalid regex → {error}, no throw); context lines; max cap with truncated flag."
  - "  • edit_document(id, old_string, new_string, replace_all?) — kind:create. Exact find/replace (non-unique → {error}; replace_all replaces all). The surgical workhorse — mirrors CC's Edit tool."
  - "  • edit_section(id, { mode, text, heading? }) — kind:create. mode:'append' (no heading=end-of-doc; heading=end-of-section) / mode:'replace' (heading required, replaces body, keeps heading line)."
  - "  • update_document(id, { title?, content?, frontmatter?, tags?, domain?, type?, project? }) — kind:create. Whole-content + metadata; project slug relocates doc under /projects/<slug>/."
  - "  • move_document(id, path) — kind:create. Explicit absolute-path relocate/rename."
  - "  • delete_document(id) — kind:destructive. Soft-delete; undo restores."
  - "  • delete_task(id) — kind:destructive. Soft-delete a task; undo restores."
  - "  • forget_memory(id) — kind:destructive. Archive a memory; undo unarchives."
  - "**Every mutation** returns an `undo` and calls `publishChange({ resource, action, id })` after commit (live-data rule). Handlers never throw for expected outcomes (not-found, no-match, ambiguous, invalid regex) — they return `{ result: { error }, summary }` so the model can react."
  - "**Server-level MCP `instructions`** (`MCP_INSTRUCTIONS` const in `server/lib/mcp/server.ts`, passed as `new McpServer(info, { instructions })`): establishes second-brain workflow — search before answering, persist durable facts, file under projects, prefer surgical edit_document."
  - "**Description re-voice**: search_memories, get_recent_memories, search_docs, list_documents, get_document, save_document, search_tasks, create_task, search_projects rewritten with when-to-use guidance and cross-references."
  - "**test/agent-tools.test.ts** updated to assert the full 29-tool `toEqual` list."
verified:
  - "Gates: **typecheck 0 · pnpm test 701/701 passing (109 files) · pnpm build succeeds**. Includes edit-ops 26 unit tests + handler-level tests + tools-registration assertion."
  - "Live E2E (controller-run, 2026-06-30): drove the real MCP StreamableHTTP endpoint (`/api/mcp`) with bearer token via the MCP client SDK — the exact path an external Claude Code agent uses. 28/28 assertions:"
  - "  tools/list → 29 tools (all 9 new ones present)."
  - "  save_document → read_document map (3 headings, lineCount 9) → read_document heading=Section A (correct section) → grep_document 'needle'→line 5 → edit_document unique replace (verified via get_document) → edit_document non-unique → {error: 'old_string is not unique (3 matches)…'} (no throw) → edit_document replace_all (all 3 replaced) → edit_section append under heading → update_document tags+project → relocated to /projects/mymind/… → move_document → /input/moved-e2e.md → delete_document → get_document returns null."
  - "  delete_task round-trip: create → delete (ok) → delete again → {error} (no throw)."
  - "  Dev corpus cleaned up; dev server stopped."
  - "Built subagent-driven (7 impl tasks + docs task): Task1 (edit-ops TDD) → Task2 (edit-ops advanced + applyEditSection) → Task3 (restore helpers) → Task4 (read_document + grep_document handlers) → Task5 (edit_document + edit_section + update_document + move_document) → Task6 (delete_document + delete_task + forget_memory) → Task7 (server instructions + description re-voice). Per-task two-verdict reviews; typecheck green throughout."
followups:
  - "**Final whole-branch review (opus)** — pending at handover time; run before merge."
  - "**Minors deferred (from SDD ledger):** edit-ops readSection({}) empty-opts path is defined but untested; findSection double-splits on EOF branch (negligible); no test for applyReplace('','x') empty-oldStr guard (guard is present); update_document declares `const prior = doc` AFTER the updateDoc call (cosmetic; doc is captured pre-mutation so correct — move above mutation for clarity)."
  - "**Deploy** — push master → CD (native systemd LXC 114). No migration; no env change. `pnpm install` + `pnpm build` suffice."
  - "**Non-goals / deferred**: no UI changes (/documents editor unchanged); no bulk/multi-doc ops; no chunk-level editing (chunks re-index automatically via content_hash drift); undo is an in-app-agent-loop feature, not an MCP call exposed externally; no dangerous:true tools added."
---

# Agent-usable document tools — Cycle 40

## Why

The agent/MCP surface exposed documents as **create-and-read only** — no way to edit, move, or
delete. The only read (`get_document`) returns the entire body, which is unusable on long documents.
The backend already supported all of this (used by the web UI); the gap was purely the agent-facing
tool surface. Separately, tool descriptions were terse and didn't steer agents toward MyMind as a
second brain.

## What shipped

Seven subagent-driven implementation tasks: a pure `edit-ops.ts` helper module (TDD-first, 26 unit
tests) → restore helpers for undo → read + grep handlers → edit/update/move handlers → delete handlers
→ server instructions + description re-voice.

**9 new tools** (see frontmatter `shipped` for the full list). Highlights:
- `read_document` with no selector returns an **outline + stats map**, not the body — agents narrow
  before pulling text. With `heading` or `offset`+`limit`, returns a slice.
- `grep_document` for substring or regex search within one doc (invalid regex → `{error}`, never
  throws) — pairs with `edit_document` to locate the unique string before patching.
- `edit_document` is the workhorse: exact find/replace, non-unique `old_string` → `{error}` with
  a count, `replace_all` replaces all occurrences.
- `edit_section` (consolidated from the spec's two separate tools): `mode:'append'` or `mode:'replace'`.
- Delete tools (`delete_document`, `delete_task`, `forget_memory`) are `kind:destructive` but NOT
  `dangerous` — all three are MCP-exposed and reversible via `undo`.

**Server-level `instructions`** preamble (new) establishes the second-brain workflow for any
connected agent.

**No migration** — thin wrappers around existing service methods (`updateDoc`, `moveDoc`,
`deleteDoc`). `updateDoc` already recomputes `content_hash`, so edited docs are re-indexed
automatically by the embed/chunk cron.

## Key design decisions

- **Edit tools are `kind:create`** — never blocked, even if someone later adds gating on
  `kind:destructive`. The only hard gate remains `dangerous:true` (exec).
- **Delete tools are `kind:destructive`** — accurate semantics; descriptive today (drives
  "confirm with user" language + signals undo); still not `dangerous`, so all MCP-exposed.
- **`edit_section` consolidates** append + replace-section into one tool with a `mode`.
- **Handlers never throw** for expected outcomes — returns `{ result: { error }, summary }` so
  the model can react and the activity log doesn't record spurious error rows.
- **Pure `edit-ops.ts`** keeps all string logic zero-DB and unit-testable; handlers are trivially
  uniform (get doc → apply pure op → update DB → publishChange → return undo).

## Gotchas for the next session

- The MCP parity test (`test/mcp-parity.test.ts`) now asserts 29 tools. If you add a tool, add
  it to `agentTools` in `tools.ts` and the parity test picks it up automatically — but the
  `agent-tools.test.ts` toEqual list needs a manual update.
- Line numbers in `edit-ops.ts` are **1-indexed** throughout. Section boundary: heading line through
  the line before the next heading whose level ≤ the section's level (or EOF). Repeated identical
  headings → `{error}` (ambiguous), not silently picking the first.
- `update_document` passing `project` relocates the doc (path⟺project invariant from cycle 26).
  `move_document` is for explicit path control. They serve different intents.
- Minor deferred: `update_document` has a cosmetic `const prior = doc` placement issue (after
  `updateDoc` call; functionally correct since `doc` is pre-mutation — move above for clarity).
