---
title: Clipboard
cycle: 6
status: shipped
date: 2026-06-03
shipped:
  - clip_threads/clip_messages/clip_attachments/clip_devices schema
  - HTML sanitization (isomorphic-dompurify) for rich-paste bodyHtml (TDD)
  - clipboard service (threads CRUD, messages list/text/file, devices register/touch/list)
  - API under /api/clipboard (auth-gated): threads CRUD, messages get/post, multipart upload (reuses MyMind storage), SSE stream (in-process EventEmitter pubsub), device register (sets clip_device cookie), authed file serve
  - ported copipasta chat UI (Thread, Composer, MessageBubble/Text/Image/File, CopyButtons) + composables (useClipboard copy strategies, useThreadStream SSE+polling, useClipDevice) + /clipboard page + sidebar nav
  - device left/right split, paste (text+HTML), drag-drop upload, ⌘↵ send, rich/raw/image copy, live sync
deferred:
  - "Multi-user sharing + invites (copipasta had them — MyMind is single-user, dropped)"
  - "Redis pub/sub for multi-instance SSE (single in-process EventEmitter; fine for single homelab instance)"
  - "Geo/IP device tracking + a device-management page (dropped; device is just a cookie + label)"
  - "Multiple threads UI (schema supports many; UI uses a single default thread)"
  - "Hydration mismatch on /clipboard from client-only thread resolve (page recovers; consider <ClientOnly> wrap) — same client-only pattern as the auth guard; cosmetic dev-console warning"
next_seam: "All 6 roadmap cycles shipped. Next work is the accumulated fast-follows (see handovers): a login flow hardening, video->webm transcode, EXIF scrub, OCR-failed notifications, github->memory, bridget data migration, and the <ClientOnly>/SSR-guard cleanup for the hydration warnings."
validation: "typecheck + build + 78 vitest tests; playwright-cli E2E (page renders, device cookie, send text -> bubble, persists on reload, copy buttons no-error, file upload -> file bubble); curl API recap (thread + 4 messages incl. file)."
---

# Cycle 6 — Clipboard (handover)

Ported copipasta into MyMind as `/clipboard`, reusing MyMind's auth, storage, and DB. Paste text/HTML/images/files on one device, see them live (SSE) on another, with device attribution and rich copy. The stacks matched (both Nuxt 4 + Nuxt UI v4 + better-auth + Drizzle + storage abstraction), so this was adaptation: swap the API base to `/api/clipboard/*`, drop copipasta's multi-user/invite/device-management surface, reuse MyMind file serving + MDC + the cycle-6 HTML sanitizer.

## Key decisions
- **Single-user simplification**: dropped invites/admin/multi-user and per-device naming UI; device is a `clip_device` cookie + label, driving only the left/right bubble split.
- **In-process SSE** via a module EventEmitter (`server/utils/clip-pubsub.ts`) — fine for one homelab instance; Redis is the noted multi-instance follow-up.
- **Reused MyMind storage** (content-addressed) for attachments; clipboard keeps originals (no webp re-encode).

## Where things live
- Schema `server/db/schema/clipboard.ts`; service `server/services/clipboard.ts`; sanitize `shared/utils/sanitize-html.ts`.
- API `server/api/clipboard/*`; pubsub `server/utils/clip-pubsub.ts`.
- UI `app/components/clipboard/*`, `app/composables/{useClipboard,useThreadStream,useClipDevice}.ts`, `app/pages/clipboard.vue`.

---

## 🎉 All 6 roadmap cycles shipped
Foundation+Spine · AI Enrichment · Capture+Images · Tasks+Projects · Memory+MCP · Clipboard. See `docs/superpowers/plans/00-roadmap.md` for the full status table and the accumulated fast-follow backlog across handovers.
