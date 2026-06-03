---
title: Foundation + Content Spine
cycle: 1
status: spec
date: 2026-06-02
supersedes: none
---

# Cycle 1 — Foundation + Content Spine

## Purpose

Stand up the shared core that every later MyMind feature is a view over, and ship it as a **manual-but-complete document manager** you can live in daily. After this cycle: a logged-in, internet-exposed Nuxt 4 app where you browse a real path tree (including an `/input` staging folder), open/edit/preview Markdown docs with live MDC rendering, set frontmatter + project/domain/type/tags by hand, keyword-search, and publicly share a doc by slug. No AI runs yet — but the schema and provider seams are in place so cycle 2 plugs straight in.

This cycle combines what the roadmap calls Foundation (#0) and Content Spine (#1): the spine slice already delivers a usable doc-management UI, so they ship together.

## Non-goals (deferred to later cycles)

- AI auto-tagging / auto-sorting / frontmatter inference for `/input` → **cycle 2**
- Vector embedding worker + semantic/RRF search → **cycle 2** (schema column exists now, stays empty)
- Notification/queue, OCR, image hosting, quick capture, tasks, memory, MCP, clipboard → later cycles
- In-app markdown export / git mirror (DR is handled out-of-band) → optional future

## Locked decisions (from roadmap)

One Nuxt 4 service · better-auth dual surface (session + API token) · Drizzle + Postgres + pgvector · hybrid path-tree + frontmatter doc model · `qwen3-embedding-4b` 2560-dim `halfvec` (column only this cycle) · env-configured OpenAI-spec providers · local/S3 storage abstraction · trigram search now · external nightly backups.

## Architecture

The core move is porting `bridget-services/command-center`'s clean file-tree/editor separation but swapping its filesystem backend for Postgres.

```
app/
  pages/documents.vue            # split layout: tree | editor (UDashboardPanel resizable)
  components/documents/Tree.vue   # path-tree browser (drag/move, context menu)  [port of command-center Tree]
  components/documents/Editor.vue # toolbar + edit/preview/split toggle + autosave [port]
  components/CodeEditor.client.vue# CodeMirror 6 wrapper                          [port]
  components/MdView.vue           # MDC preview                                   [port]
  composables/useDocuments.ts     # client API layer                             [port of useKnowledge]
server/
  services/documents.ts          # THE SEAM — all doc reads/writes/tree/move via Drizzle (replaces knowledge-fs.ts)
  api/documents/                 # thin Nitro routes -> service
    tree.get.ts
    [id].get.ts | .put.ts | .post.ts | .delete.ts
    move.post.ts | rename.post.ts | share.post.ts
  api/share/[slug].get.ts        # public read-only, bypasses auth
  api/auth/[...all].ts           # better-auth handler
  middleware/auth.ts             # session OR bearer API-token; sets event.context.user/client
  lib/ai/provider.ts             # env-configured OpenAI-spec client factory (SCAFFOLD; unused this cycle)
  utils/storage/{index,local,s3}.ts  # storage abstraction [port of copipasta]
  db/
    index.ts                     # drizzle + pg Pool
    schema/{documents,projects,auth,api-tokens}.ts
    migrations/
```

The document service is the single seam: nothing outside `server/services/documents.ts` touches the DB for documents. Routes are thin; the composable mirrors them on the client.

## Data model (Drizzle / Postgres)

### `documents`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `path` | text, not null | canonical tree location, e.g. `/input/note.md`, `/projects/mymind/scope.md`. Unique among non-deleted. |
| `title` | text | |
| `content` | text, not null | MDC/markdown source |
| `language` | text, default `plaintext` | from `getLanguageFromExtension` |
| `frontmatter` | jsonb, default `{}` | raw frontmatter, source of truth |
| `project` | text, nullable | promoted, queryable; soft ref to `projects.slug` |
| `domain` | text, nullable | promoted, queryable (broad subject bucket) |
| `type` | text, nullable | note / reference / meeting / task-source / … |
| `tags` | text[], default `{}` | GIN indexed |
| `topic` | ltree, nullable | hierarchical topic path |
| `content_hash` | text | sha256 (change detection / future dedup) |
| `is_public` | boolean, default false | |
| `public_slug` | text, unique nullable | sharing |
| `embedding` | `halfvec(2560)`, nullable | **schema only; filled in cycle 2** |
| `created_at` / `updated_at` / `deleted_at` | timestamptz | audit + soft delete |

Indexes: `path` (unique where `deleted_at is null`), `tags` GIN, `title`+`content` trigram GIN (`pg_trgm`), `topic` GIST, `public_slug` unique. HNSW on `embedding` added in cycle 2.

Extensions required: `pgcrypto` (or `gen_random_uuid`), `pg_trgm`, `ltree`, `vector`.

### `projects`
`slug` (PK text), `name`, `description` (text), `active` (bool, default true), `created_at`, `updated_at`. Minimal shell per scope.

### Auth tables
better-auth's standard schema (user/session/account/verification) via its Drizzle adapter, plus:

### `api_tokens`
`id` uuid PK, `name` text, `token_hash` text (sha256), `last_used_at`, `created_at`, `revoked_at`. For machine clients (bearer). Created/managed from a settings page (CRUD minimal).

## Auth

- **Session**: better-auth, single user (Tony). Sign-in page from the dashboard template / copipasta pattern.
- **Bearer API token**: `Authorization: Bearer <token>` → sha256 → lookup `api_tokens` (non-revoked). Sets `event.context.client`.
- `middleware/auth.ts` accepts either; protected routes require one. `/api/share/[slug]` and the public share page are exempt (read-only).
- The app is internet-exposed: rate-limit auth + (future) upload endpoints; public share is read-only by slug only.

## Editor / viewer

Port command-center's components:
- `CodeEditor.client.vue` — CodeMirror 6, language-aware, dark mode, Cmd+S.
- `MdView.vue` — `<MDC :value="content" />`.
- `Editor.vue` — `edit | preview | split` toggle (preview only for markdown), persisted in a cookie; debounced autosave (~1.5s) with save-status badge; dirty indicator.
- Language auto-detected via `codethis-dev`'s `getLanguageFromExtension` (ported to `shared/utils/languages.ts`).

## Sharing

`codethis-dev`'s `public_slugs` pattern, simplified onto the `documents` row: `share.post.ts` toggles `is_public` and assigns a random `public_slug`; `/api/share/[slug].get.ts` returns read-only content; a `/share/[slug]` page renders it with MDC, no auth.

## Search (this cycle)

Postgres trigram only: `pg_trgm` GIN on `title`/`content`, a `documents/search` query exposed through the composable. Instant keyword search. Semantic + RRF fusion is layered on the same surface in cycle 2 once `embedding` is populated.

## AI provider scaffold

`server/lib/ai/provider.ts`: a factory returning an OpenAI-spec client per **role** (`reasoning`, `bulk`, `embeddings`, `vision`, `stt`, `tts`), each reading `*_BASE_URL` / `*_API_KEY` / `*_MODEL` from runtime config. Wired and type-safe this cycle, but **no role is invoked** — it exists so cycle 2 imports it without refactoring. `.env.example` documents all role vars.

## Testing & validation

- `pnpm typecheck` and `pnpm build` must pass.
- Drizzle migration applies cleanly (`pnpm db:migrate`) against local Docker Postgres (with `vector`/`pg_trgm`/`ltree`).
- E2E with `playwright-cli` (not MCP), creating a test account: sign in → create doc in `/input` → edit + preview + split → set frontmatter/project/tags → keyword search finds it → toggle public → open `/share/[slug]` in a logged-out context → reads.
- API-token path: create token in settings → `curl` a `documents` route with the bearer token succeeds; without it, 401.

## Definition of done

A manual doc manager you can use daily: browse the path tree, CRUD markdown with live preview/split + autosave, organize via frontmatter + promoted columns, keyword-search, and share by public slug — with the Postgres/pgvector schema, dual auth, storage abstraction, and env provider seam all in place for cycle 2. Wiki pages `document-spine.md` / `auth.md` / `ai-providers.md` bumped to `shipped` with real schema/config; handover written; roadmap row → `shipped`.
