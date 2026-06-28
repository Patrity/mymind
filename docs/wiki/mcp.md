---
title: MCP Server
status: shipped
cycle: 38
updated: 2026-06-26
---

# MCP Server

Exposes MyMind to agents (Claude Code, etc.) over the Model Context Protocol, deprecating bridget's FastMCP server.

## Endpoint
`POST /api/mcp` — `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` in **stateless** mode (fresh `McpServer` + transport per request; no session store). Wired into the Nitro h3 handler (`server/api/mcp/index.post.ts`): reads the body, `server.connect(transport)`, `transport.handleRequest(event.node.req, event.node.res, body)`, then `event._handled = true` (h3 v1). Responses are SSE-framed JSON-RPC (clients send `Accept: application/json, text/event-stream`).

## Auth
Bearer **API token** (machine clients) — the existing dual-auth middleware gates `/api/**`, plus an in-handler token check against `api_tokens`. Mint/manage tokens and get a copy-paste MCP config at `/settings → API Keys` — see [`api-tokens.md`](api-tokens.md).

## Tools (`server/lib/mcp/server.ts`)
The MCP surface is **auto-derived**: `server.ts` iterates `agentTools` (`server/lib/agent/tools.ts`) and registers every **non-`dangerous`** tool — no per-tool MCP wiring. `test/mcp-parity.test.ts` asserts the MCP set == the non-dangerous agent set. All 20 tools are currently non-dangerous, so the full registry is exposed (20 rows below).

| Tool | Delegates to |
|---|---|
| `search_memories(query, scope?, project?, limit?)` | memory.searchMemories |
| `save_memory(content, scope, project?, tags?, source?, confidence?)` | memory.createMemory |
| `get_recent_memories(scope?, limit?)` | memory.listMemories |
| `search_docs(query, project?)` | documents.searchDocs |
| `search_passages(query, project?, limit?)` | documents.searchPassages (chunk-level RAG, cycle 31) |
| `list_documents(project?)` | documents.listDocs |
| `get_document(id)` | documents.getDoc |
| `save_document(content, project?, title?, path?)` | documents.createDoc |
| `search_projects(activeOnly?)` | projects.listProjects |
| `get_project(slug)` | projects.getProject |
| `create_project(name, description?)` | projects.createProject |
| `edit_project(slug, name?, description?, active?)` | projects.updateProject |
| `create_task(title, ...)` | tasks.createTask |
| `search_tasks(status?, project?)` | tasks.listTasks |
| `edit_task(id, ...patch)` | tasks.updateTask |
| `quick_capture(text, title?)` | documents.createDoc |
| `web_search(query, count?)` | search provider (SearXNG/Brave); untrusted results (cycle 29) |
| `web_fetch(url)` | fetchAsMarkdown; SSRF-guarded, untrusted content (cycle 29) |
| `generate_image(prompt, ...)` | imagegen/comfy → images.createGeneratedImage (cycle 36) |
| `edit_image(instruction, source_image_id?, quality?)` | Qwen-Image-Edit-2509 instruction editing → images.createGeneratedImage (cycles 37–38; img2img+strength removed) |

`save_memory` params: `content` (string, max 20k), `scope` (user|agent|world), `project?` (slug), `tags?` (string[]), `source?` (string), `confidence?` (0–1 float). A `confidence >= 0.75` auto-reviews the memory; omitting it leaves it for manual review.

**Project-aware document tools (cycle 27-followup)** — for coding agents working inside a project: `search_docs`/`list_documents` accept a `project` slug to scope to one project; `get_document(id)` returns a doc's full content + frontmatter; `save_document(content, project?, …)` creates a doc and — when `project` is set — **auto-files it under `/projects/<slug>/`** via the cycle-26 path⟺project choke point (vs `quick_capture`, which drops a quick note in `/input`). `get_project(slug)` returns the full project model + session/memory/task/document counts.

Registered via `server.tool(name, description, zodShape, handler)`; each returns `{ content: [{ type:'text', text: JSON.stringify(result) }] }`.

## Validate
With a bearer token + `Accept: application/json, text/event-stream`, POST JSON-RPC `initialize`, `tools/list`, `tools/call`. Verified: tools/list → 20 tools; `search_memories` returns ranked memories; `create_task` creates a real task row. (The `agent-tools` + `mcp-parity` unit tests assert the registry and that the MCP surface equals it exactly.)

## Notes / follow-ups
Stateless mode → no server-initiated notifications; tools only (no MCP resources/prompts) — sufficient for the agent tool-call use case.
