# Bridget Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tony can text Bridget over iMessage (BlueBubbles, Private API) and get replies there, and jobs can deliver to iMessage (presence-aware `auto`) and email (Resend).

**Architecture:** One `Channel` interface under `server/lib/channels/`. Inbound: a token-guarded webhook plus a 2-minute catch-up feed one pipeline that enqueues onto the **main** thread with `origin` and `reply_to`. Outbound: a DB outbox (`channel_deliveries`) written in the same transaction as the assistant message and drained by the existing 5-second worker tick with idempotent retries. Approvals for iMessage-originated runs travel as a texted prompt resolved by a tapback.

**Tech Stack:** Nuxt 4 / Nitro, Drizzle + Postgres, Vercel AI SDK runtime from cycles 73–74, Nuxt UI, vitest (`pnpm test`, `pnpm test:db`), `playwright-cli`, new dep `marked`.

**Spec:** `docs/superpowers/specs/2026-09-28-bridget-channels-design.md`

## Global Constraints

- pnpm only; gates are `pnpm test`, `pnpm test:db` (DB files touched), `pnpm typecheck`, `pnpm build`. Lint is not a gate.
- Commit messages carry **no** `Co-Authored-By` or any model/attribution trailer.
- Migration number is **0057** (`pnpm db:generate` then `pnpm db:migrate` on dev). Additive only.
- Only direct chats reach the agent; group chats (chat GUID contains `;+;`) are ignored.
- `send_message` can target **only** the configured default handle / email — no address parameter.
- Backoff schedule: **30 s, 2 m, 10 m, 1 h, 1 h, 1 h**, then `failed` (6 attempts).
- Catch-up interval **2 min**, overlap **5 min**. `sending` reclaim after **2 min**. Approval expiry **10 min**. Presence default **10 min**. `send_message` limit **20/hour/channel**.
- Email subject: `Bridget · <job slug or "message">` — no date.
- Webhook token: 32 random bytes hex; compare with `crypto.timingSafeEqual`; failure → **404**.
- The BlueBubbles password and webhook token never appear in any GET response or client bundle.
- **No real texts during the build.** All automated tests and subagent browser checks use the fake BlueBubbles server (`BLUEBUBBLES_FAKE=1` in dev). Real sends happen only in controller-run acceptance with Tony.
- Dev DB is shared with real data: follow `db-safety.md` (scope every DB test by prefix/ids; mutate whole predicates, never splice raw `sql` `or`/`true`; re-verify real row counts).
- Nuxt UI rules in `.claude/rules/` apply to `.vue` files; `USelect`/`USelectMenu` items never use empty-string values.
- Seed jobs stay **disabled**.

## Review Focus

1. **HEIC photos from an iPhone** — the vision model gets a JPEG or PNG: download with BlueBubbles' conversion (`original=false`), and if the result is still HEIC, send the "(couldn't load the photo)" note rather than a broken attachment. Test in Task 7.
2. **A voice memo arrives as `.caf`** — the STT request labels the real MIME and filename, not `audio/wav`, and a transcription failure yields the "(a voice memo I couldn't transcribe)" note while the rest of the message still goes through. Test in Task 7.
3. **The same message arrives by webhook AND catch-up at the same moment** — exactly one run. A primary-key insert on `channel_inbound` in the enqueue transaction decides it. Test in Task 7.
4. **A retry after an unconfirmed send** — no duplicate text: before resending, look for Bridget's own message with the same text in that chat since the row was first claimed, and mark `sent` if it is there. Test in Task 6.
5. **Tony texts while a job's headless run is busy on main** — his message queues rather than steering into the headless run, and still gets `reply_to` so the answer returns to his phone. Test in Task 7.

---

## File Structure

```
server/db/schema/channels.ts                 channel_deliveries, channel_inbound, channel_approvals
server/db/schema/agent-runs.ts               + reply_to
server/lib/channels/types.ts                 ChannelId, Channel, SendResult, InboundMessage, Tapback, DeliveryPayload
server/lib/channels/handles.ts               normaliseHandle, isAllowed, maskHandle (pure)
server/lib/channels/backoff.ts               nextAttemptDelayMs (pure)
server/lib/channels/deliver.ts               resolveDeliverChannels (pure), planDeliveries (DB-reading, returns inserts)
server/lib/channels/config.ts                load/save/redact channel settings, webhook token
server/lib/channels/presence.ts              markActive, isAway
server/lib/channels/outbox.ts                insertDeliveries(tx), deliveriesTick, claim/mark helpers
server/lib/channels/inbound.ts               handleInbound (filter → dedupe → normalise → enqueue), catchUpTick
server/lib/channels/approvals.ts             iMessage approval channel + tapback resolution
server/lib/channels/registry.ts              channelFor(id)
server/lib/channels/bluebubbles/client.ts    REST client
server/lib/channels/bluebubbles/parse.ts     webhook/query payload → InboundMessage | TapbackEvent (pure)
server/lib/channels/bluebubbles/channel.ts   Channel adapter
server/lib/channels/email/render.ts          markdown → { html, text } (pure)
server/lib/channels/email/channel.ts         Channel adapter
server/lib/agent/tools/channels.ts           send_message tool
server/api/channels/bluebubbles/webhook.post.ts
server/api/presence.post.ts
server/api/settings/channels.get.ts / channels.put.ts
server/api/settings/channels/test-imessage.post.ts / test-email.post.ts / regenerate-token.post.ts
app/pages/settings/channels.vue, app/components/settings/ChannelsTab.vue, app/composables/useChannelsConfig.ts
app/plugins/presence.client.ts
test/fixtures/bluebubbles/*.json, test/fixtures/fake-bluebubbles.ts
```

---

### Task 1: Schema, migration 0057, run `reply_to`, live resource

**Files:**
- Create: `server/db/schema/channels.ts`
- Modify: `server/db/schema/index.ts` (export), `server/db/schema/agent-runs.ts` (add `replyTo`), `server/lib/agent/runtime/runs.ts` (`createRun` accepts `replyTo`), `server/lib/agent/runtime/types.ts` (`ReplyTo` type), `shared/types/live.ts` (`channelDelivery`), `app/utils/live-dispatch.ts` (override → also invalidate `['conversation']`)
- Test: `test/channels-schema.db.test.ts`, `test/live-dispatch.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  // server/lib/agent/runtime/types.ts
  export interface ReplyTo { channel: 'imessage'; chatGuid: string; messageGuid: string }
  // runs.ts createRun(i: { ...existing, replyTo?: ReplyTo | null })
  // schema exports: channelDeliveries, channelInbound, channelApprovals, ChannelDelivery (select type)
  ```

- [ ] **Step 1: Write the schema**

```ts
// server/db/schema/channels.ts
import { pgTable, uuid, text, jsonb, integer, timestamp, index } from 'drizzle-orm/pg-core'
import { agentRuns } from './agent-runs'
import { agentJobs } from './agent-config'

export const channelDeliveries = pgTable('channel_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  channel: text('channel').notNull(),              // 'imessage' | 'email'
  target: text('target').notNull(),                // chat GUID or email address
  conversationId: uuid('conversation_id'),
  messageId: uuid('message_id'),
  jobId: uuid('job_id').references(() => agentJobs.id, { onDelete: 'set null' }),
  runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  source: text('source').notNull().default('reply'), // 'reply' | 'job' | 'tool' | 'note'
  payload: jsonb('payload').notNull(),             // { text, images?: string[], subject? }
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  firstClaimedAt: timestamp('first_claimed_at', { withTimezone: true }),
  lastError: text('last_error'),
  externalId: text('external_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true })
}, t => [
  index('channel_deliveries_due_idx').on(t.status, t.nextAttemptAt),
  index('channel_deliveries_message_idx').on(t.messageId)
])

export const channelInbound = pgTable('channel_inbound', {
  guid: text('guid').primaryKey(),
  channel: text('channel').notNull(),
  sender: text('sender').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  runId: uuid('run_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, t => [index('channel_inbound_received_idx').on(t.channel, t.receivedAt)])

export const channelApprovals = pgTable('channel_approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  request: jsonb('request').notNull(),
  chatGuid: text('chat_guid').notNull(),
  promptGuid: text('prompt_guid'),
  status: text('status').notNull().default('pending'), // pending | approved | denied | expired
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, t => [index('channel_approvals_prompt_idx').on(t.promptGuid)])

export type ChannelDelivery = typeof channelDeliveries.$inferSelect
export type ChannelApproval = typeof channelApprovals.$inferSelect
```

Add to `agent-runs.ts`: `replyTo: jsonb('reply_to'),`. Two columns beyond the spec, both needed: `source`, which records who asked for the delivery and is used by the tool's rate limit, and `first_claimed_at`, the window for the duplicate check (Review Focus 4). `channel_approvals.chat_guid` holds where the prompt was sent.

- [ ] **Step 2: Generate and apply**

Run: `pnpm db:generate` → expect `server/db/migrations/0057_*.sql` with three `CREATE TABLE`s and `ALTER TABLE "agent_runs" ADD COLUMN "reply_to" jsonb`. Rename nothing. Then `pnpm db:migrate`.

- [ ] **Step 3: `createRun` passes `replyTo`**

In `runs.ts` `createRun`, add `replyTo?: ReplyTo | null` to the param and `replyTo: i.replyTo ?? null` to the insert values.

- [ ] **Step 4: Live resource**

Add `'channelDelivery'` to the `ResourceName` union in `shared/types/live.ts`. In `app/utils/live-dispatch.ts` `OVERRIDES`, add `channelDelivery: () => [['conversation']]` in the same shape as the neighbouring entries. Extend `test/live-dispatch.test.ts` with a case asserting that a `channelDelivery` event invalidates the `['conversation']` prefix.

- [ ] **Step 5: DB test**

`test/channels-schema.db.test.ts` (harness pattern from `test/jobs-tick.db.test.ts`: `process.loadEnvFile('.env')`, stub `useRuntimeConfig`). Create a scratch conversation and run with `createRun({... replyTo: { channel: 'imessage', chatGuid: 'iMessage;-;+15550000001', messageGuid: 'chtest-1' } })`. Assert the row's `replyTo` round-trips. Insert a `channel_deliveries` row with `runId` set, delete the run, and assert the delivery's `run_id` is null. Clean up by id in `afterAll`.

- [ ] **Step 6: Gates and commit**

`pnpm test`, `pnpm test:db test/channels-schema.db.test.ts`, `pnpm typecheck`.
Commit: `feat(channels): schema 0057 — deliveries outbox, inbound dedupe, approvals, run reply_to`

---

### Task 2: Pure helpers — handles, backoff, deliver resolution, BlueBubbles payload parsing

**Files:**
- Create: `server/lib/channels/types.ts`, `server/lib/channels/handles.ts`, `server/lib/channels/backoff.ts`, `server/lib/channels/deliver.ts` (pure part only: `resolveDeliverChannels`), `server/lib/channels/bluebubbles/parse.ts`, `test/fixtures/bluebubbles/{text,photo,voice-memo,tapback-like,tapback-dislike,group,from-me,updated-read}.json`
- Test: `test/channels-handles.test.ts`, `test/channels-backoff.test.ts`, `test/channels-deliver.test.ts`, `test/bluebubbles-parse.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export type ChannelId = 'app' | 'imessage' | 'email'
  export type OutboundChannelId = 'imessage' | 'email'
  export interface DeliveryPayload { text: string; images?: string[]; subject?: string }
  export type SendResult = { ok: true; externalId?: string; unconfirmed?: boolean } | { ok: false; error: string; retryable: boolean }
  export interface Channel {
    id: OutboundChannelId
    isEnabled(): Promise<boolean>
    send(d: { id: string; target: string; payload: DeliveryPayload; attempts: number; firstClaimedAt: Date | null }): Promise<SendResult>
  }
  export interface InboundAttachment { guid: string; mime: string; name: string }
  export interface InboundMessage { kind: 'message'; guid: string; chatGuid: string; sender: string; text: string; attachments: InboundAttachment[]; date: Date; isFromMe: boolean; isGroup: boolean }
  export type Tapback = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question'
  export interface TapbackEvent { kind: 'tapback'; guid: string; chatGuid: string; sender: string; targetGuid: string; tapback: Tapback; removed: boolean; isFromMe: boolean }
  // handles.ts
  export function normaliseHandle(raw: string): string
  export function isAllowed(handle: string, allowlist: string[]): boolean
  export function maskHandle(h: string): string
  // backoff.ts
  export const BACKOFF_MS: readonly number[]      // [30_000, 120_000, 600_000, 3_600_000, 3_600_000, 3_600_000]
  export const MAX_ATTEMPTS: number                // 6
  export function nextAttemptDelayMs(attemptsSoFar: number): number | null   // null = give up
  // deliver.ts
  export function resolveDeliverChannels(deliver: string[], s: { imessageEnabled: boolean; emailEnabled: boolean; away: boolean }): OutboundChannelId[]
  // bluebubbles/parse.ts
  export function parseBlueBubblesMessage(data: unknown): InboundMessage | TapbackEvent | null
  export function parseWebhook(body: unknown): { type: string; event: InboundMessage | TapbackEvent | null }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/channels-handles.test.ts
import { describe, it, expect } from 'vitest'
import { normaliseHandle, isAllowed, maskHandle } from '../server/lib/channels/handles'

describe('normaliseHandle', () => {
  it.each([
    ['(555) 123-4567', '+15551234567'],
    ['555.123.4567', '+15551234567'],
    ['1 555 123 4567', '+15551234567'],
    ['+44 20 7946 0958', '+442079460958'],
    ['Tony@Example.COM ', 'tony@example.com'],
    ['mailto:tony@example.com', 'tony@example.com'],
    ['tel:+15551234567', '+15551234567']
  ])('%s → %s', (raw, want) => expect(normaliseHandle(raw)).toBe(want))
})
describe('isAllowed', () => {
  it('matches after normalising both sides', () => {
    expect(isAllowed('+1 (555) 123-4567', ['5551234567'])).toBe(true)
    expect(isAllowed('+15559999999', ['5551234567'])).toBe(false)
    expect(isAllowed('', ['5551234567'])).toBe(false)
  })
})
describe('maskHandle', () => {
  it('keeps the last 4 of a phone, the first letter + domain of an email', () => {
    expect(maskHandle('+15551234567')).toBe('+•••••••4567')
    expect(maskHandle('tony@example.com')).toBe('t•••@example.com')
  })
})
```

```ts
// test/channels-backoff.test.ts
import { describe, it, expect } from 'vitest'
import { nextAttemptDelayMs, MAX_ATTEMPTS } from '../server/lib/channels/backoff'
it('follows 30s, 2m, 10m, 1h, 1h, 1h then gives up', () => {
  expect([0, 1, 2, 3, 4, 5].map(nextAttemptDelayMs)).toEqual([30_000, 120_000, 600_000, 3_600_000, 3_600_000, 3_600_000])
  expect(nextAttemptDelayMs(MAX_ATTEMPTS)).toBeNull()
})
```

```ts
// test/channels-deliver.test.ts
import { describe, it, expect } from 'vitest'
import { resolveDeliverChannels } from '../server/lib/channels/deliver'
const on = { imessageEnabled: true, emailEnabled: true }
describe('resolveDeliverChannels', () => {
  it('app alone delivers nowhere extra', () => expect(resolveDeliverChannels(['app'], { ...on, away: true })).toEqual([]))
  it('auto → imessage only when away', () => {
    expect(resolveDeliverChannels(['auto'], { ...on, away: true })).toEqual(['imessage'])
    expect(resolveDeliverChannels(['auto'], { ...on, away: false })).toEqual([])
  })
  it('auto never implies email', () => expect(resolveDeliverChannels(['auto'], { ...on, away: true })).not.toContain('email'))
  it('explicit channels always, deduped, stable order imessage then email', () =>
    expect(resolveDeliverChannels(['email', 'auto', 'imessage'], { ...on, away: true })).toEqual(['imessage', 'email']))
  it('a disabled channel is skipped', () =>
    expect(resolveDeliverChannels(['imessage', 'email'], { imessageEnabled: false, emailEnabled: true, away: true })).toEqual(['email']))
})
```

```ts
// test/bluebubbles-parse.test.ts
import { describe, it, expect } from 'vitest'
import { parseWebhook } from '../server/lib/channels/bluebubbles/parse'
import text from './fixtures/bluebubbles/text.json'
import photo from './fixtures/bluebubbles/photo.json'
import voice from './fixtures/bluebubbles/voice-memo.json'
import like from './fixtures/bluebubbles/tapback-like.json'
import dislike from './fixtures/bluebubbles/tapback-dislike.json'
import group from './fixtures/bluebubbles/group.json'
import fromMe from './fixtures/bluebubbles/from-me.json'
import updatedRead from './fixtures/bluebubbles/updated-read.json'

describe('parseWebhook', () => {
  it('text message', () => {
    const { type, event } = parseWebhook(text)
    expect(type).toBe('new-message')
    expect(event).toMatchObject({ kind: 'message', guid: 'A1B2-TEXT', chatGuid: 'iMessage;-;+15551234567', sender: '+15551234567', text: 'hey bridget', isGroup: false, isFromMe: false, attachments: [] })
  })
  it('photo carries its attachment', () => {
    const e = parseWebhook(photo).event as any
    expect(e.attachments).toEqual([{ guid: 'ATT-PHOTO', mime: 'image/heic', name: 'IMG_0001.HEIC' }])
  })
  it('voice memo carries the audio attachment', () => {
    const e = parseWebhook(voice).event as any
    expect(e.attachments[0]).toMatchObject({ mime: 'audio/x-caf', name: 'Audio Message.caf' })
  })
  it('tapbacks parse with the target guid stripped of its p:N/ prefix', () => {
    expect(parseWebhook(like).event).toMatchObject({ kind: 'tapback', tapback: 'like', targetGuid: 'PROMPT-GUID', removed: false })
    expect(parseWebhook(dislike).event).toMatchObject({ kind: 'tapback', tapback: 'dislike', targetGuid: 'PROMPT-GUID' })
  })
  it('group chats are flagged', () => expect((parseWebhook(group).event as any).isGroup).toBe(true))
  it('from-me is flagged', () => expect((parseWebhook(fromMe).event as any).isFromMe).toBe(true))
  it('an updated-message that is not a tapback yields no event', () => expect(parseWebhook(updatedRead).event).toBeNull())
  it('garbage never throws', () => {
    expect(parseWebhook(null).event).toBeNull()
    expect(parseWebhook({ type: 'new-message', data: { guid: 5 } }).event).toBeNull()
  })
})
```

Fixture shape (BlueBubbles server webhook, v1.9+). `text.json`:
```json
{ "type": "new-message", "data": {
  "guid": "A1B2-TEXT", "text": "hey bridget", "isFromMe": false, "dateCreated": 1790000000000,
  "handle": { "address": "+15551234567" },
  "chats": [{ "guid": "iMessage;-;+15551234567", "style": 45 }],
  "attachments": [], "associatedMessageGuid": null, "associatedMessageType": null } }
```
Derive the others from this. **photo:** `attachments: [{ "guid": "ATT-PHOTO", "mimeType": "image/heic", "transferName": "IMG_0001.HEIC" }]`, `text: ""`. **voice-memo:** `mimeType: "audio/x-caf"`, `transferName: "Audio Message.caf"`. **tapback-like:** `"associatedMessageGuid": "p:0/PROMPT-GUID", "associatedMessageType": "like"`, `text: "Liked “Run …”"`. **tapback-dislike:** the same with `"dislike"`. **group:** chat `"iMessage;+;chat123456"`, `"style": 43`. **from-me:** `"isFromMe": true`. **updated-read:** `"type": "updated-message"`, a normal message with `"dateRead"` set and no association.

Tapback mapping: BlueBubbles sends names (`love | like | dislike | laugh | emphasize | question`) or numbers `2000–2005` in the same order. Removals are `-love` etc. and `3000–3005`. Map both forms and set `removed` for the minus/3000 forms. `targetGuid` strips any `p:N/` or `bp:` prefix. `isGroup` = chat `style === 43` or the chat GUID contains `;+;`. `sender` = `normaliseHandle(handle.address)`.

- [ ] **Step 2: Run the tests; they fail** (modules missing).

- [ ] **Step 3: Implement**

```ts
// server/lib/channels/handles.ts
export function normaliseHandle(raw: string): string {
  const s = raw.trim().replace(/^(mailto:|tel:)/i, '')
  if (s.includes('@')) return s.toLowerCase()
  const plus = s.startsWith('+')
  const digits = s.replace(/\D/g, '')
  if (!digits) return ''
  if (plus) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return `+${digits}`
}
export function isAllowed(handle: string, allowlist: string[]): boolean {
  const h = normaliseHandle(handle)
  return !!h && allowlist.some(a => normaliseHandle(a) === h)
}
export function maskHandle(h: string): string {
  if (h.includes('@')) { const [u, d] = h.split('@'); return `${u!.slice(0, 1)}•••@${d}` }
  return h.length <= 5 ? '•••' : `${h.slice(0, 1)}${'•'.repeat(h.length - 5)}${h.slice(-4)}`
}
```
(`maskHandle('+15551234567')`: 12 chars, so 7 dots, giving `+•••••••4567`. Keep the test and the code in step.)

```ts
// server/lib/channels/backoff.ts
export const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 3_600_000, 3_600_000] as const
export const MAX_ATTEMPTS = BACKOFF_MS.length
export function nextAttemptDelayMs(attemptsSoFar: number): number | null {
  return attemptsSoFar < MAX_ATTEMPTS ? BACKOFF_MS[attemptsSoFar]! : null
}
```

```ts
// server/lib/channels/deliver.ts (pure part; Task 8 adds planDeliveries below it)
import type { OutboundChannelId } from './types'
export function resolveDeliverChannels(deliver: string[], s: { imessageEnabled: boolean; emailEnabled: boolean; away: boolean }): OutboundChannelId[] {
  const want = new Set<OutboundChannelId>()
  for (const d of deliver) {
    if (d === 'imessage' || (d === 'auto' && s.away)) want.add('imessage')
    if (d === 'email') want.add('email')
  }
  const out: OutboundChannelId[] = []
  if (want.has('imessage') && s.imessageEnabled) out.push('imessage')
  if (want.has('email') && s.emailEnabled) out.push('email')
  return out
}
```

Write `parse.ts` so it never throws: a `try` around it returns `{ type, event: null }`, and every field is type-checked before use.

- [ ] **Step 4: Run the tests; they pass.** Mutation-check each file: break one branch (e.g. drop the `away` condition, or drop the `;+;` group check) and watch a test go red. Revert.

- [ ] **Step 5: Commit** `feat(channels): pure helpers — handles, backoff, deliver resolution, BlueBubbles payload parsing`

---

### Task 3: Channel settings, presence, settings API

**Files:**
- Create: `server/lib/channels/config.ts`, `server/lib/channels/presence.ts`, `server/api/settings/channels.get.ts`, `server/api/settings/channels.put.ts`, `server/api/settings/channels/regenerate-token.post.ts`, `server/api/presence.post.ts`, `app/plugins/presence.client.ts`
- Test: `test/channels-config.test.ts` (pure parse/redact/merge), `test/channels-presence.test.ts`, `test/channels-config.db.test.ts`

**Interfaces:**
- Consumes: `encryptSecret`/`decryptSecret` from `server/lib/ai/registry/crypto.ts`; `settings` table; `normaliseHandle` (Task 2).
- Produces:
  ```ts
  export interface IMessageConfig { enabled: boolean; serverUrl: string; passwordEnc: string | null; webhookToken: string; allowedHandles: string[]; defaultHandle: string | null; defaultChatGuid: string | null }
  export interface EmailChannelConfig { enabled: boolean; to: string | null }
  export interface ChannelsConfig { imessage: IMessageConfig; email: EmailChannelConfig; presenceAwayMinutes: number }
  export interface ChannelsConfigDTO { imessage: Omit<IMessageConfig, 'passwordEnc' | 'webhookToken'> & { hasPassword: boolean; webhookUrlPath: string }; email: EmailChannelConfig & { resendReady: boolean }; presenceAwayMinutes: number }
  export async function loadChannelsConfig(): Promise<ChannelsConfig>      // cached; invalidateChannelsConfig()
  export async function saveChannelsConfig(c: ChannelsConfig): Promise<void>
  export function redactChannelsConfig(c: ChannelsConfig, resendReady: boolean): ChannelsConfigDTO
  export function blueBubblesPassword(c: IMessageConfig): string | null   // decrypt
  export async function verifyWebhookToken(token: string | undefined): Promise<boolean>   // timingSafeEqual, false when disabled
  export function newWebhookToken(): string                                 // randomBytes(32).toString('hex')
  // presence.ts
  export function markActive(at?: number): void
  export async function isAway(now?: number): Promise<boolean>              // uses presenceAwayMinutes
  export function _resetPresence(): void                                    // test seam
  ```

Settings keys: `channel_imessage`, `channel_email`, `presence_away_minutes`, following the spec §2.5 key names. The settings modules in the codebase each read and write their own key, as `server/lib/observability/config.ts` does (`loadObsConfig`/`saveObsConfig`); mirror that pattern.

- [ ] **Step 1: Failing tests** for:
  - `parseChannelsConfig(raw)` defaults: disabled, empty handles, presence 10, and a fresh token generated when missing (the caller persists it);
  - `redactChannelsConfig` never contains `passwordEnc` or `webhookToken` (`JSON.stringify(dto)` must not include either value);
  - `mergeChannelsPut(existing, body)`:
    - a password object `{ password: string }` replaces the encrypted value, `{ keep: true }` keeps it, `null` clears it;
    - handles are normalised, de-duplicated and empties dropped;
    - `defaultHandle` must be one of the allowed handles, else a 400-class `ChannelsConfigError`;
    - `presenceAwayMinutes` is clamped to 1–240;
    - changing `defaultHandle` resets `defaultChatGuid` to null.
  - Presence:
    - `isAway()` is true with no ping;
    - it is false right after `markActive()`;
    - it is true again after `presenceAwayMinutes` (inject `now`).

- [ ] **Step 2: Implement config.ts.** Pure `parseChannelsConfig`/`redactChannelsConfig`/`mergeChannelsPut` + DB `loadChannelsConfig` (reads the three keys; if `webhookToken` missing, generates and saves one) / `saveChannelsConfig` / `invalidateChannelsConfig`. `verifyWebhookToken`:
  ```ts
  import { timingSafeEqual } from 'node:crypto'
  export async function verifyWebhookToken(token: string | undefined): Promise<boolean> {
    const c = await loadChannelsConfig()
    if (!c.imessage.enabled || !token) return false
    const a = Buffer.from(token), b = Buffer.from(c.imessage.webhookToken)
    return a.length === b.length && timingSafeEqual(a, b)
  }
  ```
  `resendReady` = `loadObsConfig()`'s `alerts.email` has an encrypted key and a `from` address. Read the actual field names in `server/lib/observability/config.ts` and use them.

- [ ] **Step 3: Routes.**
  - `GET /api/settings/channels` → `redactChannelsConfig(...)`, where `webhookUrlPath` is `/api/channels/bluebubbles/webhook?token=<token>`.
    **Exception, recorded in the ledger:** this is the ONE place the token is shown. It is shown so Tony can copy it into BlueBubbles, which is why the UI displays it. The rule "never in a GET" applies to the password. The token is a capability Tony must paste, so the settings GET (session-authed) returns it inside `webhookUrlPath` and nowhere else.
  - `PUT /api/settings/channels` (zod body mirroring the DTO + a password field) → merge → save → invalidate → return the DTO.
  - `POST /api/settings/channels/regenerate-token` → new token → the DTO.
  - `POST /api/presence` → `markActive()` → `204`.

- [ ] **Step 4: Client presence plugin.** `app/plugins/presence.client.ts`:
  - Listen for `keydown`, `pointerdown`, `focus`, and `visibilitychange` to `visible`.
  - Throttle to one `$fetch('/api/presence', { method: 'POST' })` per 60 s, swallowing errors.
  - Only when the user is signed in: reuse the auth composable the layout uses. Find it in `app/layouts/default.vue`.

- [ ] **Step 5: DB test** (`channels-config.db.test.ts`):
  - Snapshot the three settings rows first; restore them exactly in `afterAll` (delete them if they were absent).
  - Round-trip save and load.
  - The token is generated once and stays stable.
  - `verifyWebhookToken` is false when disabled, false for a wrong token or a wrong length, and true for the right one.

- [ ] **Step 6: Gates + commit** `feat(channels): channel settings, webhook token, presence`

---

### Task 4: BlueBubbles client, fake server, iMessage channel adapter

**Files:**
- Create: `server/lib/channels/bluebubbles/client.ts`, `server/lib/channels/bluebubbles/channel.ts`, `server/lib/channels/registry.ts`, `test/fixtures/fake-bluebubbles.ts`
- Modify: `server/lib/voice/providers/stt-whisper.ts` (optional `mime`/`filename` in `transcribe` opts), `server/lib/voice/providers/types.ts`
- Test: `test/bluebubbles-client.test.ts`, `test/stt-whisper.test.ts` (extend)

**Interfaces:**
- Consumes: `loadChannelsConfig`, `blueBubblesPassword` (Task 3); types (Task 2).
- Produces:
  ```ts
  export interface BlueBubblesClient {
    serverInfo(): Promise<{ privateApi: boolean; serverVersion: string; detectedIcloud: string | null }>
    sendText(chatGuid: string, text: string, tempGuid: string): Promise<{ guid: string | null; unconfirmed: boolean }>
    sendAttachment(chatGuid: string, file: { name: string; mime: string; data: Buffer }, tempGuid: string): Promise<{ guid: string | null; unconfirmed: boolean }>
    react(chatGuid: string, messageGuid: string, tapback: Tapback): Promise<void>
    typing(chatGuid: string, on: boolean): Promise<void>
    markRead(chatGuid: string): Promise<void>
    messagesSince(afterMs: number, limit?: number): Promise<unknown[]>          // raw message objects, oldest first
    findOwnMessage(chatGuid: string, text: string, sinceMs: number): Promise<string | null>   // guid of an isFromMe message with this exact text
    downloadAttachment(guid: string): Promise<{ data: Buffer; mime: string; name: string }>   // original=false (HEIC→JPEG)
    resolveDirectChat(handle: string): Promise<string>                          // chat GUID for a DM
  }
  export function blueBubblesClient(cfg: { serverUrl: string; password: string; fetchImpl?: typeof fetch; privateApi?: boolean }): BlueBubblesClient
  export class BlueBubblesError extends Error { constructor(msg: string, public retryable: boolean, public status?: number) }
  export async function imessageClient(): Promise<BlueBubblesClient | null>   // from config; null when disabled or unconfigured; honours BLUEBUBBLES_FAKE_URL
  export const imessageChannel: Channel
  export function channelFor(id: OutboundChannelId): Channel                  // registry.ts
  // test/fixtures/fake-bluebubbles.ts
  export async function startFakeBlueBubbles(opts?: { privateApi?: boolean; failSends?: number; sendHangs?: boolean }): Promise<{ url: string; password: string; sent: FakeSent[]; reactions: unknown[]; typing: unknown[]; reads: string[]; messages: unknown[]; pushMessage(m: unknown): void; close(): Promise<void> }>
  ```

REST mapping (BlueBubbles v1 API). Every request carries `?password=<pw>`, URL-encoded. Timeout is 15 s via `AbortSignal.timeout(15_000)`.

| Method | Request |
|---|---|
| `serverInfo` | `GET /api/v1/server/info` → `data.private_api`, `data.server_version`, `data.detected_icloud` |
| `sendText` | `POST /api/v1/message/text` with `{ chatGuid, tempGuid, message, method: privateApi ? 'private-api' : 'apple-script' }` → `data.guid`. A **timeout** (AbortError) with the AppleScript method → `{ guid: null, unconfirmed: true }`. With the Private API a timeout is a retryable `BlueBubblesError`. |
| `sendAttachment` | `POST /api/v1/message/attachment`, multipart (`chatGuid`, `tempGuid`, `name`, `attachment`, `method`) |
| `react` | `POST /api/v1/message/react` with `{ chatGuid, selectedMessageGuid, reaction }` |
| `typing` | `POST` (on) / `DELETE` (off) `/api/v1/chat/:chatGuid/typing` (chat GUID URL-encoded) |
| `markRead` | `POST /api/v1/chat/:chatGuid/read` |
| `messagesSince` | `POST /api/v1/message/query` with `{ with: ['chat', 'attachment', 'handle'], after: afterMs, sort: 'ASC', limit }` |
| `findOwnMessage` | `POST /api/v1/chat/:chatGuid/message` query → first `isFromMe` whose `text === text` and `dateCreated >= sinceMs` |
| `downloadAttachment` | `GET /api/v1/attachment/:guid/download?original=false` → body bytes, `content-type` header, name from `GET /api/v1/attachment/:guid` → `transferName` |
| `resolveDirectChat(handle)` | `iMessage;-;${normaliseHandle(handle)}` (deterministic; no request) |

HTTP 5xx, network errors and timeouts are `retryable: true`; 4xx is `retryable: false`.

- [ ] **Step 1: Fake server.** Build `test/fixtures/fake-bluebubbles.ts` on `node:http` `createServer`, binding port 0. Follow the pattern in `test/mcp-transport.test.ts`.
  - Implement the routes above.
  - Record calls into the returned arrays.
  - Check `password`, returning 401 on a mismatch.
  - `failSends: n` makes the first n sends 503.
  - `sendHangs` never responds to `/message/text`.
  - `pushMessage` appends to the list `messagesSince` serves.
  - Attachment download returns a tiny PNG for any GUID, with `content-type: image/png`.
- [ ] **Step 2: Failing client tests** against the fake:
  - `serverInfo` reads `private_api`;
  - `sendText` posts the right body and method;
  - a 503 → `BlueBubblesError` with `retryable: true`;
  - 401 → `retryable: false`;
  - a hang with `privateApi: false` → `unconfirmed: true` (use a short injected timeout via `fetchImpl` or a `timeoutMs` option, so the test runs in under 1 s);
  - `findOwnMessage` finds a pushed own message;
  - `messagesSince` passes `after`;
  - typing on/off hits POST/DELETE;
  - the password is URL-encoded.
- [ ] **Step 3: Implement the client, then the adapter** `imessageChannel.send(d)`:
  1. `client = await imessageClient()`; null → `{ ok: false, error: 'iMessage is not configured', retryable: false }`.
  2. If `d.attempts > 0` and `d.firstClaimedAt`, call `findOwnMessage(target, payload.text, firstClaimedAt − 5 s)`. Found → `{ ok: true, externalId }` without sending (Review Focus 4).
  3. `sendText(target, text, d.id)`.
  4. For each image id: load the image row (`images` table) plus bytes via `storage().get(key)` (see `server/services/images.ts` for the read API), then `sendAttachment(..., tempGuid: `${d.id}-img${i}`)`.
  5. Map errors to `SendResult`. Any `unconfirmed` → `unconfirmed: true`.
- [ ] **Step 4: STT MIME.** Add `opts.mime?: string; opts.filename?: string` to `SttProvider.transcribe`. `whisperStt` uses them for the Blob type and the multipart filename, defaulting to the current `audio/wav` / its current filename. Extend `test/stt-whisper.test.ts`: passing `{ mime: 'audio/x-caf', filename: 'a.caf' }` puts that type and filename in the form data.
- [ ] **Step 5: Registry.** `channelFor('imessage')` → `imessageChannel`. `channelFor('email')` → a placeholder that throws `not implemented`; Task 5 replaces it, so a later reader never finds a silent stub.
- [ ] **Step 6: Dev fake.** With `BLUEBUBBLES_FAKE_URL` set, `imessageClient()` uses that URL and the password `fake` whatever the config says. Add a script `pnpm fake:bluebubbles` (`tsx test/fixtures/fake-bluebubbles.ts --port 4455`) that starts the fake standalone and prints its URL. Document both in the task report.
- [ ] **Step 7: Gates + commit** `feat(channels): BlueBubbles client, fake server, iMessage channel adapter`

---

### Task 5: Email channel (Resend, markdown → HTML)

**Files:**
- Modify: `server/lib/observability/email.ts` (optional `html`), `package.json` (`marked`), `server/lib/channels/registry.ts`
- Create: `server/lib/channels/email/render.ts`, `server/lib/channels/email/channel.ts`
- Test: `test/channels-email.test.ts`

**Interfaces:**
- Produces: `renderEmail(markdown: string): { html: string; text: string }`, `emailSubject(label: string): string` (→ `Bridget · ${label}`), `emailChannel: Channel`.

- [ ] **Step 1: `pnpm add marked`.**
- [ ] **Step 2: Failing tests:**
  - headings, lists and links render;
  - `<script>alert(1)</script>` and `<img onerror=…>` in the markdown are **escaped**, never raw: use `marked` with a renderer whose `html()` returns the escaped text;
  - `text` is the original markdown;
  - `emailSubject('morning-brief') === 'Bridget · morning-brief'`;
  - `sendResendEmail` sends `html` when given (stub `$fetch` via `vi.stubGlobal`, following the `test/stt-whisper.test.ts` pattern);
  - `emailChannel.send`:
    - posts `to` from config and `from`/key from the observability config;
    - a 5xx maps to `retryable: true`, a 4xx to `retryable: false`;
    - a disabled or unconfigured channel maps to `retryable: false` with a clear error.
- [ ] **Step 3: Implement.** Wrap the HTML in a minimal inline-styled container (max-width 640 px, system font). The subject comes from `payload.subject ?? emailSubject('message')`.
- [ ] **Step 4: Registry** — `channelFor('email')` → `emailChannel`.
- [ ] **Step 5: Gates + commit** `feat(channels): email channel via Resend with markdown rendering`

---

### Task 6: Outbox — insert, claim, send, retry, fail note

**Files:**
- Create: `server/lib/channels/outbox.ts`
- Modify: `server/lib/agent/runtime/queue.ts` (`workerTick` gains `deliveriesTick()` next to `jobsTick()`/`dueTaskEvents()`, same try/catch shape)
- Test: `test/channels-outbox.db.test.ts`

**Interfaces:**
- Consumes: `channelFor` (Tasks 4 and 5), `nextAttemptDelayMs` (Task 2), `publishChange`, `appendMessages` (for the fail note).
- Produces:
  ```ts
  export interface NewDelivery { channel: OutboundChannelId; target: string; payload: DeliveryPayload; source: 'reply' | 'job' | 'tool' | 'note'; conversationId?: string | null; messageId?: string | null; jobId?: string | null; runId?: string | null }
  export async function insertDeliveries(tx: DbTx, rows: NewDelivery[]): Promise<string[]>
  export async function deliveriesTick(opts?: { onlyIds?: string[]; mainConversationId?: string; now?: Date }): Promise<{ sent: number; retried: number; failed: number }>
  export const DELIVERY_CLAIM_LIMIT = 10
  export const SENDING_RECLAIM_MS = 120_000
  ```
  `DbTx` is the transaction type the codebase already uses. Find it with `grep -rn "DbTx\|PgTransaction" server | head`; if none exists, use `Parameters<Parameters<ReturnType<typeof useDb>['transaction']>[0]>[0]`.

- [ ] **Step 1: Failing DB tests** (all scoped via `onlyIds`; stub `channelFor` with `vi.mock('../server/lib/channels/registry', ...)` returning a scripted channel):
  1. A pending row is claimed, sent, and marked `sent` with `external_id` and `sent_at`. `firstClaimedAt` is set on the first claim and never changes afterwards.
  2. A retryable failure goes back to `pending`, `attempts = 1`, and `next_attempt_at ≈ now + 30 s`. It is not re-claimed before then (a tick at `now + 10 s` leaves it alone).
  3. After 6 retryable failures it becomes `failed`, and **one** system note row lands in the scratch "main" conversation (`mainConversationId` seam), in the form "Couldn't deliver to iMessage: <error>".
  4. A non-retryable failure fails immediately, with one note.
  5. A `sending` row with `claimed_at` 3 minutes old is reclaimed. A 30-second-old one is not.
  6. `unconfirmed` → `sent_unconfirmed`.
  7. Two concurrent `deliveriesTick` calls send each row exactly once (SKIP LOCKED).
  8. The channel receives `attempts` and `firstClaimedAt`, so the duplicate check can run on a retry (assert that the scripted channel saw `attempts: 1` on the second call).
- [ ] **Step 2: Implement.**
  - Claim in one transaction: `select … where id = any(...)` (when `onlyIds`) `and ((status='pending' and next_attempt_at <= now) or (status='sending' and claimed_at < now - 2 min)) order by next_attempt_at for update skip locked limit 10`. Then set `status='sending', claimed_at=now, first_claimed_at=coalesce(first_claimed_at, now)` and commit.
  - Send each row outside the transaction and update it by id.
  - The failure note is an `event` row (`origin: 'channel:delivery-failed'`) appended to main via `appendMessages`. Only for `source !== 'note'`, so a failed note can never recurse.
  - `publishChange({ resource: 'channelDelivery', action: 'updated', id })` on every status change.
- [ ] **Step 3: Wire into `workerTick`** (unscoped path only, like `jobsTick`).
- [ ] **Step 4: Gates + commit** `feat(channels): delivery outbox with idempotent retries`

---

### Task 7: Inbound — webhook, pipeline, media, origin on user rows, catch-up

**Files:**
- Create: `server/lib/channels/inbound.ts`, `server/api/channels/bluebubbles/webhook.post.ts`
- Modify:
  - `server/middleware/auth.ts`: add `'/api/channels/bluebubbles/webhook'` to `PUBLIC_PREFIXES`; the handler checks the token.
  - `server/lib/agent/runtime/types.ts`: `RunInput.origin?: string`.
  - `server/lib/agent/runtime/queue.ts`: `EnqueueRequest.replyTo?: ReplyTo`, passed to `createRun`.
  - `server/lib/voice/turn-persist.ts`: `TurnPersistContext.origin?: string`; user rows get `origin: ctx.origin ?? null`.
  - `server/lib/agent/runtime/runner.ts`: pass `origin: input.origin` into `buildTurnPersistPayload`.
  - `server/lib/agent/runtime/queue.ts` `workerTick`: add `catchUpTick()`.
- Test: `test/channels-inbound.db.test.ts`, `test/turn-persist.test.ts` (extend), `test/channels-webhook.test.ts`

**Interfaces:**
- Consumes: `parseWebhook`/`parseBlueBubblesMessage`, `isAllowed`, `maskHandle` (Task 2); config (Task 3); `imessageClient` (Task 4); `enqueue`, `getMainConversationId` (the cycle-73 helper that returns main; find it with `grep -rn "mainConversation" server/lib/agent/runtime | head`); `createImage`; `withFailover('stt', m => sttFromModel(m).transcribe(...))`; `recordEvent` for the masked warn.
- Produces:
  ```ts
  export type InboundOutcome = 'enqueued' | 'steered' | 'duplicate' | 'ignored:from-me' | 'ignored:group' | 'ignored:sender' | 'ignored:empty' | 'tapback'
  export async function handleInbound(ev: InboundMessage | TapbackEvent, deps?: { enqueueFn?: typeof enqueue; client?: BlueBubblesClient | null; mainConversationId?: string }): Promise<InboundOutcome>
  export async function catchUpTick(opts?: { force?: boolean; client?: BlueBubblesClient | null }): Promise<{ processed: number; healthy: boolean } | null>   // null = throttled
  export function lastHealth(): { ok: boolean; privateApi: boolean | null; checkedAt: number | null; error?: string }
  export const CATCH_UP_INTERVAL_MS = 120_000
  export const CATCH_UP_OVERLAP_MS = 300_000
  ```

Pipeline (spec §4), **in order**:
1. Tapback → `resolveTapback(ev)`. Task 7 creates `server/lib/channels/approvals.ts` exporting `export async function resolveTapback(_ev: TapbackEvent): Promise<'tapback'> { return 'tapback' }`; Task 9 replaces its body.
2. `isFromMe` → `ignored:from-me`.
3. `isGroup` → `ignored:group`.
4. Sender not allowed → `recordEvent({ kind: 'channel', name: 'imessage:unknown-sender', severity: 'warn', meta: { sender: maskHandle(sender) } })` → `ignored:sender`.
5. Build the input:
   - text;
   - each attachment:
     - `image/*`: download, then refuse a HEIC/HEIF result with the note "(couldn't load the photo)"; otherwise `createImage(buffer, mime, name)` → `AttachmentRef { id, kind: 'image', mime }`, capped at 4 attachments and 20 MB each;
     - `audio/*`: download → STT with `{ mime, filename: name }` → the transcript is appended to the text as `(voice memo) <transcript>`; on failure the note "(a voice memo I couldn't transcribe)";
     - anything else: the note "(an attachment I can't open: <name>)".
   - Empty text with no attachments → `ignored:empty` (still record the GUID).
6. **One transaction:** insert `channel_inbound { guid, channel: 'imessage', sender, received_at: date }` with `onConflictDoNothing().returning()`. No row → `duplicate` (stop). Then `enqueue({ sessionKey: 'main', trigger: 'user', profile: 'interactive', input: { text, modality: 'text', attachments, origin: 'imessage:' + chatGuid }, replyTo: { channel: 'imessage', chatGuid, messageGuid: guid } })`.
   - Keep the `channel_inbound` insert and the enqueue as close together as the code allows. If `enqueue` cannot take a transaction, insert the dedupe row first and delete it if `enqueue` throws. Record the chosen approach in the report.
   - Set `channel_inbound.run_id` to the result.
7. If `result.steered`: `update agent_runs set reply_to = $replyTo where id = $runId and reply_to is null` → `steered`. Otherwise `enqueued`.
   - Note: `enqueue` steers only into **interactive** runs. A busy headless job run makes the message queue as its own run, keeping its `reply_to` (Review Focus 5).
   - The steered text is persisted by the runner as a user row **without** origin. Accepted: the 📱 marker shows on queued messages but not on steers. Ledger this.

Webhook route: `token = getQuery(event).token` → `verifyWebhookToken` false → `throw createError({ statusCode: 404 })`. Body → `parseWebhook`. A null event → `{ ok: true }`. Otherwise `await handleInbound(event)` → `{ ok: true, outcome }`. Always 200 after the token check, so BlueBubbles never retries into a loop. Wrap in try/catch: log the error and still return 200 with `ok: false`.

Catch-up:
- Throttled in memory to 2 min; `force` bypasses the throttle.
- `client.serverInfo()` sets `lastHealth`. On failure, set health `ok: false` and return.
- `cursor = max(received_at)` from `channel_inbound`, or now minus 1 h when there is none, minus the 5-min overlap.
- `messagesSince(cursor)` → `parseBlueBubblesMessage` each → `handleInbound`.
- Also confirm `sent_unconfirmed` deliveries younger than 1 day: `findOwnMessage(target, text, firstClaimedAt)` found → `sent`. After 1 day → `failed` with no note.

- [ ] **Step 1: turn-persist origin test** — a user row carries `origin` when `ctx.origin` is set; an assistant row never does.
- [ ] **Step 2: Failing inbound DB tests.** Scratch conversation as "main" via the seam; a fake enqueue that records calls and returns `{ runId: <real run row>, steered: false, ... }` (create a real run row the way `jobs-tick.db.test.ts` does, so the `channel_inbound.run_id` and `reply_to` updates hit real rows); the fake BlueBubbles server as the client.
  1. An allowed text → `enqueued`, with origin `imessage:<chat>` and the right `replyTo`.
  2. The same GUID twice → the second call gives `duplicate`, and enqueue was called once.
  3. Webhook and catch-up concurrently for the same GUID: `Promise.all([handleInbound(e), handleInbound(e)])` gives exactly one `enqueued`.
  4. A group chat → `ignored:group`; from-me → `ignored:from-me`.
  5. An unknown sender → `ignored:sender`, and an activity row whose meta holds the masked handle, never the raw one.
  6. A photo → one image attachment with a png MIME.
  7. The fake returns `image/heic` for a download (add a fake option `heicAttachments: true`) → no attachment, and the text contains "(couldn't load the photo)".
  8. Voice memo with STT stubbed (inject a `transcribe` dep): ok → the text contains the transcript; throws → the text contains "(a voice memo I couldn't transcribe)", and the message is still enqueued.
  9. `steered: true` from a fake enqueue → the run's `reply_to` is set when it was null and not overwritten when it was set.
  10. Catch-up:
      - a pushed message after the cursor is enqueued once;
      - running it twice does nothing new;
      - `serverInfo` failing leaves `lastHealth().ok` false and processes nothing.
- [ ] **Step 3: Webhook route test** (unit, handler with deps mocked):
  - a wrong token → 404, a missing token → 404, a disabled channel → 404;
  - the correct token plus a text payload → `handleInbound` called;
  - `handleInbound` throwing → still 200.
- [ ] **Step 4: Implement, run the gates, commit** `feat(channels): inbound iMessage — webhook, pipeline, media, catch-up`

---

### Task 8: Runner integration — deliveries in the persist transaction, typing/read, reply images, job `deliver`

**Files:**
- Modify:
  - `server/services/conversations.ts`: `appendMessages(conversationId, msgs, parentId?, opts?: { inTx?: (tx: DbTx, ids: string[]) => Promise<void> })`; the hook runs inside the existing transaction after the inserts and the leaf move.
  - `server/lib/channels/deliver.ts`: add `planDeliveries`.
  - `server/lib/agent/runtime/runner.ts`: call `appendMessages(..., { inTx })` in the success path only (not the rescue path; see below); typing/markRead at start and end.
  - `server/lib/agent/jobs/parse.ts`: `deliver` enum validation and the `[auto]` default.
  - `server/lib/agent/jobs/seeds.ts` and `store.ts`: the seed upgrade.
- Test: `test/channels-deliver.db.test.ts`, `test/jobs-parse.test.ts` (extend), `test/jobs-seeds.db.test.ts` (extend or create), `test/conversations-append.db.test.ts` (extend or create)

**Interfaces:**
- Consumes: `resolveDeliverChannels` (Task 2), `loadChannelsConfig`, `isAway` (Task 3), `insertDeliveries` (Task 6), `imessageClient` (Task 4).
- Produces:
  ```ts
  export function extractImageIds(markdown: string): string[]   // /api/images/<uuid>/raw → uuid; /api/i/<slug> → resolved later; returns uuids only
  export async function planDeliveries(run: AgentRun, reply: { text: string; messageId: string; conversationId: string }): Promise<NewDelivery[]>
  ```
  `planDeliveries` rules:
  - `run.replyTo` → one `imessage` delivery to `replyTo.chatGuid`, `source: 'reply'`.
  - `run.jobId` → load the job's spec (`getJob` + `parseJob`) → `resolveDeliverChannels(spec.deliver, …)` → for `imessage`: target `defaultChatGuid ?? resolveDirectChat(defaultHandle)`, skipped when neither is set; for `email`: target `config.email.to`, subject `emailSubject(job.slug)`. `source: 'job'`.
  - Both → imessage de-duplicated by target.
  - Images from `extractImageIds(text)` go into every iMessage payload; email keeps them as markdown links.
  - A job whose `deliver` names a channel that is now disabled → skipped with a log line plus an activity `warn` (planning deviation from spec §8's "one note on main"; see Self-review notes).

- [ ] **Step 1: jobs parse tests (failing):**
  - `deliver` defaults to `['auto']`;
  - `deliver: [app, sms]` → an error `invalid deliver: sms (allowed: app, auto, imessage, email)`;
  - `deliver: []` → error.
  - Configured-ness is **not** validated in the pure parser. Add it in `store.ts`'s write validation instead: saving an **enabled** job whose `deliver` includes `imessage`/`email` while that channel is disabled → `JobValidationError('deliver: iMessage is not set up — configure it in Settings → Channels')`. A disabled job may name it.
  - Test this in the existing jobs store DB tests with scoped slugs.
- [ ] **Step 2: Seeds.** Update the `deliver` lines in `SEED_JOBS`: morning-brief `deliver: [auto, imessage]`, evening-wrap and heartbeat `deliver: [auto]`, session-digest `deliver: [app]`.
  - Add `upgradeSeedJobs()` in `store.ts`. Keep a constant `SEED_JOBS_V1` holding the exact cycle-74 seed strings (copy them verbatim from `git show 6b7110c:server/lib/agent/jobs/seeds.ts`).
  - For each seed slug whose current content hash equals the hash of the V1 content, `saveJob` it to the new content with actor `system`. Any edited seed is left alone.
  - Run it after `installSeedJobs` in the same boot plugin.
  - DB test with scoped fake slugs: add a seam `upgradeSeedJobs({ seeds, previous, onlySlugs })`. An unedited seed upgrades, an edited one doesn't, and running it twice is a no-op.
- [ ] **Step 3: `appendMessages` inTx test** — the hook runs with the new ids in order; a throw in the hook rolls back the rows and the leaf. Use a scratch conversation.
- [ ] **Step 4: `planDeliveries` DB tests:**
  - `replyTo` → one reply row targeted at the chat;
  - a job with `[auto]` → an iMessage row when away and none when present (use `markActive` / `_resetPresence`);
  - `[email]` → an email row with the subject `Bridget · <slug>`;
  - `[auto, imessage]` → a single iMessage row;
  - an image URL in the reply → `payload.images` holds the id;
  - iMessage disabled → no iMessage rows and no throw.
  - Snapshot and restore the channel settings.
- [ ] **Step 5: Runner wiring.** In the success path:
  ```ts
  const ids = await appendMessages(conversationId, withSteers(payload, drainedSteers), turnLeafId, {
    inTx: async (tx, ids) => {
      if (!(run.replyTo || run.jobId) || added.length < 2) return
      const plans = await planDeliveries(run, { text: reply, messageId: ids[ids.length - 1]!, conversationId })
      if (plans.length) await insertDeliveries(tx, plans)
    }
  })
  ```
  `planDeliveries` only **reads** outside the transaction (config, presence, job). That is acceptable: only the insert must be atomic with the message.
  - **Rescue path:** no deliveries. A rescued, unfinished turn isn't worth texting. Ledger this.
  - **Silent runs:** `added` is empty, so the append never runs and nothing is delivered.
  - Publish `channelDelivery` after commit.
- [ ] **Step 6: Typing/read.** At the top of `runTurn`, after `hub.beginRun`: if `run.replyTo`, then fire-and-forget `client.markRead(chat)` and `client.typing(chat, true)`, with errors logged. In `finally`, `typing(chat, false)`. Only when `lastHealth().privateApi !== false`. Extract a tiny `channelPresence.start(run)` / `.stop(run)` in `server/lib/channels/presence.ts` so the runner diff stays two lines. Unit-test it with a fake client.
- [ ] **Step 7: Gates + commit** `feat(channels): runner writes deliveries with the reply; typing and read receipts; job deliver`

---

### Task 9: Approvals over iMessage

**Files:**
- Create: `server/lib/channels/approvals.ts`
- Modify: `server/lib/agent/runtime/runner.ts` (register the approval channel for `replyTo` runs), `server/lib/channels/inbound.ts` (`resolveTapback` import)
- Test: `test/channels-approvals.db.test.ts`

**Interfaces:**
- Consumes: `registerApprovalChannel`/`unregisterApprovalChannel` (`server/lib/agent/runtime/approvals.ts`), `ApprovalRequest` (`server/lib/agent/types.ts`), `imessageClient`, `lastHealth`.
- Produces:
  ```ts
  export function imessageApprovalChannel(runId: string, chatGuid: string, deps?: { client?: BlueBubblesClient | null; pollMs?: number; timeoutMs?: number }): (req: ApprovalRequest) => Promise<{ approved: boolean }>
  export async function resolveTapback(ev: TapbackEvent): Promise<'tapback'>
  export async function expireApprovals(now?: Date): Promise<number>
  export const APPROVAL_TIMEOUT_MS = 600_000
  ```

Behaviour:
1. Private API known to be off (`lastHealth().privateApi === false`) or no client → `{ approved: false }` immediately. Recorded as denied with the reason `private-api-off`; the runner's existing denial flows back to the model, and her reply explains.
2. Insert a `channel_approvals` row (`expires_at = now + 10 min`, `chat_guid`).
3. Send `Run \`${req.command}\`?\n👍 to approve · 👎 to deny` via `sendText` directly, not the outbox, and store its `guid` as `prompt_guid`. If the send fails → mark it `denied` → `{ approved: false }`.
4. Wait: an in-process `Map<approvalId, resolve>` plus a DB poll every `pollMs` (default 5 s) until the status is not `pending` or `timeoutMs` passes.
   - On timeout, update the row to `expired`, guarded on `status='pending'` → deny.
   - If the guarded update matched nothing, re-read: a tapback won the race, so use its status.
5. `resolveTapback(ev)`:
   - Ignore if `removed`, `isFromMe`, or the sender isn't allowed.
   - Find the pending approval with `prompt_guid = ev.targetGuid` and `expires_at > now`.
   - `love|like` → `approved`; `dislike` → `denied`; others → ignored.
   - Guarded update `where status='pending'`, then resolve the in-process waiter if present.
6. Runner: after `registerTurnStream`, `if (run.replyTo) registerApprovalChannel(run.id, imessageApprovalChannel(run.id, run.replyTo.chatGuid))`. The existing `finally` already unregisters. `approvalFor` still checks the exec allowlist first, which is unchanged.

- [ ] **Step 1: Failing DB tests** with the fake BlueBubbles server and `pollMs: 50`, `timeoutMs: 500`:
  1. The prompt is sent, and a like tapback (via `resolveTapback`) → approved.
  2. A dislike → denied.
  3. No tapback → expired, denied, and the row's status is `expired`.
  4. A tapback from a non-allowed sender, or a removed tapback → ignored, so the request expires.
  5. A tapback on a different message → ignored.
  6. A restart: the in-process waiter is absent, but the DB status set by `resolveTapback` is picked up by the poll.
  7. Private API off → immediate deny, and no send.
  8. The prompt send fails → deny.
- [ ] **Step 2: Implement + wire.** Also call `expireApprovals()` from `catchUpTick`, as housekeeping.
- [ ] **Step 3: Gates + commit** `feat(channels): exec approvals over iMessage via tapback`

---

### Task 10: `send_message` tool

**Files:**
- Create: `server/lib/agent/tools/channels.ts`
- Modify: `server/lib/agent/tools.ts` (spread `channelTools`), `server/lib/agent/runtime/gate.ts` (`send_message` in `APPEND_TOOLS`)
- Test: `test/channels-tool.db.test.ts`

**Interfaces:**
- Produces: `channelTools: AgentTool[]` with `send_message` (`kind: 'create'`, schema `{ channel: z.enum(['imessage', 'email']), text: z.string().min(1).max(4000), subject: z.string().max(200).optional() }`).

Behaviour:
- Channel disabled → the result "iMessage isn't set up — Tony can configure it in Settings → Channels" (no throw).
- Target = `defaultChatGuid ?? resolveDirectChat(defaultHandle)` for iMessage, or `email.to`; none → a similar explanation.
- Rate limit: count `channel_deliveries where source='tool' and channel=$c and created_at > now - 1 h`; ≥ 20 → the result "rate limit reached (20/hour)".
- Insert a delivery (`source: 'tool'`, subject `emailSubject('message')` unless one is given) and an `event` row on main (`origin: 'channel:sent'`, content "Sent to iMessage: <first 120 chars>").
- Publish.
- Return `{ result: { deliveryId, status: 'pending' }, summary: 'queued for iMessage' }`.
- Never rethrow: follow the cycle-74 tools' catch-all pattern in `server/lib/agent/tools/jobs.ts`.

- [ ] **Step 1: Failing tests:**
  - happy path → one delivery row plus one event row;
  - disabled → explanation, no rows;
  - the 21st call in an hour → the limit message; seed 20 rows with `source: 'tool'` scoped by a marker `conversation_id`, and **scope the count query to the test's rows via a test seam** (`deps.countSince`) so real rows can't interfere;
  - the schema has no address field (assert the zod shape keys are exactly `['channel', 'text', 'subject']`).
  - The headless gate classifies `send_message` as append: `classifyForHeadless('send_message')` doesn't throw and returns the append class.
- [ ] **Step 2: Implement, gates, commit** `feat(channels): send_message tool (Tony-only targets, rate limited)`

---

### Task 11: UI — Settings → Channels, status dot, 📱 marker, delivery badges

**Files:**
- Create: `server/api/settings/channels/test-imessage.post.ts`, `server/api/settings/channels/test-email.post.ts`, `server/api/channels/status.get.ts`, `app/pages/settings/channels.vue`, `app/components/settings/ChannelsTab.vue`, `app/composables/useChannelsConfig.ts`, `app/lib/channels/delivery-badge.ts` (pure)
- Modify:
  - `app/layouts/default.vue`: the settings nav entry `{ label: 'Channels', icon: 'i-lucide-message-circle', to: '/settings/channels' }` after Activity & Alerts, plus a status dot.
  - `app/lib/agent/to-ui-messages.ts`: forward `origin` for user rows into `metadata.origin`.
  - The conversation DTO path (`msgToDTO` / `ConversationMessageDTO`): add `deliveries?: { channel: 'imessage' | 'email'; status: string }[]` for assistant rows, loaded in one query per conversation read (`select message_id, channel, status from channel_deliveries where message_id = any($ids)`).
  - `app/components/agent/Conversation.vue`: a 📱 marker on user bubbles with an `imessage:` origin; delivery badges near the reply actions.
- Test: `test/delivery-badge.test.ts`, `test/to-ui-messages.test.ts` (extend), `test/channels-test-routes.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/channels/status` → `{ imessage: { enabled, ok, privateApi, checkedAt, error? }, email: { enabled, ready } }`, from `lastHealth()` and config.
  - `deliveryBadge(d: { channel; status }) → { icon: string; label: string; color: 'success' | 'warning' | 'error' | 'neutral' }`:
    - `sent` → success;
    - `sent_unconfirmed` → neutral "sent (unconfirmed)";
    - `pending` / `sending` → neutral "sending";
    - `failed` → error.
    - Icons: `i-lucide-smartphone` for iMessage, `i-lucide-mail` for email.

- [ ] **Step 1: Test routes.**
  - `test-imessage`:
    - `serverInfo()` → returns `{ privateApi, serverVersion, detectedIcloud }`;
    - if `body.send === true`, sends "Test from MyMind ✅" to the default chat **through the outbox** (`source: 'note'`) so it follows the same path;
    - updates `lastHealth` by running `catchUpTick({ force: true })`.
  - `test-email`: queues a `source: 'note'` email delivery with the subject `Bridget · test`.
  - Unit-test them with mocked deps.
- [ ] **Step 2: ChannelsTab.vue** (mirror `ActivityAlertsTab.vue` + `useObservabilityConfig`: a draft object, Save button, toast):
  - **iMessage:**
    - `USwitch` enabled; `UInput` server URL; `UInput type=password` for the password, with help text "A password is set. Type to replace." / "Required.";
    - allowed handles as a `UInputTags`, or a textarea with one handle per line if `UInputTags` isn't in the installed Nuxt UI version (check `node_modules/@nuxt/ui` for it);
    - default handle as a `USelect` over the allowed handles, with no empty-string item: use `undefined` for none;
    - a **Test connection** button and a **Send test message** button, showing the Private API badge (green "Private API on" / amber "Private API off");
    - the webhook URL (origin + `webhookUrlPath`) read-only, with a copy button and **Regenerate** (with a confirm modal);
    - a small "In BlueBubbles: Settings → API & Webhooks → add this URL, events: New Messages, Message Updates" note.
  - **Email:** a switch, the to-address, **Send test email**, and "Uses the Resend key and sender from Activity & Alerts" with a link. Disabled when `resendReady` is false.
  - **Presence:** a `UInputNumber` for away-after minutes.
- [ ] **Step 3: Status dot.** `useQuery(['channels', 'status'])`, refetched every 60 s, drawing a dot on the Channels nav item: green when ok, amber when Private API is off, red when not ok. Hidden when iMessage is disabled.
- [ ] **Step 4: Conversation.** Forward origin in `to-ui-messages.ts`, and extend its test so a user row with `origin: 'imessage:…'` has `metadata.origin`. Render a `UIcon name="i-lucide-smartphone"` with the tooltip "via iMessage" on those bubbles. Render delivery badges (`UBadge` size xs, variant subtle) under assistant bubbles that have `deliveries`. `channelDelivery` live events already invalidate `['conversation']` (Task 1).
- [ ] **Step 5: Browser-validate** (`playwright-cli`, dev on a spare port, `BLUEBUBBLES_FAKE_URL` pointed at `pnpm fake:bluebubbles`; **never** the real server):
  1. Configure iMessage with the fake URL and allowed handle `+15550001111`; Save; reload; values persist; the password shows as set; the webhook URL is shown.
  2. Test connection → "Private API on".
  3. `curl` a webhook text payload from `+15550001111` with the right token → within a few seconds a user bubble with the 📱 marker appears in `/agent` main; Bridget replies (a real model run on dev main, accepted); the fake records a `sendText` to the chat; the reply bubble shows "sent".
  4. A wrong token → 404.
  5. Stop the fake → send another webhook → the badge shows "sending", then after a restart of the fake and ≥ 30 s it shows "sent".
  6. The Channels nav dot turns red while the fake is down (after a forced test).
  7. **Restore the channel settings to their pre-test values at the end** (snapshot them first via the GET), then delete scratch runs and messages only if they were created in a scratch thread. Main-thread messages from scenario 3 stay; this is accepted.
  Screenshots go to the scratchpad. Kill only your own dev-server and fake PIDs.
- [ ] **Step 6: Gates + commit** `feat(channels): Settings → Channels, status dot, iMessage marker and delivery badges`

---

### Task 12: Jobs UI — `deliver` in templates and the status panel

**Files:**
- Modify: `app/lib/jobs/templates.ts` (templates carry `deliver: [auto]`; the digest template `deliver: [app]`), `app/components/jobs/JobStatusPanel.vue` (show "Delivers to: App · iMessage when away · Email", from the parsed `deliver` the GET returns; add `deliver` to the GET response if it's absent), `server/api/jobs/[slug].get.ts` if needed
- Test: `test/job-templates.test.ts` (extend: templates still parse with the real `parseJob`), `test/deliver-label.test.ts` (pure `deliverLabel(deliver: string[]): string`)

- [ ] **Step 1: Failing tests** for `deliverLabel`:
  - `['auto']` → "App · iMessage when you're away"
  - `['auto', 'imessage']` → "App · iMessage"
  - `['app']` → "App only"
  - `['email']` → "App · Email"
  - (`app` is always included, because messages always land in main.)
- [ ] **Step 2: Implement.** Browser-check one job page shows the label. Commit `feat(jobs): show and template the deliver targets`

---

### Task 13: Acceptance (fake), docs, handover

**Files:**
- Create: `docs/wiki/channels.md`, `docs/handovers/2026-09-28-bridget-channels.md`
- Modify: `docs/wiki/agent-jobs.md` (`deliver`), `docs/wiki/agent-runtime.md` (`reply_to`, iMessage approvals, deliveries in the persist transaction), `docs/wiki/README.md`, `docs/superpowers/plans/00-roadmap.md` (row 75), `docs/DEPLOYMENT.md` (the BlueBubbles webhook registration and network reachability)

- [ ] **Step 1:** All gates green; record the counts.
- [ ] **Step 2: Fake-server acceptance** with `playwright-cli`: spec §11 scenarios 1–7, **run against the fake**, plus an email scenario with `$fetch` to Resend intercepted. To stub Resend in dev, add a dev-only env `RESEND_FAKE=1` that makes `sendResendEmail` log and resolve instead of calling the API. The guard must be `process.env.RESEND_FAKE === '1' && import.meta.dev`, so it can never ship active.
  - Seeds stay disabled with an unchanged content hash, except the one sanctioned `deliver` upgrade from Task 8. Compare before and after.
  - Restore the channel settings.
- [ ] **Step 3: Docs:**
  - `channels.md` covers the architecture, settings keys, webhook registration steps in BlueBubbles, the payload fields relied on, the outbox states and backoff, the duplicate check, approvals, the status dot, operational SQL (stuck deliveries, recent inbound), and the fake server.
  - The handover:
    - frontmatter like the cycle-74 handover, with migration 0057 and `migrations_run_on_prod: false`;
    - every ledger ruling;
    - the **real-phone acceptance checklist** (spec §11 scenarios 1–5) for the controller to run with Tony;
    - the deploy steps:
      1. Set Settings → Channels on prod.
      2. Register the webhook URL in BlueBubbles, using the prod LAN URL `http://<LXC IP>:3000/api/channels/bluebubbles/webhook?token=…` or the public one.
      3. Confirm the Private API badge.
- [ ] **Step 4: Commit** `docs(cycle-75): channels wiki, handover, roadmap`

---

## Self-review notes (planning rulings)

Deviations from the spec's wording, made while planning:
- **The duplicate check is by own-message text within the claim window, not by `tempGuid`.** BlueBubbles does not persist `tempGuid` to chat.db, so the spec's `findByTempGuid` is not implementable. `first_claimed_at` bounds the window.
- **Two schema additions:** `channel_deliveries.source` for the tool rate limit and to stop fail notes recursing, and `channel_approvals.chat_guid`.
- **`reply_to` on steers:** steered iMessage text is persisted without `origin`, so no 📱 marker on steers.
- **A rescued turn** (the runner's crash rescue path) creates no delivery.
- **A job naming a channel that is now disabled** is skipped with an activity `warn` rather than a note on main.
- **Seed `deliver` changes** reach existing installs only through a hash-guarded `upgradeSeedJobs`. Edited seeds are never touched.
- **Phone normalisation** is a small in-house function with a US default, not libphonenumber (YAGNI).
- **The webhook token is visible in the session-authed settings GET**, inside the copyable URL, because Tony must paste it into BlueBubbles. The password is never returned.
