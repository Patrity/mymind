---
title: Multimodal agent — image + file attachments (Qwen3.6 VLM; files via PDF→image render) — Cycle 39
cycle: 39
date: 2026-06-29
status: built + gates green + final whole-branch review PENDING — NOT merged, NOT deployed, live acceptance against the rig PENDING
branch: feat/multimodal-agent (off master 152b01e; worktree .claude/worktrees/multimodal; subagent-driven, 9 tasks + docs)
spec: ../superpowers/specs/2026-06-28-multimodal-agent-design.md
plan: ../superpowers/plans/2026-06-28-multimodal-agent.md
docs:
  - ../wiki/agent.md (Multimodal attachments section; cycle bumped 38→39)
  - ../superpowers/plans/00-roadmap.md (cycle-39 row)
problem: >
  The /agent chat was text-only: AgentMessage.content was a string and the WS text frame carried only
  {text, speak}. Tony wanted to attach images + files (paste/drag/picker, like the clipboard input) and
  have the natively-multimodal reasoning model (Qwen3.6-35B-A3B VLM) decide from the prompt whether to
  reason over the attachment or call a tool (e.g. edit_image on an attached photo).
keydecision: >
  vLLM's OpenAI-compatible API forwards image_url/video_url/audio_url content parts ONLY — there is NO
  generic file/document part. So the original spec's "native file parts" approach was infeasible. PIVOT
  (user-approved, 2026-06-29): files become images the VLM can SEE. PDFs render to page images
  (pdf-to-img + sharp→webp); text-like files decode to text parts; other binary is rejected at the
  composer. Everything the model receives is a text part or an image part. AgentContentPart is
  text|image only — no file part anywhere. (The branch-gating runtime probe in the original plan was
  dropped: image_url is the only model-facing part and is certain for a VLM serving stack.)
shipped:
  - "**Content parts** (`run.ts`/`types.ts`): `AgentMessage.content: string | AgentContentPart[]` where `AgentContentPart = {type:'text'} | {type:'image'}`. `messageText()` (join text parts for display/persist) + `toModelContent(role, content)` (map to AI SDK streamText; cycle-37 `redactImageUrlsForModel` applies to TEXT parts only; image data-URLs pass through). The `run.ts` history map routes through `toModelContent`."
  - "**PDF→image renderer** (`server/lib/agent/pdf-render.ts`): `renderPdfToImages(bytes, {maxPages=8, maxEdge=1600})` → webp page images via `pdf-to-img` (pdfjs + prebuilt @napi-rs/canvas) + sharp downscale. Pure, never-throws (returns [] on any failure). Real one-page-PDF fixture test. New dep `pdf-to-img@6.2.0` (bundles like sharp; no infra change)."
  - "**`buildUserMessageParts`** (`server/lib/agent/attachments.ts`): text + attachments → `string | AgentContentPart[]`. image→image part (bytes inline base64 data-URL); file+pdf→render→one image part per page (or unavailable note); text-like file→text part; unsupported→note; unreadable→note. Injectable `readBytes` + `renderPdf` for testing. `AttachmentRef` + `isTextLikeMime`."
  - "**File storage + endpoints** (`server/services/files.ts`, `server/api/agent/files.post.ts`, `files/[id].get.ts`) — saveFile/getFileBytes mirror createImage/getImageBytes (storage().put stream / get + buffer). POST stores the raw blob → `{id, kind:'file', mime, name, size}`; GET streams it (auth-gated by the global middleware; content-disposition attachment). **Owns migration 0025_sparkling_smasher** (new `agent_files` table + `conversation_messages.attachments` jsonb)."
  - "**Persist + DTO** (`conversations.ts`, `shared/types/conversation.ts`): canonical `AttachmentRef` in shared types; `ConversationMessageDTO.attachments`; `NewConvMessage.attachments` → persisted in appendMessages; `msgToDTO` returns them. `getAgentHistory` stays text-only (prior-turn attachments are NOT re-sent to the model in v1)."
  - "**WS + orchestrator wiring** (`ws.ts`, `orchestrator.ts`, `run.ts`, `ai-tools.ts`, `types.ts`): the text frame carries `attachments`; `handleTurn` builds the multimodal user message via `buildUserMessageParts` (readBytes dispatches getImageBytes/getFileBytes); the attachment IMAGE ids flow unbroken ws→handleTurn→run ctx→runAgent→buildAiTools→`ToolContext.attachmentImageIds`. ws persists attachments on the USER message only. Voice path unaffected (attachments default [])."
  - "**edit_image targets the attachment** (`images.ts`, `tools.ts`): `resolveSourceImageId(explicitId, {preferIds})` tries the turn's attachment images before the newest-generated fallback; `edit_image` passes `ctx.attachmentImageIds`. So 'make the hat blue' on an attached photo edits that photo."
  - "**Composer UX** (`Composer.vue`, `useVoice.ts`): paste / drag-drop / file-picker for images+files; removable preview chips (image thumbnail / file name+size); type allow-list (image/*, application/pdf, text-like) + caps (≤4, ≤20MB) with toasts; on send uploads (images→/api/upload, files→/api/agent/files) then `sendText(text, speak, attachments)` (WS frame gains `attachments`); attachment-only sends allowed; text-only unchanged."
  - "**Transcript render** (`Transcript.vue`, `useVoice.ts`, `agent/index.vue`): `TranscriptEntry.attachments`; user turns render image thumbnails (/api/images/<id>/raw) + file download chips (/api/agent/files/<id>). LIVE via a `pendingUserAttachments` stash (set in sendText, consumed when the server echo creates the user entry); RELOAD via the getConversation DTO."
verified:
  - "Whole-branch gate: **typecheck 0 · `pnpm vitest run` 671 tests / 107 files · `pnpm build` exit 0.** Migration 0025 generated (purely additive) + applied to the local DB (agent_files + conversation_messages.attachments verified present)."
  - "Built subagent-driven (9 tasks, sonnet implementers + two-verdict reviews per task). Additive-first ordering kept typecheck green throughout; the image-ids chain was reviewed hop-by-hop (Task 6). Auth coverage of /api/agent/files/* confirmed (not in PUBLIC_PREFIXES → gated). Task 2 was implemented inline by the controller after the first subagent stalled on a non-interactive `pnpm add` prompt — fixed with CI=1 (lesson recorded)."
  - "Reliable-render invariant intact: GENERATED/edited images still never give the model a URL (server authors the embed; history urls redacted). User ATTACHMENTS are a separate INPUT path — bytes inline as base64 image parts; the model never gets a fetchable /api/images URL for them either."
followups:
  - "**Final whole-branch review (opus)** — pending at handover time; run before merge."
  - "**Live acceptance against the rig** (the real proof — unit tests don't exercise the live VLM): (0) sanity an image_url part round-trips LiteLLM→vLLM→Qwen3.6; (1) attach a photo + 'what is this?' → vision description; (2) attach a photo + 'make the sky purple' → edit_image edits the ATTACHED photo, renders inline; (3) attach a PDF + 'summarize' → summary from the rendered pages; (4) reload → attachments re-render; (5) oversized/too-many/unsupported/upload-fail → clean composer error. Validate with playwright-cli (NOT MCP)."
  - "**Deploy** — push master → CD (native systemd LXC 114). Migration 0025 self-applies in CD (pnpm db:migrate). pdf-to-img pulls @napi-rs/canvas — CD's `pnpm install --frozen-lockfile` installs it (prebuilt linux-x64 binary, same model as sharp); verify the build step on the box. NO env change needed."
  - "**Minors logged (final-review triage):** T4 GET content-disposition has no filename= (nicer saved name); T8 chip v-for key collides on duplicate name+size files (latent DOM-patch bug — use index/uid); T8 dragleave overlay flicker on child enter; T9 stale-stash if WS drops mid-send (clear on reconnect); T3 no dedicated readBytes-throws test."
  - "**Deferred (spec):** multi-turn image memory (re-send/re-render prior-turn attachments); office/binary docs (docx/xlsx → needs office→pdf); audio/video; PDF page thumbnails in the transcript (v1 = file chip); render caps in /settings; file→searchable-doc-library ingestion; AI SDK v7 (canonical file model); multi-image edit compositing."
---

# Multimodal agent — image + file attachments — Cycle 39

## Why
The `/agent` chat was text-only. Tony wanted to attach images + files and let the
natively-multimodal model (Qwen3.6-35B-A3B VLM) decide from the prompt what to do — reason over the
attachment, or call a tool (edit an attached photo). This is the realization of the cycle-38 deferred
"paste/upload an image in the agent composer → editable" item, generalized to files too.

## The load-bearing constraint (why files become images)
vLLM's OpenAI API forwards **image/video/audio_url parts only — no generic file/document part**. So the
model cannot receive a PDF as a file. Everything it sees is an **image part or a text part**:
- image → native image part (bytes inline base64; the model never gets a fetchable URL).
- PDF → rendered to page images (pdf-to-img + sharp→webp, capped) → image parts (the VLM *sees* the doc).
- text-like file → decoded → text part.
- other binary → rejected at the composer (deferred).

`AgentContentPart` is **text|image only** — there is no file content-part type anywhere. (The original
spec's "native file parts" + its runtime probe were dropped after this finding; see the spec's
revision note + the 07fd701 commit.)

## What shipped
See frontmatter `shipped`. Nine subagent-driven tasks: content parts → PDF renderer → message builder
→ file storage/endpoints (+migration) → persistence/DTO → WS/orchestrator wiring → edit-from-attachment
→ composer UX → transcript render. The cycle-37/38 reliable-render path for *generated* images is
unchanged; user *attachments* are a separate input path.

## Gotchas for the next session
- **The live rig E2E is the real proof.** Unit tests assert plumbing shape, not that the live VLM
  accepts the image parts. Run the acceptance list (frontmatter follow-ups) before calling it done.
- **The model gets BYTES, never URLs** — images + rendered PDF pages are inline base64 data-URLs.
  `getImageBytes`/`getFileBytes` provide the real mime; `AttachmentRef.mime` for images is display-only.
- **PDF render caps** (8 pages / 1600px) are constants in `pdf-render.ts` — pages beyond the cap are
  silently dropped (documented limitation; surfacing in /settings is deferred).
- **Migration 0025 is additive** (new table + new column) and already applied locally; it self-applies
  on prod deploy.
- **Heavy installs in subagents need `CI=1`** (or run them in the controller) — a non-interactive
  `pnpm add` hit an interactive workspace prompt and stalled the Task-2 subagent on the 600s watchdog.
- **`pdf-to-img` → `@napi-rs/canvas`** is a native dep with prebuilt binaries (like sharp); it bundled
  with no nuxt.config change. Confirm the prod build step installs it cleanly.
