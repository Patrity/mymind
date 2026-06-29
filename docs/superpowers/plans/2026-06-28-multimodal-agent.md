# Multimodal Agent (image + file attachments) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Tony attach images + files to the `/agent` chat; the natively-multimodal reasoning model (Qwen3.6) sees them as message content parts and decides — reason over them, or call `edit_image` on an attached image.

**Architecture:** Make `AgentMessage.content` support content parts (text/image/file); the composer uploads attachments over HTTP then sends the turn over the WS with attachment refs; the orchestrator reads the bytes and builds a multimodal user message (bytes inline as base64 — the self-hosted model can't fetch our auth-gated URLs); `runAgent` maps parts to AI SDK v6 `streamText`; `edit_image` defaults its source to the turn's attachment; attachments persist on the message and re-render on reload.

**Tech Stack:** Nuxt 4 / Nitro, AI SDK v6 (`ai@6.0.198`) multimodal message parts, Drizzle (migration), Vitest, Nuxt UI v4, crossws (the agent WS).

## Prerequisite (controller-run, before Task 1 — NOT a subagent task)

The reasoning **model** (Qwen3.6) is multimodal, but the **serving stack** (LiteLLM→vLLM) must forward OpenAI `image_url` + file content parts. The controller probes this against the live rig (from the prod box, which can reach the rig) before the build:
- image part passes (near-certain) → proceed.
- file part passes → native files (Tasks 3/5 send file bytes as `file` parts).
- file part FAILS → fallback: Tasks 3/5 send files as a **text part** of extracted text. Images stay native.

The plan below is written for the native-file path; the fallback only changes Task 5's `buildUserMessageParts` file branch (image part → text part of extracted text) — noted there.

## Global Constraints

- **The model gets BYTES, not URLs.** Attachment parts carry base64 data read server-side from storage; never an `/api/images/<id>/raw` URL (auth-gated + unreachable by the model).
- AI SDK v6 user-message parts: `{ type:'text', text }`, `{ type:'image', image: <dataURL string> }`, `{ type:'file', data: <base64>, mediaType, filename? }`. `runAgent` already maps `messages`→`streamText`; extend that map.
- The cycle-37 `redactImageUrlsForModel` applies to **text parts only**. The cycle-37/38 reliable-render for *generated* images is unchanged (generated images: model gets no URL, server authors the embed). User *attachments* are a separate input path.
- v1: send attachment bytes only for the **current** turn; prior-turn attachments are text notes (`getAgentHistory` stays text-only). Multi-turn image memory is deferred.
- `edit_image` defaults its source to the turn's attachment image when present, else newest-generated (cycle-38).
- **Package manager `pnpm`.** Gates: typecheck + test + build. Lint red repo-wide — NOT a gate. App under `app/`, server under `server/`.
- **Every dispatch carries a file allow-list + "ADD/EDIT, don't delete to pass a gate" + a pre-commit `git status --short` scope check.** (Cycle-37 lesson.)

### Verified facts (trust these)
- `AgentMessage` = `{ role: 'system'|'user'|'assistant'; content: string }` (`server/lib/agent/run.ts:13`). `runAgent` maps messages at `run.ts:73`.
- `ToolContext` = `{ signal; requestApproval? }` (`server/lib/agent/types.ts`). `buildAiTools(registry, hooks)` builds `ctx` (`ai-tools.ts:24`).
- `handleTurn(userText, history, deps)` (`server/lib/voice/orchestrator.ts`) assembles the turn; `ws.ts` `message()` handles the `{type:'text', text, speak}` control frame and calls `handleTurn`.
- `appendMessages(convId, msgs[{role,content,modality,toolCalls}])` + `getAgentHistory` (returns `{role,content}[]`) + the `ConversationMessage` DTO (`conversations.ts`). `conversation_messages` cols: content, modality, toolCalls (jsonb) — schema `server/db/schema/conversations.ts`.
- `POST /api/upload` → `createImage` → an image row (id + servable). `serveUrl(row)` → `/api/images/<id>/raw`. `getImageBytes(id)` → `{bytes, mime}|null` (`services/images.ts`, cycle 37).
- `resolveSourceImageId(explicitId)` (cycle 38) → newest-generated when null. `edit_image` calls it.
- Composer: `app/components/voice/Composer.vue` (text + `sendText`). Transcript: `app/components/voice/Transcript.vue` (user = plain `<p>`, assistant = `MdView`).

---

### Task 1: Content parts on `AgentMessage` + `runAgent` mapping

**Files:** Modify `server/lib/agent/run.ts`, `server/lib/agent/types.ts`; Test `server/lib/agent/content-parts.test.ts`

**Interfaces produced:**
- `AgentContentPart = { type:'text'; text:string } | { type:'image'; image:string; mediaType:string } | { type:'file'; data:string; mediaType:string; filename?:string }`
- `AgentMessage.content: string | AgentContentPart[]`
- `messageText(content: string | AgentContentPart[]): string` (joins text parts; ignores media) — exported from run.ts.

- [ ] **Step 1: Failing test** — `server/lib/agent/content-parts.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { messageText, toModelContent } from './run'
import type { AgentContentPart } from './run'

describe('messageText', () => {
  it('passes a string through', () => { expect(messageText('hi')).toBe('hi') })
  it('joins text parts and ignores media', () => {
    const parts: AgentContentPart[] = [
      { type: 'text', text: 'look at this' },
      { type: 'image', image: 'data:image/webp;base64,AAAA', mediaType: 'image/webp' }
    ]
    expect(messageText(parts)).toBe('look at this')
  })
})

describe('toModelContent', () => {
  it('maps parts to AI SDK shape (image part preserved, text redaction applied)', () => {
    const out = toModelContent('assistant', [
      { type: 'text', text: 'see ![x](/api/images/y/raw)' },
      { type: 'image', image: 'data:image/webp;base64,AAAA', mediaType: 'image/webp' }
    ]) as AgentContentPart[]
    expect(out[0]).toEqual({ type: 'text', text: 'see [image]' })   // redaction on text part
    expect(out[1]).toMatchObject({ type: 'image' })
  })
  it('redacts a plain string assistant message', () => {
    expect(toModelContent('assistant', '![x](/api/images/y/raw)')).toBe('[image]')
  })
})
```

- [ ] **Step 2: Run → fail** (`pnpm vitest run server/lib/agent/content-parts.test.ts`).

- [ ] **Step 3: Implement** — in `types.ts` add `AgentContentPart` (export). In `run.ts`:
  - Change `AgentMessage` to `{ role: ...; content: string | AgentContentPart[] }` and re-export `AgentContentPart`.
  - Add:

```ts
export function messageText(content: string | AgentContentPart[]): string {
  return typeof content === 'string' ? content : content.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n')
}

/** Map our content → the AI SDK message content for streamText. Redaction applies to text only. */
export function toModelContent(role: AgentMessage['role'], content: string | AgentContentPart[]): unknown {
  const redact = (t: string) => role === 'assistant' ? redactImageUrlsForModel(t) : t
  if (typeof content === 'string') return redact(content)
  return content.map(p => p.type === 'text' ? { type: 'text', text: redact(p.text) }
    : p.type === 'image' ? { type: 'image', image: p.image }
    : { type: 'file', data: p.data, mediaType: p.mediaType, filename: p.filename })
}
```
  - At `run.ts:73`, replace the `.map(...)` redaction with: `messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: toModelContent(m.role, m.content) }))`.

- [ ] **Step 4: Run → pass.** `pnpm typecheck` → fix any `content: string` assumers via `messageText(...)` (e.g. the orchestrator's `assistantText` concat reads deltas, not message content — likely no change; chat.post.ts builds string messages — unchanged). Confirm 0 errors.

- [ ] **Step 5: Commit** `feat(agent): content parts on AgentMessage + streamText mapping`.

---

### Task 2: `buildUserMessageParts` (assemble a multimodal user turn)

**Files:** Create `server/lib/agent/attachments.ts`; Test `server/lib/agent/attachments.test.ts`

**Interfaces:**
- Consumes: `AgentContentPart` (Task 1); a byte reader.
- Produces: `AttachmentRef = { id:string; kind:'image'|'file'; mime:string; name?:string }`; `buildUserMessageParts(text: string, attachments: AttachmentRef[], readBytes: (a: AttachmentRef) => Promise<{ bytes: Buffer; mime: string } | null>): Promise<string | AgentContentPart[]>`.

- [ ] **Step 1: Failing test** — `attachments.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { buildUserMessageParts } from './attachments'

const read = vi.fn(async (a: { id: string }) => ({ bytes: Buffer.from([1, 2, 3]), mime: 'image/webp' }))

describe('buildUserMessageParts', () => {
  it('no attachments → plain string', async () => {
    expect(await buildUserMessageParts('hi', [], read)).toBe('hi')
  })
  it('image attachment → text + base64 image part', async () => {
    const out = await buildUserMessageParts('look', [{ id: 'g1', kind: 'image', mime: 'image/webp' }], read) as any[]
    expect(out[0]).toEqual({ type: 'text', text: 'look' })
    expect(out[1].type).toBe('image')
    expect(out[1].image).toMatch(/^data:image\/webp;base64,/)
  })
  it('file attachment → file part', async () => {
    const rf = vi.fn(async () => ({ bytes: Buffer.from([9]), mime: 'application/pdf' }))
    const out = await buildUserMessageParts('summarize', [{ id: 'f1', kind: 'file', mime: 'application/pdf', name: 'a.pdf' }], rf) as any[]
    expect(out[1]).toMatchObject({ type: 'file', mediaType: 'application/pdf', filename: 'a.pdf' })
    expect(out[1].data).toMatch(/^[A-Za-z0-9+/=]+$/)
  })
  it('unreadable attachment → text note, never throws', async () => {
    const out = await buildUserMessageParts('look', [{ id: 'x', kind: 'image', mime: 'image/webp' }], async () => null) as any[]
    expect(out.some(p => p.type === 'text' && p.text.includes('[attachment unavailable]'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `server/lib/agent/attachments.ts`:

```ts
import type { AgentContentPart } from './run'

export interface AttachmentRef { id: string; kind: 'image' | 'file'; mime: string; name?: string }

export async function buildUserMessageParts(
  text: string,
  attachments: AttachmentRef[],
  readBytes: (a: AttachmentRef) => Promise<{ bytes: Buffer; mime: string } | null>
): Promise<string | AgentContentPart[]> {
  if (!attachments.length) return text
  const parts: AgentContentPart[] = []
  if (text) parts.push({ type: 'text', text })
  for (const a of attachments) {
    const got = await readBytes(a).catch(() => null)
    if (!got) { parts.push({ type: 'text', text: `[attachment unavailable${a.name ? `: ${a.name}` : ''}]` }); continue }
    const b64 = got.bytes.toString('base64')
    if (a.kind === 'image') parts.push({ type: 'image', image: `data:${got.mime};base64,${b64}`, mediaType: got.mime })
    else parts.push({ type: 'file', data: b64, mediaType: got.mime, filename: a.name })
  }
  return parts.length ? parts : text
}
```
> Fallback (probe says file parts unsupported): change the `else` branch to extract text and push `{ type:'text', text: '[file '+a.name+']:\n'+extracted }`. Keep the native branch otherwise.

- [ ] **Step 4: Run → pass.** `pnpm typecheck` 0.
- [ ] **Step 5: Commit** `feat(agent): buildUserMessageParts (multimodal user turn)`.

---

### Task 3: Files upload + byte-read endpoints

**Files:** Create `server/api/agent/files.post.ts`, `server/api/agent/files/[id].get.ts`; Modify `server/services/images.ts` (or a new `server/services/files.ts`); Test `test/agent-files.test.ts`

**Interfaces:**
- `POST /api/agent/files` (multipart `file`) → `{ id, kind:'file', mime, name, size }` (stores raw blob via `storage().put`; record the key→{mime,name} so the get can serve it).
- `getFileBytes(id): Promise<{ bytes: Buffer; mime: string; name?: string } | null>` (read the blob).
- `GET /api/agent/files/[id]` → streams the blob (auth-gated; for the UI download chip).

- [ ] **This task owns the migration.** Add BOTH schema changes now, then generate ONE migration: (a) a new `agent_files` table (`server/db/schema/` — `id uuid pk default gen_random_uuid()`, `storage_key text notNull`, `mime text notNull`, `name text`, `size integer notNull`, `created_at timestamptz notNull defaultNow()`); (b) `attachments jsonb` on `conversation_messages` (used by Task 4). Run `pnpm db:generate` → ONE migration file; `pnpm db:migrate` locally. (Task 4 only touches the service/DTO — no new migration there.)
- [ ] Implement `server/services/files.ts`: `saveFile(buffer, mime, name) -> { id, mime, name, size }` (`storage().put` → insert `agent_files` row, return its `id`); `getFileBytes(id) -> { bytes, mime, name } | null` (read row → `storage().get(storageKey)` → buffer the stream, mirror cycle-37 `getImageBytes`).
- [ ] Endpoints (thin handlers, mirror `server/api/upload.post.ts` multipart parsing): `POST /api/agent/files` → `saveFile` → `{ id, kind:'file', mime, name, size }`; `GET /api/agent/files/[id]` → `getFileBytes` → `sendStream` (auth-gated, for the UI download chip).
- [ ] Test `test/agent-files.test.ts`: `saveFile`/`getFileBytes` round-trip with mocked storage + DB; the POST handler returns the ref shape.
- [ ] **Commit** `feat(agent): file attachment storage + upload/read endpoints (migration)`.

---

### Task 4: Persist attachments on messages (migration + service + DTO)

**Files:** Modify `server/services/conversations.ts` (+ the `/api/conversations/[id]` handler if the DTO is shaped there); Test `test/conversations-attachments.test.ts`

> The `conversation_messages.attachments` column + migration were created in Task 3. This task is service/DTO only — NO new migration.

- [ ] `appendMessages`: accept `attachments?: AttachmentRef[]` on each msg, persist to the `attachments` column. The `ConversationMessage` DTO + the `/api/conversations/[id]` response include `attachments: AttachmentRef[] | null`.
- [ ] `getAgentHistory` UNCHANGED (stays `{role, content}` text-only — prior-turn attachments are not re-sent to the model in v1).
- [ ] Test: `appendMessages` persists + the DTO returns `attachments`.
- [ ] **Commit** `feat(conversations): persist message attachments (migration)`.

---

### Task 5: WS + orchestrator — accept attachments, build the multimodal turn, thread ToolContext

**Files:** Modify `server/api/voice/ws.ts`, `server/lib/voice/orchestrator.ts`, `server/lib/agent/run.ts` (ctx), `server/lib/agent/ai-tools.ts` (ctx), `server/lib/agent/types.ts` (ToolContext); Test `server/lib/voice/orchestrator-attachments.test.ts`

- [ ] `ToolContext` gains `attachmentImageIds?: string[]`; `buildAiTools` sets it from a new hook field; `runAgent` ctx + `handleTurn` deps carry `attachments`/`attachmentImageIds`.
- [ ] `ws.ts`: the `text` frame reads `msg.attachments` (`AttachmentRef[]`); pass to `handleTurn`. The persisted user message records `attachments` (Task 4).
- [ ] `handleTurn`: build the user `AgentMessage` via `buildUserMessageParts(text, attachments, readAttachmentBytes)` where `readAttachmentBytes` dispatches `getImageBytes` (kind image) / `getFileBytes` (kind file). Set `ctx.attachmentImageIds = attachments.filter(a=>a.kind==='image').map(a=>a.id)`.
- [ ] Test (fake runAgent): a turn with an image attachment → the message passed to runAgent has an image part, and `attachmentImageIds` reaches the tool ctx.
- [ ] `pnpm typecheck` 0; run agent+voice suites.
- [ ] **Commit** `feat(agent): WS attachments → multimodal turn + tool ctx`.

---

### Task 6: `edit_image` defaults to the turn's attachment

**Files:** Modify `server/services/images.ts` (`resolveSourceImageId` preferIds), `server/lib/agent/tools.ts` (edit_image); Test `test/edit-image-tool.test.ts` (extend)

- [ ] `resolveSourceImageId(explicitId, opts?: { preferIds?: string[] })`: if no explicit id, try `preferIds` (first live one) before newest-generated.
- [ ] `edit_image` handler: pass `{ preferIds: ctx.attachmentImageIds }` to `resolveSourceImageId`.
- [ ] Test: with `ctx.attachmentImageIds=['att1']` and no source_image_id, edits `att1`; without, newest-generated (regression).
- [ ] **Commit** `feat(agent): edit_image targets the attached image`.

---

### Task 7: Composer attachment UX

**Files:** Modify `app/components/voice/Composer.vue` (+ a small `useAgentAttachments` composable if cleaner); reference `app/components/clipboard/*` (the clipboard input) + `app/pages/agent/index.vue` (where Composer's `sendText` is wired).

- [ ] Add paste / drag-drop / a file-picker button (Nuxt UI) for images + files. Selected items show removable preview chips (image thumbnail / file name+size). Enforce caps (e.g. ≤4 attachments, ≤20 MB each) with a toast on reject.
- [ ] On send: upload images → `POST /api/upload`, files → `POST /api/agent/files`; collect `AttachmentRef[]`; call a new `sendText(text, speak, attachments)` (extend the prop signature) which sends the WS frame with `attachments`. Clear the tray after send.
- [ ] Wire `app/pages/agent/index.vue` / `useVoice` so the WS `text` frame includes `attachments` (extend the send path through to `ws.ts`).
- [ ] Gate: `pnpm typecheck` 0 + `pnpm build`. (Consult `nuxt-ui-docs`/`browser-testing` skills; live playwright in Task 9.)
- [ ] **Commit** `feat(agent): composer image + file attachments`.

---

### Task 8: Render user attachments in the transcript

**Files:** Modify `app/components/voice/Transcript.vue` (+ the `TranscriptEntry`/message types to carry attachments); reference `useVoice`/`useConversations` for the reload path.

- [ ] The user-message branch renders an attachments row: image thumbnails (`<img src="/api/images/<id>/raw">`) and file chips (name + `/api/agent/files/<id>` download link), above/below the user text.
- [ ] Live: the composer's pre-send tray + the echoed user turn carry the attachments; on reload, `getConversation` messages include `attachments` (Task 4) → render them.
- [ ] Gate: typecheck 0 + build.
- [ ] **Commit** `feat(agent): render user attachments in the transcript`.

---

### Task 9: Final wiring verification + docs

**Files:** Modify `docs/wiki/agent.md`, `docs/superpowers/plans/00-roadmap.md`

- [ ] **Full gate:** `pnpm typecheck && pnpm vitest run && pnpm build` — report exact counts; STOP/BLOCKED on any failure (don't delete tests to pass).
- [ ] Confirm migration applies (`pnpm db:migrate` on a clean local DB).
- [ ] Wiki `agent.md`: a "Multimodal attachments" section — attach images/files; native to Qwen3.6 (content parts, bytes inline); model decides infer vs `edit_image` (source = attachment); persistence; the current-turn-bytes-only + native-file-probe caveats. Bump `cycle`/`updated` to 39 / 2026-06-28.
- [ ] Roadmap: cycle-39 row (✅ shipped), link spec/plan/handover (`../../handovers/2026-06-28-multimodal-agent.md` — controller writes it).
- [ ] **Commit** `docs(agent): multimodal attachments (cycle 39)`.

---

## Live verification (post-merge, against the rig — acceptance)
1. Attach a photo + "what is this?" → native vision description.
2. Attach a photo + "make the sky purple" → `edit_image` edits the ATTACHED photo, renders inline.
3. Attach a PDF + "summarize this" → summary (native file part, or extraction fallback per the probe).
4. Reload the conversation → user attachments re-render (thumbnails + file chips).
5. Oversized/too-many/upload-fail → clean composer error, no crash. Text-only turns unaffected.

## Self-review notes (spec coverage)
- Content parts → T1. buildUserMessageParts (bytes inline) → T2. Files upload/read → T3. Persist + migration + DTO → T4. WS+orchestrator+ctx → T5. edit-from-attachment → T6. Composer UX → T7. Transcript render → T8. Gate+docs → T9.
- Probe + file fallback → Prerequisite (controller) + T2/T5 note.
- Reliable-render unchanged; redaction on text parts only → T1.
- Deferred (multi-turn image memory, audio/video, file→doc-library, v7) → not built.
