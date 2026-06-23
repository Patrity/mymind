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
- threads CRUD; `messages.get` (since/**before**/limit, joins attachments), `messages.post` (text — `bodyHtml` sanitized via `shared/utils/sanitize-html.ts`), `upload.post` (multipart → `storage().put` → file message), `stream.get` (SSE), `devices/register` (sets `clip_device` cookie), `files/[key]` (authed serve, nosniff). Live sync via `server/utils/clip-pubsub.ts` (module EventEmitter: `publish`/`subscribe`). All auth-gated.
- **`listMessages` paging modes** — `since` → *forward* catch-up (`gt(createdAt, cursor)`, ascending; used by the stream poll, unchanged). Otherwise *history* mode: returns the **newest `limit`** messages older than `before` (when given) via `desc + limit` then reversed to ascending, so the UI renders oldest→newest while the DB only ever pulls one page. `before`/`since` cursors are nudged +1ms (DTO ISO strings are ms-truncated, Postgres stores µs); the client de-dupes the re-included boundary row by `id`. Attachments for a page are fetched in **one** `inArray` query (was N+1 per file message).

## UI (`app/pages/clipboard.vue`, `app/components/clipboard/*`)
Ported chat components: Thread (history + live stream + dedup), Composer (paste text+HTML, drag-drop upload, ⌘↵ send), MessageBubble (device left/right split), MessageText (MDC/sanitized HTML), MessageImage/MessageFile, CopyButtons. Composables: `useClipboard` (copy-rich/raw/image with legacy fallback), `useThreadStream` (SSE + polling fallback, seedable poll cursor), `useClipDevice` (cookie-based device register). Sidebar "Clipboard" nav.

### Thread loading / infinite scroll (2026-06-23)
`Thread.vue` no longer loads the whole thread. On mount it fetches the **newest `PAGE_SIZE` (10)** messages, snaps to the bottom, and lazy-loads older pages as the user scrolls within `TOP_THRESHOLD_PX` of the top — each shows `USkeleton` placeholders while the page is in flight. A single **ResizeObserver**-driven scroll controller keeps the position correct as MDC markdown renders async (heights grow after mount): mode `bottom` pins to the newest (live arrivals stick only when the user is already at the bottom — no yank while reading history), `anchor` holds the top message fixed while older content prepends (zero scroll jump), `none` leaves the user alone. Programmatic scrolls set a short `suppressScrollUntil` window so the controller's own corrections aren't mistaken for the user scrolling away. Short threads use `mt-auto` to sit at the bottom, and `fillViewport()` keeps pulling older pages until the thread is scrollable (so infinite-scroll-up is always reachable). The stream's poll cursor is seeded from the newest loaded message so the polling fallback can't replay a whole page.

## Cycle 10 polish
Message bubbles show the originating **machine/device label** in the caption (`"<label> · HH:MM"`) — `listMessages` left-joins `clip_devices` to include `deviceLabel`.

## Cleanup batch (2026-06-11)
- **Layout** — `clipboard.vue` renders the thread inside `UDashboardPanel`'s `#body` slot with `:ui="{ body: '!p-0 !overflow-hidden' }"`, so the navbar pins and the message thread scrolls independently (no whole-page scroll).
- **Inline media previews** — the client reads the attachment's `mime` field (previously the wrong `mimeType`), so `image/*` attachments render inline again; a new `ClipboardMessageVideo` component embeds a `<video controls>` player for `video/*` (mp4/webm). Non-media attachments still show the file card.

## Notes / follow-ups
Single-user (no invites/multi-user); single in-process EventEmitter (Redis for multi-instance); single default thread in the UI (schema supports many); a hydration warning from the client-only thread resolve (consider `<ClientOnly>`).
