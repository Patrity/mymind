---
title: "Bridget channels — two-way iMessage via BlueBubbles, outbound email via Resend, presence-aware delivery for jobs (cycle 75)"
cycle: 75
date: 2026-09-28
status: spec
supersedes: null
builds_on: 2026-09-28-bridget-jobs-design.md
---

# Bridget channels (cycle 75)

Cycle 73 made turns server-owned runs with one main thread; cycle 74 made Bridget talk on her own
through jobs, but everything she says still lands only in `/agent`. Tony's ask: **reach Bridget and
be reached by her outside the app**, like Hermes and pi agent — text her over iMessage (BlueBubbles)
and get replies there, and have jobs such as the morning brief delivered to his phone. Email via
Resend is added as an outbound-only channel for long digests.

Environment facts this spec relies on:
- A BlueBubbles server runs on the Mac Mini (`192.168.2.35:1234`, public `msg.costanzoclan.com`),
  signed in as `bridget.ai@icloud.com`. **The Private API is enabled** (Tony, 2026-09-28) — the
  first build task verifies it via `GET /api/v1/server/info` (`private_api: true`) before anything
  depends on it.
- Without the Private API, `POST /message/text` times out even when the message sends; §8 keeps a
  fallback for that.
- Resend is already wired for activity alerts (`server/lib/observability/email.ts`, text-only).

## 1. Decisions (brainstorm, 2026-09-28)

| # | Decision | Rejected |
|---|---|---|
| D1 | **iMessage conversations live in the main thread.** One Bridget, one memory; inbound texts appear in `/agent` main tagged by channel, and replies go back to the channel they came from. | a per-channel thread with summaries; main + `/new` side threads |
| D2 | **Proactive delivery follows Tony.** A new `deliver: [auto]` default sends to iMessage only when Tony is *away* from the app; a job can also pin channels explicitly (`[imessage]`, `[email]`, mixes). Replies to Tony's own messages always return to the origin channel. | per-job only; always both |
| D3 | **iMessage turns get the app's tool policy**, not the headless gate. Anything that needs approval in the app is texted to Tony; a 👍 tapback approves, 👎 or 10 min silence denies. | headless gate (mutations → /review); full trust |
| D4 | **Media:** inbound photos (vision attachments), voice memos (existing STT), links as text; outbound images she produced in the turn. No voice replies this cycle. | text only; voice replies |
| D5 | **Channels:** BlueBubbles (two-way) + email via Resend (outbound only, never chosen by `auto`), behind one `Channel` interface. Telegram etc. later. | BlueBubbles only; + Telegram |
| D6 | **Architecture: DB outbox + webhook + periodic catch-up.** Deliveries are rows claimed by the worker tick and retried idempotently; inbound arrives by webhook and a catch-up poll closes gaps. | direct send at run end; a separate gateway process |
| D7 | Email subject is `Bridget · <job slug or "message">` — no date stamp. | dated subjects |

## 2. Data model — migration 0057 (additive)

### 2.1 `channel_deliveries` (the outbox)
- `id` uuid pk — doubles as the BlueBubbles `tempGuid` (idempotency key).
- `channel` text (`imessage` | `email`), `target` text (chat GUID or email address).
- `conversation_id` uuid null, `message_id` uuid null (the assistant row this mirrors),
  `job_id` uuid null (FK set null), `run_id` uuid null (FK set null).
- `payload` jsonb `{ text: string, images?: string[] /* upload ids */, subject?: string }`.
- `status` text: `pending` | `sending` | `sent` | `sent_unconfirmed` | `failed`.
- `attempts` int default 0, `next_attempt_at` timestamptz default now(), `claimed_at` timestamptz
  null, `last_error` text null, `external_id` text null (BlueBubbles message GUID), `created_at`,
  `sent_at` null.
- Index `(status, next_attempt_at)`; index `(message_id)`.

### 2.2 `channel_inbound` (dedupe + catch-up cursor)
- `guid` text pk (BlueBubbles message GUID), `channel` text, `sender` text (normalised handle),
  `received_at` timestamptz (the message's own date), `run_id` uuid null, `created_at`.
- The catch-up cursor is `max(received_at)` for the channel.

### 2.3 `channel_approvals`
- `id` uuid pk, `run_id` uuid (FK cascade), `request` jsonb (the `ApprovalRequest`),
  `prompt_guid` text null (the GUID of the "Run …?" message once sent), `status` text
  (`pending` | `approved` | `denied` | `expired`), `expires_at` timestamptz, `resolved_at` null.
- Lives in the DB so a tapback after a restart resolves (or cleanly finds it expired).

### 2.4 `agent_runs.reply_to`
- jsonb null: `{ channel: 'imessage', chatGuid: string, messageGuid: string }`. Set on runs
  created from an inbound channel message. Steers merged into a running run do not change it; a
  run's reply goes to the `reply_to` of the run, and a queued inbound message gets its own run.

### 2.5 Settings (existing `settings` table, keys)
- `channel_imessage`: `{ enabled, serverUrl, password, webhookToken, allowedHandles: string[],
  defaultHandle: string | null, defaultChatGuid: string | null }`. `password` and `webhookToken`
  never leave the server (masked in GET responses, write-only in PUT).
- `channel_email`: `{ enabled, to }` (sender + API key come from the existing Resend alert config).
- `presence_away_minutes`: number, default 10.

## 3. The channel layer — `server/lib/channels/`

```ts
type ChannelId = 'app' | 'imessage' | 'email'
interface Channel {
  id: ChannelId
  isConfigured(): Promise<boolean>
  send(d: ChannelDelivery): Promise<SendResult>   // outbox rows only; 'app' has no rows
  react?(chatGuid: string, messageGuid: string, tapback: Tapback): Promise<void>
  typing?(chatGuid: string, on: boolean): Promise<void>
  markRead?(chatGuid: string): Promise<void>
}
type SendResult = { ok: true; externalId?: string; unconfirmed?: boolean } | { ok: false; error: string; retryable: boolean }
```

- `app` — today's stream + persisted row; it is a `ChannelId` for `deliver` resolution only.
- `imessage` — `bluebubbles/client.ts` (thin REST client: `serverInfo`, `sendText`,
  `sendAttachment`, `react`, `typing`, `markRead`, `messagesSince`, `findByTempGuid`,
  `downloadAttachment`), `bluebubbles/channel.ts` (the adapter), `bluebubbles/parse.ts` (webhook
  payload → `InboundMessage`, pure).
- `email` — `email/channel.ts`: markdown → sanitised HTML (`marked`, raw HTML disabled) + plain
  text; `sendResendEmail` gains an optional `html`.
- `handles.ts` (pure): normalise phone numbers to E.164 (US default country) and emails to
  lowercase; `isAllowed(handle, allowlist)`.

## 4. Inbound (iMessage)

1. **Webhook** `POST /api/channels/bluebubbles/webhook?token=<t>`: excluded from session auth in
   `server/middleware/auth.ts`; token compared with `timingSafeEqual`; mismatch or channel
   disabled → 404. Handles `new-message` and `updated-message`; everything else → 200 no-op.
2. **Filter** (in order): from Bridget herself (`isFromMe`) → drop; group chat → drop; sender not
   in `allowedHandles` → drop + activity-log `warn` with the handle masked; GUID already in
   `channel_inbound` → drop. A tapback (`associatedMessageType` set) is routed to approvals (§6)
   and never becomes a turn.
3. **Normalise**: text; photos (`image/*`) downloaded via BlueBubbles into the existing uploads
   store and attached as `AttachmentRef`s (same MIME/size limits as the app composer); voice memos
   (`audio/*`, incl. `.caf`) → the existing STT chain, transcript used as the text; other
   attachments → a one-line note. A failed download/transcription never blocks the text: the
   message carries "(couldn't load the photo)" / "(a voice memo I couldn't transcribe)".
4. **Enqueue** on main through the existing `enqueue()` as `trigger: 'user'`,
   `profile: 'interactive'`, the user row's `origin = 'imessage:<chatGuid>'`, and
   `reply_to` set. Insert the `channel_inbound` row in the same transaction. If an interactive run
   is active on main, the existing steer path applies (the message is merged into that run, and
   its reply goes to that run's `reply_to`; a steer from iMessage into an app-originated run sets
   `reply_to` on that run if it had none, so Tony still gets the answer on his phone).
5. **Presence of the run**: when the run starts, `markRead` + `typing(on)`; `typing(off)` when it
   ends. Failures are logged, never fatal.
6. **Catch-up**: on boot and every 2 min (worker tick, throttled), `messagesSince(cursor − 5 min
   overlap)` for allowed direct chats, each through steps 2–5. The GUID dedupe makes overlap safe.
   The same call doubles as the health check (§8).

The `/agent` UI shows inbound iMessage rows with a small 📱 marker (from `origin`).

## 5. Outbound

### 5.1 Resolving where a message goes
- **Reply to an inbound message**: when a run with `reply_to` finishes and is not suppressed, the
  runner writes one `channel_deliveries` row (text + images produced this turn) **in the same
  transaction** as the assistant message.
- **Job output**: resolve the job's `deliver` list when its run finishes non-silently:
  - `app` — nothing extra (the message is in main).
  - `auto` — add `imessage` iff the iMessage channel is enabled and Tony is **away**.
  - `imessage` / `email` — add explicitly.
  - Duplicates collapse; `email` is never implied by `auto`.
- **Silent runs deliver nothing.**
- **Away**: no presence ping within `presence_away_minutes`. Pings: the client posts
  `POST /api/presence` (auth'd) on input/focus/visibility change, throttled to once a minute, from
  any page; the server keeps `lastActiveAt` in memory. After a restart the server treats Tony as
  away until the first ping (accepted: at most one extra iMessage).

### 5.2 The outbox worker
- Runs in the worker tick: claim up to 10 rows `status in ('pending') and next_attempt_at <= now()`
  plus `sending` rows with `claimed_at < now() - 2 min` (crash reclaim), `for update skip locked`,
  set `sending`, commit, then send each.
- **iMessage send**: text via `sendText({ chatGuid, message, tempGuid: id, method: 'private-api' })`,
  then each image via `sendAttachment`. Before any retry (`attempts > 0`), `findByTempGuid(id)`: if
  it exists, mark `sent` without resending.
- **Result**: ok → `sent` (+ `external_id`, `sent_at`); `unconfirmed` → `sent_unconfirmed`
  (confirmed or not by the next catch-up via `findByTempGuid`); retryable error → back to `pending`
  with `next_attempt_at` per backoff **30 s, 2 m, 10 m, 1 h, 1 h, 1 h** (6 attempts); non-retryable
  or exhausted → `failed` + a system note on main ("Couldn't deliver to iMessage: <error>").
- `defaultChatGuid` for proactive messages: resolved from `defaultHandle` on first send
  (BlueBubbles chat lookup / `iMessage;-;<handle>`), cached in the setting.
- Live resource `channelDelivery` → the `/agent` message shows a small status badge
  (📱 sent · pending · failed / ✉️ sent · failed) for assistant rows with deliveries.

### 5.3 `send_message` tool
`send_message({ channel: 'imessage' | 'email', text, subject? })`
- Targets **only** the configured default handle / email — no address parameter.
- Append-class (runs in background runs too); rate limit 20/hour/channel (count of rows with no
  `message_id` created by the tool in the last hour); writes a delivery row plus a short event row
  on main ("Sent to iMessage: …").
- Returns the delivery id and its status; never throws.

## 6. Approvals over iMessage
- For runs with `reply_to.channel === 'imessage'`, the runner registers an approval channel via
  the existing `registerApprovalChannel(runId, fn)`. The exec allowlist still applies first
  (`approvalFor`).
- `fn(req)`: insert a `channel_approvals` row (`expires_at = now + 10 min`), send
  "Run `<command>`? 👍 to approve, 👎 to deny" directly (not via the outbox — it must be prompt),
  store `prompt_guid`, then await resolution (in-process promise keyed by approval id + a DB poll
  every 5 s as the restart-safe fallback).
- Tapback webhook: `associatedMessageGuid` matches a pending `prompt_guid` and the reactor is an
  allowed handle → `love`/`like` (👍/❤️) = approved, `dislike` (👎) = denied. Anything else is
  ignored. Expiry → `expired` = denied, and she says so in the reply.
- If the Private API is unavailable, approvals deny immediately with an explanation.

## 7. Configuration UI — `/settings/channels`
Following the existing settings tabs (Nuxt UI rules apply):
- **iMessage (BlueBubbles)**: enable switch, server URL, password (write-only), allowed handles
  (tag input, normalised on save), default handle (select from the allowed list — no empty-string
  item values), **Test** (shows `serverInfo` incl. Private API status + sends "Test from MyMind"),
  webhook URL with token + copy + regenerate. Registering the webhook in BlueBubbles is a manual
  step shown with instructions (events: new message, updated message).
- **Email**: enable switch, to-address, **Test**.
- **Presence**: away-after minutes.
- A **Channels status** dot on the Settings nav: green (healthy), amber (Private API off), red
  (last health check failed).

## 8. Failure handling
| Failure | Behaviour |
|---|---|
| BlueBubbles unreachable | Deliveries back off then fail with a main note; inbound gaps closed by catch-up; status dot red. |
| Private API off | Sends use the AppleScript method → `sent_unconfirmed`, confirmed by catch-up; no typing/read/tapback; approvals deny with an explanation; status dot amber. |
| Attachment download / STT fails | Text still goes through with a note. |
| Inbound while main is busy | Existing queue/steer path (§4.4). |
| Crash mid-send | `sending` rows reclaimed after 2 min; `findByTempGuid` prevents a double send. |
| Channel disabled after a job pinned it | Save-time validation already rejected unknown/unconfigured channels; at delivery time a disabled channel is skipped with one note on main. |
| Resend fails | Same retry/backoff; then `failed` + note. |

## 9. Jobs integration (cycle-74 code)
- `deliver` validated at save: values in `app | auto | imessage | email`; a channel that is not
  configured+enabled is a validation error.
- Default changes from `[app]` to `[auto]`.
- Seeds (still installed **disabled**; existing seed rows are only updated if their content hash
  still equals the original seed's): morning-brief `[auto, imessage]`, evening-wrap `[auto]`,
  heartbeat `[auto]`, session-digest `[app]`.
- `onRunFinished` (or the runner's finish transaction) creates the delivery rows; the job's run
  outcome is unaffected by delivery success.

## 10. Security
- Webhook token: 32 random bytes, constant-time compare, 404 on failure; rotation in the UI.
- Only allowlisted **direct** chats; group chats ignored; unknown senders logged masked, never
  reach the agent.
- Approval tapbacks accepted only from allowed handles on the exact prompt message.
- `send_message` can only reach Tony's configured handle/email (prompt-injection can't make her
  text a third party).
- The BlueBubbles password and webhook token never reach the client.

## 11. Testing
- **Unit**: handle normalisation; webhook parsing against real BlueBubbles payload fixtures
  (message, photo, voice memo, tapback, group, from-me); `deliver` resolution incl. away logic;
  backoff schedule; email rendering (markdown → HTML, raw HTML stripped).
- **DB** (scoped per `db-safety.md`): outbox claim/retry/reclaim; inbound GUID dedupe; catch-up
  overlap; approval resolve/expire; `reply_to` → delivery row in the same transaction; job
  `deliver` → rows; `send_message` rate limit.
- **Fake BlueBubbles server** (`test/fixtures/fake-bluebubbles.ts`, a small HTTP mock) used by
  integration tests and optionally by dev (`BLUEBUBBLES_FAKE=1`) — no real texts during the build.
- **Acceptance** (`playwright-cli` + Tony's phone, against dev with dev's own webhook token
  registered in BlueBubbles for the session):
  1. Tony texts Bridget → reply on his phone and in `/agent` main (📱 marker, delivered badge).
  2. A photo → she describes it.
  3. A voice memo → she answers its content.
  4. An exec approval → 👍 tapback → it runs.
  5. Run now on the morning brief while "away" → it reaches his phone.
  6. An `email` job → arrives by email with `Bridget · <slug>` subject.
  7. BlueBubbles stopped → delivery retries, then lands once it's back (can run on the fake).
  Scenarios 1–5 need Tony; the controller schedules them together at the end.

## 12. Risks
- **Private API fragility** (macOS updates can break it): the AppleScript fallback + status dot
  keep the channel usable in degraded mode.
- **Webhook reachability**: prod (LXC 114) must reach BlueBubbles on the LAN and BlueBubbles must
  reach prod's webhook URL (LAN IP or `brain.costanzoclan.com`). The handover documents both.
- **Duplicate texts** on crash/retry: mitigated by `tempGuid` + `findByTempGuid`.
- **Presence misjudgment** (e.g. a forgotten open tab): pings are activity-based, not
  connection-based, so an idle tab doesn't count.

## 13. Out of scope
- Voice replies (TTS → iMessage audio), group chats, Telegram/Discord/Slack, inbound email,
  editing/unsending sent messages, per-channel threads, multi-user.
