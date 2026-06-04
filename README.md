# MyMind

**A self-hosted "second brain" that's AI-native and agent-accessible.** Notes, documents, tasks, images, clipboard, and memory — in one place, running on my own hardware, wired into my local LLMs, and exposed to my coding agents over MCP.

I built this for me. It's the single front door to everything I'd otherwise scatter across a dozen apps: a Markdown knowledge base, a ShareX image host, a kanban, a device-sync clipboard, and a memory system that turns my AI coding sessions into durable, searchable notes. It's also a portfolio piece — and very much a living project I'm going to keep growing.

> 🛠️ Built by Tony — more of my work at **[techhivelabs.net](https://techhivelabs.net)**.

<!-- Hero shot: the Documents page (split tree + editor in split/preview mode). -->
![MyMind — documents](docs/screenshots/documents.png)

---

## Why it exists

Most "knowledge management" tools are either dumb buckets or someone else's cloud. I wanted one that:

- **Runs entirely on my homelab** — my data, my GPUs, no subscription, exposed to the internet only where *I* choose (document/image sharing).
- **Uses local AI for real work** — embeddings, OCR, transcription, and memory extraction all run against models on my own rig.
- **Is reviewable, never silently "magic"** — the AI proposes; I approve. Nothing auto-mutates my corpus.
- **Talks to my agents** — an MCP server lets Claude Code (and friends) search my memories/docs and create tasks directly.

It's modular by design — each system is its own page, and there's always room for the next one.

## What it does

### 📄 Documents — a Markdown knowledge base with a real editor
A split file-tree + editor (CodeMirror + live MDC preview), drag-and-drop organize, right-click rename/move/share, a markdown toolbar, and **custom MDC components** (callouts, notes, collapsibles). Paste an image straight into a doc and it uploads + embeds itself. Share any document as a public read-only page with one click.

### 🔎 Search that actually understands you
One **⌘K command palette** searches across *everything* — documents, memories, image OCR/tags, tasks, projects — using **hybrid semantic + keyword search** (pgvector embeddings fused with trigram matching). Find the thing by what it *means*, not just the words you remember.

### 🧠 Memory — your AI sessions become durable knowledge
Claude Code / Hermes hooks stream session transcripts in; a background job extracts **atomic, deduplicated memories** ("the user prefers pnpm", "this project uses Drizzle + pgvector") with confidence scores. High-confidence memories auto-file; the rest land in a review queue. Browse the raw transcripts too — token usage, tool calls, the works.

### 🤖 An MCP server for your agents
MyMind exposes ~10 tools over the Model Context Protocol — `search_memories`, `save_memory`, `search_docs`, `create_task`, `search/edit projects & tasks`. Point a coding agent at it and it can read your knowledge and write back to it, securely, with an API token.

### 🖼️ Image host + quick capture
A **ShareX/CleanShot-compatible uploader** (`POST /api/upload`) that auto-converts to WebP, runs **OCR + tag suggestions** via a local vision model, and serves public or private links. Quick Capture lets you paste/drag/snap a photo — including **transcribing handwritten notes into clean Markdown** with an inferred title.

### ✅ Tasks, 📋 Clipboard, and more
A drag-and-drop kanban with projects/priorities; a **device-sync clipboard** (paste on one machine, grab it on another, live over SSE, with per-message machine attribution). Everything that lands in the inbox (`/input`) gets auto-enriched and filed.

## Screenshots

> Drop images into `docs/screenshots/`. Suggested set:

| | |
|---|---|
| ![Command palette](docs/screenshots/command-palette.png) **⌘K search across everything** | ![Gallery](docs/screenshots/gallery.png) **Image host + OCR tags** |
| ![Kanban](docs/screenshots/tasks.png) **Tasks board** | ![Memories](docs/screenshots/memories.png) **Memory review** |
| ![Sessions](docs/screenshots/sessions.png) **Session transcripts** | ![Clipboard](docs/screenshots/clipboard.png) **Device-sync clipboard** |

## How it works

One **Nuxt 4** service does all of it — the web app (SPA), the HTTP API, and the MCP server, from a single deployable.

```
   Browser (SPA)          ShareX / CleanShot        Claude Code / agents
        │                        │                          │
        ▼                        ▼                          ▼
  ┌───────────────────────────────────────────────────────────────┐
  │                     Nuxt 4  ·  Nitro server                    │
  │   web UI  ·  /api/* (upload, hooks, docs…)  ·  /api/mcp        │
  └───────────────────────────────────────────────────────────────┘
        │                        │                          │
        ▼                        ▼                          ▼
  Postgres + pgvector      local AI rig (LAN)         object storage
  docs · memories ·     embeddings · vision/OCR ·     (local disk / S3)
  tasks · sessions      reasoning · transcription
```

- **Storage**: PostgreSQL + **pgvector** (HNSW) for hybrid search; content-addressed blob storage for images/files.
- **AI**: every model call is an env-configured, OpenAI-spec endpoint pointed at my local rig (embeddings, vision/OCR, a reasoning model) — swap a model by changing an env var, never code.
- **Background work**: in-process scheduled jobs embed documents, run OCR, propose frontmatter, and extract memories on a cadence.
- **Auth**: single-user sessions for the web app; bearer API tokens for machine clients (ShareX, hooks, MCP).

It was built deliberately, one system at a time — there's a full paper trail in [`docs/`](docs/) (a cross-cycle roadmap, per-system specs, handovers, and a living wiki).

## Tech stack

**Nuxt 4** · **Nuxt UI v4** · **Nitro** · **Drizzle ORM** · **PostgreSQL 16 + pgvector** · **better-auth** · **CodeMirror 6** · **Nuxt MDC** · **sharp** · **@modelcontextprotocol/sdk** · local **Qwen3** models (embeddings / vision / reasoning) via OpenAI-spec endpoints.

## Running it yourself

It's designed for a homelab (Proxmox + Docker) with access to local LLM endpoints. There's a complete, no-assumptions deployment guide:

➡️ **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — Docker setup, env vars, bootstrapping, reverse proxy, backups, and verification.

```bash
cp .env.example .env          # configure DB, auth, AI endpoints
docker compose -f docker-compose.prod.yml up -d --build
```

> Heads-up: the AI features expect OpenAI-compatible model endpoints (mine are local Qwen3 models). Point the `AI_*` env vars at any compatible provider — they're not hardcoded.

## Status & roadmap

Actively built and in daily use. Eleven build cycles shipped so far (foundation → AI enrichment → capture/images → tasks → memory + MCP → clipboard, then a round of feedback-driven polish). The full status table and what's next live in [`docs/superpowers/plans/00-roadmap.md`](docs/superpowers/plans/00-roadmap.md).

On the radar: a session-summarization worker, GitHub-commit → memory, richer MDC components, and whatever else I decide my brain needs next.

## A note

This is a personal project — opinionated, single-user, and shaped entirely around how *I* work. I'm sharing it because I think the architecture is genuinely interesting (local-AI-native, agent-accessible, review-gated), not because it's a polished product for everyone. Poke around, steal ideas, and say hi.

— **[Tony · Tech Hive Labs](https://techhivelabs.net)**
