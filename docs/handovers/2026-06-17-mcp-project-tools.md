---
title: MCP project-aware document tools (11 → 15)
cycle: 27-followup
date: 2026-06-17
status: shipped
wiki:
  - ../wiki/mcp.md
relates:
  - 2026-06-17-document-project-association.md
  - 2026-06-03-memory-mcp.md
---

# MCP project-aware document tools

Extends the MCP/agent tool surface so external coding agents (Claude Code etc.) can drive MyMind around the cycle-26 **projects backbone**. Four new thin-wrapper tools (registry 11 → **15**) + a `project` filter on doc search. All wrappers over existing, already-validated services; auto-exposed via the MCP server (it builds its tool list from `agentTools`) and to the voice/chat agent.

## Shipped (`server/lib/agent/tools.ts` + `server/services/documents.ts`)
- **`get_project(slug)`** (read) → `getProject` — full project model (git remote, URLs, aliases, local paths) + session/memory/task/document counts.
- **`list_documents(project?)`** (read) → `listDocs` — a project's documents (or all), newest first.
- **`get_document(id)`** (read) → `getDoc` — a doc's full content + frontmatter.
- **`save_document(content, project?, title?, path?)`** (create) → `createDoc` — creates a doc; when `project` is set, the **cycle-26 path⟺project choke point auto-files it under `/projects/<slug>/`** and associates it. Distinct from `quick_capture` (quick note → `/input`). Path derived from `title` (slugified) or a nanoid when not given; `undo` = `deleteDoc`.
- **`search_docs` gains an optional `project`** filter — `searchDocs(q, { project })` adds `eq(documents.project, slug)` to **both** the trigram and vector RRF lanes (scopes semantic doc search to one project). Backward compatible (`opts` defaults to `{}`; the unified `/api/search` call is unchanged).

## Gates / validation
- typecheck 0 / **test 393** / build OK. The `agent-tools` test (updated 11→15) + the `mcp-parity` test (MCP surface == `agentTools`, auto-holds) both pass. Unified `/api/search` regression-checked (still returns all lanes).
- The four wrappers ride services E2E-validated earlier this session (cycle-26: `getProject`/`listDocs`/`getDoc`/`createDoc`-with-auto-filing). The new `searchDocs` project filter is a standard drizzle `eq` added to existing lanes (gate-validated; not separately API-exposed for an E2E this session). **Quick follow-up:** exercise the live tools through the deployed prod MCP (a bearer-token `tools/call`, or via a connected agent) to confirm the `tools/list` shows 15 + `save_document` files into `/projects/<slug>/`.

## Watch-outs
- The MCP server is the **prod** instance — `save_document` / `save_memory` / `create_task` calls land in the prod DB.
- A commit-message gotcha: `git commit -m "…"` with **backticks** in zsh triggers command substitution — one term (`` `project` ``) got eaten in commit `bd24de7`'s message (code is correct). Use `-F - <<'EOF'` for messages with backticks.

## Next (carried in BACKLOG §5)
The "better/more MCP tools" theme is partially delivered. Still open: richer doc **edit** (an `edit_document`), structured task queries, and the bigger **agent loop / in-app text-chat UI** (roadmap cycle 14). Scoped-memory-depth (reranker + `memory_relations` surfacing) is queued as its own task.
