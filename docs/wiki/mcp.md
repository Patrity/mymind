---
title: MCP Server
status: shipped
cycle: 40
updated: 2026-06-30
---

# MCP Server

Exposes MyMind to agents (Claude Code, etc.) over the Model Context Protocol, deprecating bridget's FastMCP server.

## Endpoint
`POST /api/mcp` — `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` in **stateless** mode (fresh `McpServer` + transport per request; no session store). Wired into the Nitro h3 handler (`server/api/mcp/index.post.ts`): reads the body, `server.connect(transport)`, `transport.handleRequest(event.node.req, event.node.res, body)`, then `event._handled = true` (h3 v1). Responses are SSE-framed JSON-RPC (clients send `Accept: application/json, text/event-stream`).

## Auth
Bearer **API token** (machine clients) — the existing dual-auth middleware gates `/api/**`, plus an in-handler token check against `api_tokens`. Mint/manage tokens and get a copy-paste MCP config at `/settings/api-keys` — see [`api-tokens.md`](api-tokens.md).

## Server `instructions` preamble
Added in cycle 40: `new McpServer(info, { instructions: MCP_INSTRUCTIONS })` passes a server-level preamble (verified supported by the SDK's `ServerOptions.instructions`). The preamble establishes the second-brain workflow — search before answering, persist durable facts, file under projects, prefer surgical `edit_document` — so agents reliably reach for MyMind tools rather than answering from their own recollection.

## Tools (`server/lib/mcp/server.ts`)
The MCP surface is **auto-derived**: `server.ts` iterates `agentTools` (`server/lib/agent/tools.ts`) and registers every **non-`dangerous`** tool — no per-tool MCP wiring. `test/mcp-parity.test.ts` asserts the MCP set == the non-dangerous agent set. All 29 tools are currently non-dangerous, so the full registry is exposed (29 rows below).

### `kind` policy
Each tool carries a `kind` field that controls gating + description copy:
- `kind:read` — pure reads; always ungated.
- `kind:create` — write/mutate (including edits to existing docs); ungated by design (cycle 40 decision: edits must never be blocked by a confirmation gate, even if `kind:destructive` gets gated in the future).
- `kind:destructive` — removal/archive actions; descriptive today (signals "confirm with user" language + undo); NOT hard-gated.
- `dangerous:true` — the **only** hard runtime gate (checked in `ai-tools.ts`). A tool with `dangerous:true` is **never exposed to MCP** and is never callable without approval. Currently only `exec`. All 29 MCP tools are non-`dangerous`.

### Tool table

| Tool | kind | Delegates to |
|---|---|---|
| `search_memories(query, scope?, project?, limit?)` | read | memory.searchMemories |
| `save_memory(content, scope, project?, tags?, source?, confidence?)` | create | memory.createMemory |
| `get_recent_memories(scope?, limit?)` | read | memory.listMemories |
| `search_docs(query, project?)` | read | documents.searchDocs |
| `search_passages(query, project?, limit?)` | read | documents.searchPassages (chunk-level RAG, cycle 31) |
| `list_documents(project?)` | read | documents.listDocs |
| `get_document(id)` | read | documents.getDoc |
| `save_document(content, project?, title?, path?)` | create | documents.createDoc |
| `read_document(id, { heading?, offset?, limit? })` | read | edit-ops `outline` / `readSection` (cycle 40) |
| `grep_document(id, pattern, { regex?, context?, max? })` | read | edit-ops `grepContent` (cycle 40) |
| `edit_document(id, old_string, new_string, replace_all?)` | create | edit-ops `applyReplace` → documents.updateDoc (cycle 40) |
| `edit_section(id, { mode, text, heading? })` | create | edit-ops `applyEditSection` → documents.updateDoc (cycle 40) |
| `update_document(id, { title?, content?, frontmatter?, tags?, domain?, type?, project? })` | create | documents.updateDoc (cycle 40) |
| `move_document(id, path)` | create | documents.moveDoc (cycle 40) |
| `delete_document(id)` | destructive | documents.deleteDoc → restoreDoc undo (cycle 40) |
| `delete_task(id)` | destructive | tasks.deleteTask → restoreTask undo (cycle 40) |
| `forget_memory(id)` | destructive | memory.archiveMemory → unarchiveMemory undo (cycle 40) |
| `search_projects(activeOnly?)` | read | projects.listProjects |
| `get_project(slug)` | read | projects.getProject |
| `create_project(name, description?)` | create | projects.createProject |
| `edit_project(slug, name?, description?, active?)` | create | projects.updateProject |
| `create_task(title, ...)` | create | tasks.createTask |
| `search_tasks(status?, project?)` | read | tasks.listTasks |
| `edit_task(id, ...patch)` | create | tasks.updateTask |
| `quick_capture(text, title?)` | create | documents.createDoc |
| `web_search(query, count?)` | read | search provider (SearXNG/Brave); untrusted results (cycle 29) |
| `web_fetch(url)` | read | fetchAsMarkdown; SSRF-guarded, untrusted content (cycle 29) |
| `generate_image(prompt, ...)` | create | imagegen/comfy → images.createGeneratedImage (cycle 36) |
| `edit_image(instruction, source_image_id?, quality?)` | create | Qwen-Image-Edit-2509 instruction editing → images.createGeneratedImage (cycles 37–38; img2img+strength removed) |

`save_memory` params: `content` (string, max 20k), `scope` (user|agent|world), `project?` (slug), `tags?` (string[]), `source?` (string), `confidence?` (0–1 float). A `confidence >= 0.75` auto-reviews the memory; omitting it leaves it for manual review.

**Project-aware document tools** — for agents working inside a project: `search_docs`/`list_documents` accept a `project` slug to scope to one project; `get_document(id)` returns a doc's full content + frontmatter; `save_document(content, project?, …)` creates a doc and — when `project` is set — **auto-files it under `/projects/<slug>/`** via the cycle-26 path⟺project choke point (vs `quick_capture`, which drops a quick note in `/input`). `get_project(slug)` returns the full project model + session/memory/task/document counts.

**Long-doc agent workflow (cycle 40)** — agents should not round-trip the whole document body to make a small change. Instead: `read_document(id)` with no selector → outline + line/char counts; `read_document(id, { heading })` → just that section; `grep_document(id, pattern)` → locate the exact unique string; `edit_document(id, old, new)` → surgical patch. `edit_section` handles structure-aware append/replace. All mutations call `publishChange` (live-data rule) and return an `undo`.

**Pure `edit-ops.ts` module** (`server/lib/documents/edit-ops.ts`) — zero-DB string helpers underlying the cycle-40 edit tools: `outline`, `findSection`, `readSection`, `documentStats`, `grepContent`, `applyReplace`, `applyEditSection`. 26 unit tests; tool handlers do DB I/O around them.

Registered via `server.tool(name, description, zodShape, handler)`; each returns `{ content: [{ type:'text', text: JSON.stringify(result) }] }`.

## Validate
With a bearer token + `Accept: application/json, text/event-stream`, POST JSON-RPC `initialize`, `tools/list`, `tools/call`. Verified (cycle 40 live E2E, 2026-06-30): `tools/list` → 29 tools; full MCP round-trip (`save_document` → `read_document` → `grep_document` → `edit_document` → `edit_section` → `update_document` → `move_document` → `delete_document`) against the real `/api/mcp` StreamableHTTP endpoint, 28/28 assertions. (The `agent-tools` + `mcp-parity` unit tests assert the registry and that the MCP surface equals it exactly.)

## Notes / follow-ups
Stateless mode → no server-initiated notifications; tools only (no MCP resources/prompts) — sufficient for the agent tool-call use case.
