# MyMind Wiki

The **living** reference for how each shipped system works **today** — one page per system.

- A page is created when its system is first built, and updated in the **same change** that ships or alters the system.
- Each page carries a `status` ladder: `planned → in-progress → shipped`.
- The wiki holds **current behaviour** (real schema, config, endpoints). Intent at design time lives in the per-cycle spec under [`../superpowers/specs/`](../superpowers/specs/); what happened in a cycle lives in [`../handovers/`](../handovers/).
- Never let a page describe shipped work as unbuilt.

## Pages

| System | Page | Status |
|---|---|---|
| Auth (session + API tokens) | [auth.md](auth.md) | shipped |
| AI model providers (env, OpenAI-spec) | [ai-providers.md](ai-providers.md) | shipped (scaffold) |
| Document spine (model, browser, editor, sharing, search) | [document-spine.md](document-spine.md) | shipped |
| AI enrichment + review queue (embeddings, hybrid search, /input proposals, login) | [enrichment.md](enrichment.md) | shipped |
| Image hosting + gallery (ShareX upload, webp, OCR tags, public/private) | [image-hosting.md](image-hosting.md) | shipped |
| Quick capture (notes/image/transcribe → /input) | [quick-capture.md](quick-capture.md) | shipped |
| Tasks + Projects (kanban, audit) | [tasks-projects.md](tasks-projects.md) | shipped |
| Memory system (ingest, enrich, dedup, semantic search) | [memory.md](memory.md) | shipped |
| MCP server (agent tools: memories/docs/projects/tasks) | [mcp.md](mcp.md) | shipped |
| Clipboard (device-sync paste, live SSE, rich copy) | [clipboard.md](clipboard.md) | shipped |
| Search + command palette (⌘K, cross-surface) + SPA rendering note | [search.md](search.md) | shipped |
| Sessions view (CC/Hermes transcripts + token/tool stats) | [sessions.md](sessions.md) | shipped |
