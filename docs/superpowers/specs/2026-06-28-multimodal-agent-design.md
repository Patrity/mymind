---
title: Multimodal agent — image + file attachments (native, Qwen3.6)
status: approved
date: 2026-06-28
cycle: 39
related:
  - docs/superpowers/specs/2026-06-26-qwen-image-edit-design.md (cycle 38 — edit_image; this adds the attachment source)
  - docs/wiki/agent.md (agent surface), docs/wiki/clipboard.md (the attachment-input UX to mirror)
  - AI SDK v6 (ai@6.0.198) multimodal message parts; Qwen3.6-35B-A3B natively multimodal (image + document + video)
---

# Multimodal agent — image + file attachments

Let Tony attach images and files to the `/agent` chat (paste / drag / file-picker, like the
clipboard input). The reasoning model — **Qwen3.6-35B-A3B, which is natively multimodal** — sees
the attachment as a message **content part** and, from the prompt, **decides what to do**: reason
over it ("what's in this?", "summarize this PDF") or call a tool (e.g. `edit_image` to edit an
attached photo). No separate vision model, no `analyze_image` tool, no per-turn model routing — the
agent's existing brain handles it.

## Background / why this shape

- The agent pipeline is **text-only today**: `AgentMessage.content` is a `string`, and `ws.ts`'s
  text frame carries only `{ text, speak }`. Making it multimodal is almost entirely *our* plumbing.
- AI SDK v6 (`ai@6.0.198`, already installed) supports multimodal user messages: `content` as an
  array of parts — `{ type:'text', text }`, `{ type:'image', image }`, `{ type:'file', data, mediaType }`.
- Qwen3.6-35B-A3B (the `reasoning` model) is a unified MoE VLM with a vision encoder; it ingests
  images, documents, and video natively (beats the standalone Qwen3-VL on VL benchmarks).
- **The model must receive the bytes, not a URL.** `/api/images/<id>/raw` is auth-gated and
  internal; the self-hosted model behind LiteLLM can't fetch it. So attachment parts carry the
  **bytes inline (base64 data)**, read server-side from storage at message-build time.

## The one real unknown — verify FIRST

Qwen3.6 *supports* image + file parts, but the **serving stack** (LiteLLM → vLLM) must forward
OpenAI-format `image_url` / file content parts to it. **Task 1 is a runtime probe** (a tiny script /
manual call: send an `image_url` part and a file part through the configured `reasoning` provider and
confirm the model responds to the content). Outcome gates the files path:
- image parts pass → proceed (near-certain for a VLM serving stack).
- file parts pass → native files (the chosen approach).
- file parts DON'T pass → **fallback: text-extraction for files** (extract text server-side, send as
  a text part). Images stay native regardless. (Documented fallback; not the default.)

## Architecture

### Content parts (the core change)
`server/lib/agent/run.ts` + `types.ts`:
- `AgentMessage.content: string | AgentContentPart[]` where
  `AgentContentPart = { type:'text'; text:string } | { type:'image'; image: string /*base64 data url*/; mediaType:string } | { type:'file'; data:string /*base64*/; mediaType:string; name?:string }`.
- `runAgent` maps each message to the AI SDK shape for `streamText`: a string stays a string; an
  array maps to `[{type:'text',...}, {type:'image', image: <dataUrl>}, {type:'file', data, mediaType}]`.
  The cycle-37 `redactImageUrlsForModel` applies to **text parts only**.
- Everything downstream that assumes `content: string` (history concat, persistence) handles the
  array via a `messageText(content)` helper (joins text parts; ignores media) for display/log.

### Attachment upload + transport
- **Composer** (`app/components/voice/Composer.vue`): add paste / drag-drop / a file-picker button
  for images + files (mirror the clipboard input's idiom). Selected attachments show as removable
  preview chips (image thumbnail / file name+size) before send. Cap count + per-file size.
- On send, each attachment is uploaded over HTTP and the turn references the results:
  - images → existing `POST /api/upload` (sharp→webp, gallery row) → `{ id, kind:'image', url, mime }`.
  - files → new `POST /api/agent/files` (raw blob via `storage().put`, no image processing) →
    `{ id, kind:'file', mime, name, size }`.
- The composer then sends the WS turn: `{ type:'text', text, speak, attachments: [{ id, kind, mime, name? }] }`.

### WS + orchestrator → multimodal message
- `ws.ts` accepts `attachments` on the `text` control frame and passes them to the turn.
- The turn builds the user `AgentMessage`: a `text` part for `text` + one media part per attachment.
  Media bytes are read server-side (`getImageBytes(id)` for images; the files-store get for files),
  base64-encoded, and placed in the part. (A helper `buildUserMessageParts(text, attachments)`.)
- `ToolContext` gains `attachmentImageIds?: string[]` (the image attachments of the turn). Threaded
  through `buildAiTools`.

### Edit-from-attachment
- `edit_image`'s source resolution: if `source_image_id` is omitted, use the turn's **attachment
  image** (from `ctx.attachmentImageIds`, newest) when present; else fall back to the newest
  generated image (cycle-38 behavior). So "make the hat blue" on an attached photo edits the photo.
- `resolveSourceImageId` gains an optional `preferIds?: string[]` (the attachment ids, checked live
  first); the tool passes `ctx.attachmentImageIds`.

### Persist + reload rendering
- Migration: `conversation_messages.attachments jsonb` (`[{ id, kind, mime, name?, url }]`).
- On persist (`appendMessages`), the user turn records its `attachments`.
- `getAgentHistory` / the message DTO returns `attachments`; on reload the **transcript renders user
  attachments** — image thumbnails (`/api/images/<id>/raw`, authed UI) and a file chip (name +
  download link) — alongside the user text. (`Transcript.vue` user branch gains an attachments row.)
- Live: the composer's pre-send preview + the user-turn echo show the same.
- History to the model: re-sending full image bytes every turn is costly. **v1: include attachment
  bytes only for the CURRENT turn**; in prior turns, attachments are represented to the model as a
  text note (`[attached image]` / `[attached file: name]`) — the model already reasoned over them
  when they were current, and `edit_image` targets by id, not by re-vision. (Re-attaching for
  follow-up vision is a documented limitation; full multi-turn image memory is deferred.)

### The model decides
Qwen3.6 receives the prompt + attachment parts and either answers (infer) or calls a tool. The
cycle-37/38 reliable-render for *generated/edited* images is unchanged (model still gets no URL for
those; server authors their embed). User-*attached* images are input parts, rendered from the stored
attachment ref — a separate path from generated-image output.

## Data flow

```
composer: text + [img.png, doc.pdf]
  → upload img → /api/upload → {id:G1, kind:image}; upload pdf → /api/agent/files → {id:F1, kind:file}
  → WS {type:'text', text, attachments:[{id:G1,kind:image,mime}, {id:F1,kind:file,mime,name}]}
ws.ts → handleTurn(text, attachments)
  → buildUserMessageParts: [{type:text,text}, {type:image, image:<base64 G1>}, {type:file, data:<base64 F1>, mediaType}]
  → runAgent(messages with parts, ctx.attachmentImageIds=[G1])
  → Qwen3.6 sees image+pdf+text → answers OR calls edit_image (source defaults to G1)
  → persist user msg with attachments:[{id:G1,...},{id:F1,...}] ; reload renders thumbnails
```

## Error handling
- Upload failure → composer shows the error, doesn't send the turn (or sends text-only with a note).
- Unreadable attachment bytes at build time → skip that part + a text note `[attachment unavailable]`; never throw the turn.
- Oversized / too many attachments → composer rejects before upload (configurable caps).
- File-part-unsupported (probe fallback) → files become text-extraction parts.

## Testing
Unit:
- `buildUserMessageParts(text, attachments)` (pure, with mocked byte reads): text-only → string;
  text+image → parts with base64 image; text+file → file part; unreadable → text-note fallback.
- `messageText(content)` helper: string passthrough; parts → joined text (media ignored).
- `runAgent` message mapping: array content → AI SDK parts; redaction applies to text parts only;
  string content unchanged (regression).
- `resolveSourceImageId(explicit, { preferIds })`: preferIds (attachment) wins over newest-generated;
  falls back when absent.
- `edit_image` handler: with `ctx.attachmentImageIds`, edits the attachment; without, newest-generated.
- files endpoint handler (stores blob, returns ref).

Live (post-merge, against the rig):
1. Probe (Task 1) passes for image (+ file) parts.
2. Attach a photo + "what is this?" → the model describes it (native vision).
3. Attach a photo + "make the sky purple" → `edit_image` edits the ATTACHED photo, renders inline.
4. Attach a PDF + "summarize this" → the model summarizes (native file part, or extraction fallback).
5. Reload the conversation → user attachments re-render as thumbnails/file chips.
6. Upload failure / oversized → clean composer error, no crash.

## Acceptance criteria
- Paste/drag/attach images + files in `/agent`; they preview, upload, and send with the turn.
- The model reasons over an attached image/file (infer) OR edits an attached image (`edit_image`
  source = the attachment), chosen from the prompt — no separate vision tool or model routing.
- Attachments persist on the message and re-render on reload.
- Image attachments are certain; files are native if the probe passes, else text-extraction.
- No regression to text-only turns, generated-image render, or the cycle-37/38 reliable-render.

## Deferred (documented, not built)
- **Multi-turn image memory** (re-sending attachment bytes for follow-up vision on a prior turn).
- **Audio / video** attachments (Qwen3.6 supports video; out of scope here).
- **Promoting file attachments into the searchable doc library** (chunk/embed) — v1 stores the blob
  + lets the model read it; library ingestion is a follow-on.
- **AI SDK v7 upgrade** (canonical file model + provider file caching) — separate migration cycle.
- **Multi-image edit compositing** (cycle-38 deferral, unchanged).
