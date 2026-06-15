---
title: MCP Server
status: shipped
cycle: 5
updated: 2026-06-03
---

# MCP Server

Exposes MyMind to agents (Claude Code, etc.) over the Model Context Protocol, deprecating bridget's FastMCP server.

## Endpoint
`POST /api/mcp` — `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` in **stateless** mode (fresh `McpServer` + transport per request; no session store). Wired into the Nitro h3 handler (`server/api/mcp/index.post.ts`): reads the body, `server.connect(transport)`, `transport.handleRequest(event.node.req, event.node.res, body)`, then `event._handled = true` (h3 v1). Responses are SSE-framed JSON-RPC (clients send `Accept: application/json, text/event-stream`).

## Auth
Bearer **API token** (machine clients) — the existing dual-auth middleware gates `/api/**`, plus an in-handler token check against `api_tokens`. Mint/manage tokens and get a copy-paste MCP config at `/settings → API Keys` — see [`api-tokens.md`](api-tokens.md).

## Tools (`server/lib/mcp/server.ts`)
| Tool | Delegates to |
|---|---|
| `search_memories(query, scope?, project?, limit?)` | memory.searchMemories |
| `save_memory(content, scope, project?, tags?)` | memory.createMemory |
| `get_recent_memories(scope?, limit?)` | memory.listMemories |
| `search_docs(query)` | documents.searchDocs |
| `search_projects(activeOnly?)` | projects.listProjects |
| `create_project(name, description?)` | projects.createProject |
| `edit_project(slug, name?, description?, active?)` | projects.updateProject |
| `create_task(title, ...)` | tasks.createTask |
| `search_tasks(status?, project?)` | tasks.listTasks |
| `edit_task(id, ...patch)` | tasks.updateTask |

Registered via `server.tool(name, description, zodShape, handler)`; each returns `{ content: [{ type:'text', text: JSON.stringify(result) }] }`.

## Validate
With a bearer token + `Accept: application/json, text/event-stream`, POST JSON-RPC `initialize`, `tools/list`, `tools/call`. Verified: tools/list → 10 tools; `search_memories` returns ranked memories; `create_task` creates a real task row.

## Notes / follow-ups
Stateless mode → no server-initiated notifications; tools only (no MCP resources/prompts) — sufficient for the agent tool-call use case.
