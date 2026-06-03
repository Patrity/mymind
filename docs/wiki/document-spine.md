---
title: Document Spine
status: shipped
cycle: 1
updated: 2026-06-03
---

# Document Spine

The shared content core every feature is a view over: documents stored in Postgres with a hybrid path-tree + frontmatter model, browsed/edited in a split file-tree/editor UI, keyword-searchable, and publicly shareable.

## Data model — `documents` (`server/db/schema/documents.ts`)
`id` uuid PK · `path` text (canonical tree location, e.g. `/input/x.md`; unique where `deleted_at is null`) · `title` · `content` · `language` (from `getLanguageFromPath`) · `frontmatter` jsonb · **promoted queryable columns** `project` / `domain` / `type` / `tags` text[] / `topic` ltree · `content_hash` · `is_public` + `public_slug` (unique) · `embedding` halfvec(2560) (**NULL until cycle 2**) · `created_at` / `updated_at` / `deleted_at` (soft delete).
Indexes: partial unique on `path`, unique `public_slug`, GIN on `tags`, btree `project`, GIN trigram on `title` and `content`, GiST on `topic`.
Minimal `projects` table: `slug` PK, `name`, `description`, `active`.

## The seam
All document access goes through `server/services/documents.ts`: `listTree`, `getDoc`, `createDoc`, `updateDoc`, `moveDoc`, `deleteDoc` (soft), `searchDocs`, `setPublic`, `getByPublicSlug`. Nothing else touches the table. Tree shaping: `server/services/tree.ts` `buildTree()` (folders before files, alphabetical).

## API (`server/api/documents/*`, `server/api/share/*`)
`GET tree` · `POST /` (create) · `GET|PUT|DELETE [id]` · `POST [id]/move` · `POST [id]/share` · `GET search?q=` · public `GET /api/share/[slug]` (auth-exempt, read-only). Client wrapper: `app/composables/useDocuments.ts`.

## UI
`app/pages/documents.vue` — `UDashboardPanel` split: left `DocumentsTree` (browse/select/delete, search box) + right `DocumentsEditor`. Editor: CodeMirror (`CodeEditor.client.vue`) + MDC preview (`MdView.vue`), `edit|preview|split` toggle (cookie-persisted), ~1.5s debounced autosave, metadata form (title/project/domain/type/tags), share toggle showing `/share/<slug>`. Public read-only page: `app/pages/share/[slug].vue` (`layout: false`).

## Search
**Hybrid (cycle 2):** `searchDocs` fuses a trigram lane (`ilike` + `similarity()`) and a vector cosine lane (`embedding <=> query::halfvec` over the HNSW index) via RRF, falling back to trigram-only if embeddings are unavailable. See [enrichment.md](enrichment.md).

## Known gaps (see handover)
Deep-link `?doc=<id>` doesn't auto-load; no tree drag-drop UI (move API exists); `useDocuments` uses raw ofetch.
