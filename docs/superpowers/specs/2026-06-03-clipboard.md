---
title: Clipboard
cycle: 6
status: spec
date: 2026-06-03
supersedes: none
---

# Cycle 6 — Clipboard

## Purpose
Port `copipasta` into MyMind as a `/clipboard` page: a per-device sync surface where you paste text/HTML/images/files on one device and retrieve them on another, with live sync and rich copy. copipasta is the same stack (Nuxt 4 + Nuxt UI v4 + better-auth + Drizzle + storage abstraction + SSE), so this is mostly adaptation — reuse MyMind's existing auth, storage, and DB rather than copipasta's own.

## Components (adapted from `~/Documents/GitHub/copipasta`)

### Data model (Postgres, via MyMind's Drizzle)
- `clip_threads`: `id`, `user_id` (single user — can default), `title`, `created_at`, `updated_at`. (copipasta `thread`.)
- `clip_messages`: `id`, `thread_id` FK, `device_id`, `kind` ('text'|'file'), `body_text`, `body_html` (sanitized), `created_at`. Index (thread_id, created_at). (copipasta `message`.)
- `clip_attachments`: `id`, `message_id` FK, `storage_key`, `sha256`, `size`, `mime`, `original_name`, `width`, `height`. Reuse MyMind storage (content-addressed). (copipasta `attachment`.)
- `clip_devices`: `id`, `label`, `last_seen_at`, `created_at`. Identified by a non-httpOnly cookie. (copipasta `device`; simplified — drop geo/IP.)

### Services + API (adapt copipasta routes to MyMind auth/storage)
- threads: list/create/rename/delete. `GET/POST /api/clipboard/threads`, `PATCH/DELETE /api/clipboard/threads/[id]`.
- messages: `GET /api/clipboard/threads/[id]/messages` (paginated since/cursor), `POST` (text: `{bodyText, bodyHtml?}`), `POST /api/clipboard/threads/[id]/upload` (file → storage → attachment row).
- live: `GET /api/clipboard/threads/[id]/stream` (SSE; in-process pubsub EventEmitter) + polling fallback.
- devices: `POST /api/clipboard/devices/register` (sets device cookie), `GET /api/clipboard/devices`.
- All auth-gated (session). HTML sanitized server-side (DOMPurify/isomorphic) on text messages with `bodyHtml`.
- File serving: reuse the storage `get` + an authed `GET /api/clipboard/files/[key]` (owner-checked) — or reuse the images serve pattern.

### UI (port the chat components)
- `app/pages/clipboard.vue` — thread view (split by device: current device right, others left) + composer. Sidebar nav "Clipboard" (`i-lucide-clipboard`).
- Components `app/components/clipboard/*`: Thread, Composer (paste text+HTML, drag-drop files, ⌘↵ send), MessageBubble, MessageText, MessageImage, MessageFile, CopyButtons (copy-rich/raw/image). Composables `useClipboard` (copy strategies), `useThreadStream` (SSE + polling), `useClipDevice` (register).

## Testing & validation
- Unit (vitest): HTML sanitization (script stripped), device-split classification (mine vs others) if extractable as pure fn.
- Integration: create a thread; POST a text message → appears; upload a file → attachment stored + served; SSE delivers a new message to a listener (or polling fallback).
- `playwright-cli`: clipboard page renders; paste/send text → bubble appears; copy button copies.
- Gates: typecheck/build/test.

## Non-goals
Multi-user sharing/invites (copipasta had admin/invites — MyMind is single-user, drop them); cross-process pubsub/Redis (single-instance EventEmitter is fine; note for scale); geo/IP device tracking.

## Definition of done
A working `/clipboard` page: paste text/images/files on one device, see them live on another, with rich copy and device attribution — reusing MyMind auth + storage. Wiki `clipboard.md`; handover; roadmap cycle-6 → shipped → **all 6 cycles complete**.
