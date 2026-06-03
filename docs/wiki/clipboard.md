---
title: Clipboard
status: shipped
cycle: 6
updated: 2026-06-03
---

# Clipboard

A copipasta-style device-sync clipboard: paste text/HTML/images/files on one device, retrieve live on another, with rich copy. Ported into MyMind reusing its auth + storage + DB.

## Data model (`server/db/schema/clipboard.ts`)
- `clip_threads` (id, user_id, title, timestamps), `clip_messages` (id, thread_id, device_id, kind text|file, body_text, body_html, created_at; index (thread_id, created_at)), `clip_attachments` (id, message_id, storage_key, sha256, size, mime, original_name, width, height), `clip_devices` (id, label, last_seen_at, created_at).

## Service + API (`server/services/clipboard.ts`, `server/api/clipboard/*`)
- threads CRUD; `messages.get` (since/limit, joins attachments), `messages.post` (text — `bodyHtml` sanitized via `shared/utils/sanitize-html.ts`), `upload.post` (multipart → `storage().put` → file message), `stream.get` (SSE), `devices/register` (sets `clip_device` cookie), `files/[key]` (authed serve, nosniff). Live sync via `server/utils/clip-pubsub.ts` (module EventEmitter: `publish`/`subscribe`). All auth-gated.

## UI (`app/pages/clipboard.vue`, `app/components/clipboard/*`)
Ported chat components: Thread (history + live stream + dedup), Composer (paste text+HTML, drag-drop upload, ⌘↵ send), MessageBubble (device left/right split), MessageText (MDC/sanitized HTML), MessageImage/MessageFile, CopyButtons. Composables: `useClipboard` (copy-rich/raw/image with legacy fallback), `useThreadStream` (SSE + polling fallback), `useClipDevice` (cookie-based device register). Sidebar "Clipboard" nav.

## Notes / follow-ups
Single-user (no invites/multi-user); single in-process EventEmitter (Redis for multi-instance); single default thread in the UI (schema supports many); a hydration warning from the client-only thread resolve (consider `<ClientOnly>`).
