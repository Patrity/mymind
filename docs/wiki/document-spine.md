---
title: Document Spine
status: planned
cycle: 1
updated: 2026-06-02
---

# Document Spine

The shared content core that every feature is a view over: documents stored in Postgres with a hybrid path-tree + frontmatter model, browsed and edited in a split file-tree/editor UI, keyword-searchable, and publicly shareable.

> Status: **planned** — design in `docs/superpowers/specs/` (cycle 1). This page gets real schema, routes, and behaviour when cycle 1 ships.

## Will document (once built)
- `documents` table schema (path, content, frontmatter jsonb, promoted columns `project`/`domain`/`type`/`tags`/`topic`, `public_slug`, `embedding halfvec(2560)` placeholder).
- The DB seam: `server/services/documents.ts` → `server/api/documents/*` → `useDocuments()`.
- Editor: CodeMirror 6 + MDC, edit/preview/split, auto-save.
- Public sharing: `public_slug` + `/share/[slug]`.
- Search: pg_trgm keyword (semantic/RRF added in cycle 2).
