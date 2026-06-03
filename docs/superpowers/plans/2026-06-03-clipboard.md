# Clipboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Port copipasta into MyMind as `/clipboard`: paste text/images/files, live sync across devices, rich copy — reusing MyMind's auth + storage + DB.

**Architecture:** `clip_threads`/`clip_messages`/`clip_attachments`/`clip_devices` tables; services + Nitro routes (incl. SSE via in-process EventEmitter pubsub); ported chat UI components.

**Tech Stack:** Nuxt 4 + Nuxt UI v4, Drizzle/Postgres, MyMind storage abstraction, SSE, isomorphic-dompurify, Vitest, playwright-cli.

**Source:** `~/Documents/GitHub/copipasta` — `server/schemas/*.pg.ts`, `server/api/threads/**`, `app/components/chat/*`, `app/composables/{useClipboard,useThreadStream,useDevice}.ts`, `shared/sanitize.ts`, `server/utils/pubsub.ts`.

---

### Task 1: clipboard schema + services + sanitize
**Files:** `server/db/schema/clipboard.ts` (+barrel), migration; `server/services/clipboard.ts`; `shared/utils/sanitize-html.ts`; `test/sanitize.test.ts`.
- [ ] Schema: `clip_threads` (id, userId nullable, title, created_at, updated_at), `clip_messages` (id, thread_id, device_id, kind, body_text, body_html, created_at; index (thread_id, created_at)), `clip_attachments` (id, message_id, storage_key, sha256, size, mime, original_name, width, height), `clip_devices` (id, label, last_seen_at, created_at). Migrate + verify.
- [ ] `pnpm add isomorphic-dompurify`. `sanitize-html.ts` `sanitizeHtml(html)` (strip script/event handlers) — TDD: `<script>` removed, `<b>` kept, `onclick` stripped.
- [ ] `clipboard.ts` service: threads (list/create/rename/delete), messages (listMessages({threadId, since?, limit}), createTextMessage({threadId, deviceId, bodyText, bodyHtml?}) → sanitize bodyHtml, createFileMessage({threadId, deviceId, attachment})), devices (registerDevice(label?), touchDevice(id)). Reuse `storage()` for blobs.
- [ ] typecheck + test + commit.

### Task 2: API + SSE pubsub
**Files:** `server/utils/clip-pubsub.ts` (EventEmitter), `server/api/clipboard/threads/{index.get,index.post,[id]/index.patch,[id]/index.delete}.ts`, `server/api/clipboard/threads/[id]/{messages.get,messages.post,upload.post,stream.get}.ts`, `server/api/clipboard/devices/{index.get,register.post}.ts`, `server/api/clipboard/files/[key].get.ts`.
- [ ] pubsub: `publish(threadId, event)` / `subscribe(threadId, cb)` over a module-level EventEmitter.
- [ ] threads CRUD; messages GET (paginated) + POST text (publish after insert); upload (multipart → `processUpload`? no — clipboard keeps originals; just `storage().put` raw + attachment row + message; publish); stream (SSE: set headers, subscribe, write events, catch-up via Last-Event-ID/since, cleanup on close); devices register (set `clip_device` cookie) + list; files serve (authed, by key, stream from storage). All under `/api/clipboard` (auth-gated).
- [ ] Smoke: create thread, POST text, GET messages returns it; register device sets cookie; upload returns attachment; (SSE: curl the stream briefly and confirm a posted message arrives). Commit.

### Task 3: UI port
**Files:** `app/components/clipboard/{Thread,Composer,MessageBubble,MessageText,MessageImage,MessageFile,CopyButtons}.vue`, `app/composables/{useClipboard,useThreadStream,useClipDevice}.ts`, `app/pages/clipboard.vue`, sidebar nav.
- [ ] Port the copipasta chat components + composables, adapting: API base `/api/clipboard/*`; auth via MyMind (drop copipasta's `useAuth`/invites); device register on mount; Nuxt UI v4 components. Keep paste (text+HTML), drag-drop upload, ⌘↵ send, device left/right split, copy-rich/raw/image.
- [ ] `clipboard.vue`: load/create a default thread, render Thread + Composer; live via `useThreadStream`. Sidebar "Clipboard" nav (`i-lucide-clipboard`).
- [ ] typecheck + build + commit.

### Task 4: E2E + handover + merge
- [ ] Gates typecheck/build/test.
- [ ] playwright-cli: `/clipboard` renders; type + send a text message → bubble appears; (paste/upload if feasible); a copy button works. Screenshot.
- [ ] Handover (deferrals: multi-user/invites, Redis pubsub for multi-instance, geo device tracking); wiki `clipboard.md`; roadmap cycle-6 → shipped (ALL CYCLES DONE). Final review; fix blockers; merge.

---

## Self-Review
Coverage: schema+sanitize (T1) ✓ · CRUD+upload+SSE+devices API (T2) ✓ · UI port (T3) ✓ · validation/docs/merge (T4) ✓. Reuses MyMind storage+auth (drops copipasta invites/multi-user). Pure unit: sanitizeHtml. SSE is single-instance EventEmitter (noted for scale).
