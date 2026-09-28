---
title: Channels (iMessage via BlueBubbles, email via Resend, presence-aware delivery)
status: built
cycle: 75
updated: 2026-09-28
---

# Channels

Since cycle 75 Bridget is reachable outside the web app. Tony can text her over **iMessage**
(through his BlueBubbles server) and she texts back. Her job results and `send_message` notes can
go out by iMessage or **email** (Resend). Whether a job's result also reaches his phone depends on
**presence**: when he is active in the app, it stays in the app.

Spec: [`2026-09-28-bridget-channels-design.md`](../superpowers/specs/2026-09-28-bridget-channels-design.md) ·
Handover: [`2026-09-28-bridget-channels.md`](../handovers/2026-09-28-bridget-channels.md) ·
Related: [agent-runtime.md](agent-runtime.md) (runs, `reply_to`, approvals),
[agent-jobs.md](agent-jobs.md) (the `deliver` key), [activity-log.md](activity-log.md) (the
Resend key and sender).

Where this page and the spec disagree, this page describes the code. The handover lists the
build's deviations.

**Status ladder:** planned → in-progress → **built** (not merged, not deployed; migrations 0057 and
0058 are on the shared dev DB only) → shipped.

## Architecture

```
iPhone ──iMessage──▶ Mac (BlueBubbles, Private API)
                         │  webhook: POST /api/channels/bluebubbles/webhook?token=…
                         │  catch-up: POST /api/v1/message/query every 2 min (5-min overlap)
                         ▼
               handleInbound (server/lib/channels/inbound.ts)
                 tapback → approvals · filters · photo/voice memo → input
                 channel_inbound PK insert (dedupe) → enqueue on MAIN with origin + reply_to
                         ▼
               runTurn (runtime) ── persist reply + channel_deliveries rows in ONE transaction
                         ▼
               deliveriesTick (worker, every 5 s) ── claim → Channel.send → sent | retry | failed
                         │                                   │
                  imessageChannel (BlueBubbles REST)   emailChannel (Resend REST)
```

Both the outbox tick and the catch-up ride the runtime's existing 5-second `workerTick`
(`server/lib/agent/runtime/queue.ts`). There is no separate scheduler.

| File (`server/lib/channels/`) | Role |
|---|---|
| `types.ts` | The `Channel` interface (`id`, `isEnabled()`, `send(delivery)`), `SendResult`, the inbound event shapes. |
| `registry.ts` | `channelFor('imessage' \| 'email')`. |
| `config.ts` | The three settings keys, tolerant parsing, the DTO (password and token redacted), `verifyWebhookToken` (constant time), `rotateWebhookToken`, `resendReady`. |
| `handles.ts` | `normaliseHandle` (E.164 with a US default, or a lower-cased email), `isAllowed`, `isSendersDirectChat` (the chat-to-sender match), `maskHandle` for logs. |
| `presence.ts` | `markActive` / `isAway` (Tony's presence in the app), and `channelPresence` (read receipt + typing in the reply chat while a run works). |
| `bluebubbles/client.ts` | The BlueBubbles REST client (15 s timeout, Private-API detection, `imessageClient()`). |
| `bluebubbles/parse.ts` | Webhook and `message/query` payloads → `InboundMessage` / `TapbackEvent`. Never throws. |
| `bluebubbles/channel.ts` | The outbound iMessage adapter, including the duplicate check. |
| `email/render.ts`, `email/channel.ts` | Markdown → sanitised HTML + plain text (app-relative links and images made absolute links); the Resend adapter. |
| `plain-text.ts` | `markdownToPlainText`: iMessage text is stored and sent without markdown. |
| `inbound.ts` | `handleInbound`, `catchUpTick` (health, catch-up, unconfirmed confirmation, approval expiry), `catchUpWindowStart`, `lastHealth` / `resetHealth`. |
| `outbox.ts`, `backoff.ts` | `insertDeliveries` (in the caller's transaction), `deliveriesTick`, the retry schedule. |
| `deliver.ts` | `resolveDeliverChannels` (pure), `planDeliveries` (what a finished reply sends) and `queueFailureNote` (the "sorry" text for a failed iMessage turn). |
| `approvals.ts` | Exec approvals by tapback. |

The agent tool `send_message` lives in `server/lib/agent/tools/channels.ts`.

## Settings

Three `settings` keys, owned by `config.ts`. The UI is **Settings → Channels**
(`/settings/channels`, `app/components/settings/ChannelsTab.vue`).

| Key | Shape | Notes |
|---|---|---|
| `channel_imessage` | `{ enabled, serverUrl, passwordEnc, webhookToken, allowedHandles[], defaultHandle, defaultChatGuid }` | The password is encrypted (`encryptSecret`, the AI-registry key) and never returned. The token is 32 random bytes, hex. |
| `channel_email` | `{ enabled, to }` | The Resend **API key and sender** are not here; they come from **Settings → Activity & Alerts** (`observability_config.alerts.email.apiKeyEnc` / `from`). The Settings UI only lets email be switched on when both are set (`resendReady`); the server does not enforce it, and with Resend unconfigured each email delivery fails non-retryably ("Resend is not configured"), which posts the usual failure note to main. |
| `presence_away_minutes` | integer 1–240, default 10 | How long without app activity before Tony counts as away. |

- A malformed stored field falls back to its default with one `console.warn`; it never 500s the
  settings routes, the webhook or routing.
- A cold config load **writes**: the first load generates and stores the webhook token. The config
  is cached in memory and invalidated on every save.
- `defaultHandle` must be one of `allowedHandles` (400 otherwise). `defaultChatGuid` is
  server-owned: it is cleared when the default handle changes, and until it is set proactive
  messages go to the direct chat `iMessage;-;<handle>`.
- A job cannot be **enabled** (created, saved or switched on) with `deliver` naming `imessage` or
  `email` while that channel is disabled. That check runs on writes only. A channel switched off
  later does not invalidate the job; delivery skips it with an activity `warn`
  (`channels:deliver-skipped`).

### Routes

All session-only (`requireSession`; an API token gets 403), except the webhook.

| Route | Purpose |
|---|---|
| `GET /api/settings/channels` | The DTO: iMessage without password or raw token (`hasPassword`, `webhookUrlPath`), email with `resendReady`, presence. `webhookUrlPath` is the **only** place the token appears in any response (controller ruling), because Tony must paste it into BlueBubbles. |
| `PUT /api/settings/channels` | Save. The password field is `{password}` (set), `{keep: true}` or `null` (clear). A PUT never writes the token, so a concurrent regenerate is not undone. `serverUrl` must be http/https. A save that enables iMessage or changes its server URL or password forgets the last health check (`resetHealth`), so the status dot goes neutral until the next check. |
| `POST /api/settings/channels/regenerate-token` | Rotate the token; the old one stops verifying at once. |
| `POST /api/settings/channels/test-imessage` | "Test connection" (forces a catch-up health check) or "Send test message" (queues a note to the default handle). |
| `POST /api/settings/channels/test-email` | Queues `Bridget · test` to `email.to`. |
| `GET /api/channels/status` | The nav status dot: last iMessage health (`ok`, `privateApi`, `checkedAt`, `error`) and email readiness. It never calls BlueBubbles itself. |
| `POST /api/presence` | Tony is active (`markActive`). Session only, so an API-token ping cannot mark him present. |
| `GET /api/conversations/:id/deliveries` | Per-message delivery badges for `/agent`. 400 on a malformed id. |
| `POST /api/channels/bluebubbles/webhook?token=…` | BlueBubbles' webhook. Exempt from session auth (`server/middleware/auth.ts`). A wrong or missing token, iMessage disabled, or the token check itself failing (a DB blip) gives **404**, never a 500 that would confirm the endpoint exists. After that check it always answers 200, even when handling fails, so BlueBubbles never retries into a loop; the catch-up picks up anything lost. |

## BlueBubbles setup (webhook registration)

1. In MyMind: **Settings → Channels → iMessage**. Enable it, enter the BlueBubbles **Server URL**
   (`http://<mac-lan-ip>:1234` or its public URL) and **Password**, add Tony's number or Apple ID
   to **Allowed handles** (press Enter to add each), pick the **Default handle**, and Save.
2. Click **Test connection**. A green **Private API on** badge means typing indicators, read
   receipts, tapbacks and exec approvals all work. An amber badge (Private API off) means sends
   fall back to AppleScript: texts still go out, but there are no typing indicators or tapbacks,
   and exec approvals are denied at once.
3. Copy the **Webhook URL** (the copy button). It is the app's origin plus
   `/api/channels/bluebubbles/webhook?token=<64 hex>`.
4. In the BlueBubbles server app on the Mac: **Settings → API & Webhooks → Add webhook**, paste the
   URL, and tick the events **New Messages** and **Message Updates**. Message Updates carries the
   tapbacks.
5. Text Bridget from an allowed handle. The reply comes back in the same chat and shows up on
   `/agent` main.

**Network reachability runs both ways.** MyMind must reach BlueBubbles for sends, the catch-up and
attachment downloads, and BlueBubbles must reach MyMind's webhook. For prod, the webhook URL can be
the LAN URL `http://192.168.2.89:3000/api/channels/bluebubbles/webhook?token=…` (LXC 114) or the
public `https://brain.costanzoclan.com/api/channels/bluebubbles/webhook?token=…`. If the webhook
cannot get through, the 2-minute catch-up still delivers every message, just late.

Regenerating the token breaks the registered webhook until the new URL is pasted into BlueBubbles.
The catch-up covers the gap.

**One BlueBubbles server ↔ one MyMind.** The catch-up polls BlueBubbles whether or not the webhook
is registered, so two MyMind instances (dev and prod) enabled against the **same** BlueBubbles
server both answer every text. Keep iMessage enabled on only one of them at a time: switch dev off
before enabling prod, and run real-phone checks on dev only while prod's iMessage is disabled.

## BlueBubbles payload fields relied on

Webhook body: `{ type, data }`. Only `new-message` and **tapback-carrying** `updated-message`
events produce anything. A plain `updated-message` (a read receipt, for example) is ignored.

| Field | Used as |
|---|---|
| `data.guid` | Message identity. It is the `channel_inbound` primary key, so a message runs at most once. |
| `data.text` | The message text. |
| `data.isFromMe` | Bridget's own messages are ignored. |
| `data.dateCreated` (ms) | `received_at`, the catch-up cursor, and matching own messages. |
| `data.handle.address` | The sender, normalised and checked against the allowlist. |
| `data.chats[0].guid` | The reply chat (`iMessage;-;+1555…`). A GUID containing `;+;` is a group. It must be the **sender's own direct chat**: `<service>;-;<handle>` (any service prefix) whose handle normalises to `data.handle.address`, or the message is dropped (`ignored:chat-mismatch`). |
| `data.chats[0].style` | `43` = group, which is ignored. |
| `data.attachments[].guid / mimeType / transferName` | Photos (`image/*`), voice memos (`audio/*`), anything else becomes a one-line note. |
| `data.associatedMessageGuid` | The tapback target. The `p:<n>/` and `bp:` prefixes are stripped. |
| `data.associatedMessageType` | `love like dislike laugh emphasize question`, a leading `-` for removal, or codes 2000–2005 (add) / 3000–3005 (remove). Anything else with an associated GUID (iOS 18 emoji reactions, stickers) is **dropped**, never a turn. |

REST routes the client calls (all `?password=`, chat GUIDs URL-encoded): `GET /api/v1/server/info`,
`POST /api/v1/message/text` (`chatGuid`, `tempGuid`, `message`, `method` =
`private-api` | `apple-script`), `POST /api/v1/message/attachment` (multipart),
`POST /api/v1/message/react`, `POST|DELETE /api/v1/chat/:guid/typing`,
`POST /api/v1/chat/:guid/read`, `GET /api/v1/chat/:guid/message` (the duplicate check;
`after`, `sort=DESC`, `limit`), `POST /api/v1/message/query` (the catch-up; `after`, `sort=ASC`),
`GET /api/v1/attachment/:guid` and `GET /api/v1/attachment/:guid/download?original=false`
(BlueBubbles converts HEIC to JPEG).

5xx, 408, 429, network errors and timeouts are retryable; any other 4xx is not. With the
**Private API off**, an AppleScript send that times out is reported as `sent_unconfirmed`, because
it probably went out.

## Inbound pipeline

`handleInbound` runs these steps in order, for the webhook and the catch-up alike:

1. A tapback goes to `resolveTapback` (approvals) and is never a turn.
2. A message with an association that is not a tapback: `ignored:reaction`.
3. From Bridget herself: `ignored:from-me`. A group chat: `ignored:group`.
4. **The chat must be the sender's own direct chat** (final review I2): `<service>;-;<handle>`,
   any service prefix, with the handle normalising to the sender. Otherwise
   `ignored:chat-mismatch`, with a `console.warn` and an activity `warn`
   `imessage:chat-mismatch` (handle masked); nothing is recorded or enqueued. The allowlist checks
   the sender while the reply goes to the chat, so without this a forged webhook payload (anyone
   holding the token) could ask as Tony and have the answer texted to another number.
5. A sender not on the allowlist: `ignored:sender`. Its GUID is recorded (so the overlap does not
   warn twice) and one activity `warn` `imessage:unknown-sender` is logged with the handle masked.
6. No text and no attachments: `ignored:empty`.
7. Already seen: `duplicate`. This is a cheap early exit so the overlap doesn't re-download.
8. Build the input:
   - **Photos:** at most 4, downloaded with conversion. If the result is still HEIC or larger than
     20 MB, the input gets `(couldn't load the photo)`. Photos past the fourth are skipped with
     one `(more than 4 photos, the rest were skipped)` line. Stored via `createImage`, so they become
     webp gallery images.
   - **Voice memos:** sent to the `stt` chain with the real MIME and filename (a `.caf` is
     `audio/x-caf`, never WAV) and added as `(voice memo) <text>`. A failure gives
     `(a voice memo I couldn't transcribe)`. The rest of the message still goes through.
   - **Other files:** `(an attachment I can't open: <name>)`.
9. **The dedupe insert decides:** `insert into channel_inbound … on conflict do nothing
   returning`. Exactly one caller gets a row. The loser discards the images it built and returns
   `duplicate`.
10. Enqueue on **main** with `trigger: 'user'`, `profile: 'interactive'`,
    `input.origin = 'imessage:<chatGuid>'`, `replyTo = { channel: 'imessage', chatGuid,
    messageGuid }` and **`noSteer: true`**. **An inbound text never steers** (final review C1
    ruling): it is always its own run carrying `reply_to` and `origin`, queued behind whatever is
    running on main (interactive or headless). So every text gets its own phone reply, and an app
    turn never inherits a `reply_to`. The cost: a text sent mid-turn waits for that turn to finish
    instead of being merged into it. If the enqueue throws, the dedupe row is deleted again so the
    next catch-up retries the message.

**Catch-up** (`catchUpTick`, self-throttled to every **2 min**): expire overdue approvals, then
run `serverInfo` as the health check (this also refreshes the client's Private-API mode), then read
every message since `max(channel_inbound.received_at)` minus a **5-min overlap**
(`catchUpWindowStart`). **Bounds (final review M1):** on a fresh install (no inbound rows yet) the
cursor is `now − 5 min`, so a new instance does not replay texts another MyMind already answered;
and the scan **never reaches back more than 24 h**, so re-enabling iMessage after a long gap or an
outage does not turn every old text into a turn and a reply (older messages are simply not read).
Pages are 100 messages, up to 10 pages. It then confirms `sent_unconfirmed`
deliveries. One bad message never stops the scan, and the in-memory high-water mark never passes a
message that failed.

**While a run answers an iMessage**, the runner marks the chat read and shows typing, then turns
typing off when the run ends. Both are skipped when the last health check said the Private API is
off, and a failure never reaches the run.

**UI:** a user message whose `origin` starts with `imessage:` gets a 📱 marker in `/agent`.
Since inbound texts never steer, every one is its own user row with the marker.

## Outbound: deliveries

A finished, non-empty, non-suppressed reply is planned by `planDeliveries` inside the runner's
append transaction, in a savepoint. The reply row and its delivery rows commit together or not at
all. A planning *read* failure rolls back to the savepoint, so the reply still saves without
deliveries. A rescued turn (the crash rescue path) never delivers its partial reply.

- **`reply_to`** (read from the `agent_runs` row; only an inbound iMessage sets it, when it creates
  the run): one iMessage to that chat, when iMessage is enabled.
- **A failed turn with `reply_to`** (final review I3): when the run ends `failed` (the model chain
  exhausted, or the turn threw) — not `aborted` — the runner queues one `source: 'note'` iMessage,
  **"Sorry — something went wrong answering that."**, so the phone isn't left with a typing bubble
  and then silence. It goes through the outbox like any reply (no `message_id`). Nothing for an app
  run, an aborted run, or with iMessage disabled.
- **A job run:** its `deliver` list goes through `resolveDeliverChannels`:
  - `app`: nothing outbound.
  - `auto`: iMessage, only while Tony is **away** (never email).
  - `imessage` / `email`: always.
  - A disabled channel is dropped. iMessage goes to `defaultChatGuid`, else the direct chat of
    `defaultHandle`. Email goes to `email.to` with subject **`Bridget · <job slug>`**.
- **Both at once:** the iMessage row is de-duplicated by target, and the reply wins.
- **Images** linked as `/api/images/<uuid>/raw` ride along on iMessage: the embed is stripped from
  the text and `insertDeliveries` splits the payload into one text row plus **one row per image**,
  each retried on its own. Email keeps images as links: an app-relative image
  (`/api/images/<id>/raw`) becomes a link to its absolute URL on the app origin
  (`BETTER_AUTH_URL`), since the image route needs a session an email client lacks; app-relative
  links are made absolute the same way. External images stay inline.
- **iMessage text is plain text** (final review M7): `insertDeliveries` runs every iMessage row's
  text through `markdownToPlainText` — headings, bold/italic/strikethrough markers, backticks and
  code fences, blockquote markers and rules are stripped, links become `text (url)`, list markers
  and tables stay. Stored that way, so the send, the duplicate check and the unconfirmed-send check
  all compare the same string. Email keeps the markdown (rendered to HTML).
- **`send_message`** (agent tool, allowed in headless runs): `channel` is `imessage | email`, and
  there is **no address parameter**; the target is always the configured default. The limit is
  **20 per hour per channel** (rows with `source = 'tool'`). It appends a `channel:sent` event to
  main. It never throws.

### `channel_deliveries` states and backoff

```
pending ──claim──▶ sending ──▶ sent | sent_unconfirmed | pending (retry) | failed
```

| Column | Meaning |
|---|---|
| `channel`, `target` | `imessage` + chat GUID, or `email` + address. |
| `source` | `reply` · `job` · `tool` · `note` (test messages and failure notes). A failed `note` never posts another failure note. |
| `payload` | `{ text, subject?, images? }`. |
| `attempts` | **Sends made** (ruling 2). |
| `next_attempt_at`, `claimed_at`, `first_claimed_at` | Scheduling. `first_claimed_at` bounds the duplicate check. |
| `last_error`, `external_id`, `sent_at` | Outcome. |
| `conversation_id`, `message_id`, `job_id`, `run_id` | Links for badges and ops (`message_id` is indexed). |

- **Claim:** up to 10 due rows (`pending` with `next_attempt_at <= now()`, or `sending` whose
  claim is older than **2 min**, which means a process died mid-send), under
  `FOR UPDATE SKIP LOCKED`. A reclaim counts the interrupted attempt as a send, so the duplicate
  check runs. A reclaimed row whose sends are used up goes straight to `failed`.
- **Backoff:** after the n-th failed send, the row goes to `failed` if `n >= 6`, else waits
  `BACKOFF_MS[n-1]` from **30 s, 2 m, 10 m, 1 h, 1 h, 1 h**. That makes 6 sends total. A
  non-retryable error goes straight to `failed`.
- Every result write is **fenced on the row's own claim** (`status = 'sending' and claimed_at =
  <mine>`), so a slow send that another tick reclaimed cannot overwrite it.
- **`failed`:** the outbox appends an event row to main, "Couldn't deliver to iMessage: <error>"
  (origin `channel:delivery-failed`).
- **`sent_unconfirmed`:** the catch-up confirms it by finding Bridget's own message with that text
  in the chat, and marks it `sent`. An image-only row cannot be matched by text, so it counts as
  sent after **10 min**. Anything unconfirmed after **24 h** becomes `failed` (no note).

### The duplicate check

A retry must never double-text Tony. Before any retry (`attempts > 0`) of a row that has text, the
iMessage adapter calls `findOwnMessage(chat, text, first_claimed_at - 5 s)`. If Bridget's own
message with that exact text is already in the chat, the earlier attempt went out, and the row is
marked `sent` without sending. If the check itself fails, the result is a retryable error and
**nothing is sent**. A **404** is the exception: it means "not found" (for example, a server without
that route), and the send goes ahead. Image-only rows skip the check, because a rare duplicate
photo is better than a lost one.

The spec's `findByTempGuid` isn't implementable: BlueBubbles does not persist `tempGuid` to
chat.db. The delivery id is still passed as `tempGuid`.

## Exec approvals over iMessage

An interactive run with no socket approval channel gets `replyToApprovalChannel(runId, { signal })`.
At request time it reads the run's `reply_to`. If that names an iMessage chat, it texts:

> Run \`<command>\`?
> 👍 to approve · 👎 to deny

The command is cut to **300 characters** (ending `…`), so a long heredoc is not texted in full.

A row goes into `channel_approvals` (`pending`, `expires_at = now + 10 min`, `prompt_guid` = the
sent message's GUID). A **👍 or ❤️** tapback from an allowed handle, on **that** message, in
**that** chat, approves. **👎** denies. **10 min** of silence expires the request, which counts as a
denial. Every transition is a conditional update on `status = 'pending'`, so a tapback racing the
expiry ends with exactly one outcome. The waiter learns the outcome from the in-process map or a
5-second DB poll, which survives a tapback handled by another process. The catch-up expires rows
whose waiter died with a restart.

**Stop and `/clear` unwind the wait** (final review I1): the runner passes the run's abort signal.
An abort while waiting settles the row `pending → denied` and denies at once (logged with reason
`aborted`); an abort before the prompt is sent denies without texting or writing a row. A 👍 after
that changes nothing. Without this the run stayed `running` for up to the 10-minute expiry,
blocking main.

The tapback must also come from the chat that is the tapper's own direct chat (the same I2 match
as inbound messages).

The run is denied at once, and the reason is logged, when iMessage is not configured
(`imessage-not-configured`), the Private API is known to be off (`private-api-off`), or the prompt
fails to send (`prompt-send-failed`). Every outcome is logged as the activity event `exec:approval`
(`channel: 'imessage'`). Allowlisted exec commands never prompt, exactly as in the app.

## Presence

`app/plugins/presence.client.ts` posts `POST /api/presence` on keydown, pointerdown, window focus
or the tab becoming visible. It posts at most once a minute, and only while signed in. The server
keeps the last ping **in memory**. Tony is away when there has been no ping for
`presence_away_minutes`. After a restart he counts as away until his first ping, which costs at
most one extra text. Pings count activity, not open connections, so an idle open tab does not keep
him "present".

## Status dot

The **Settings → Channels** nav entry (and its collapsed Settings parent) shows a dot from
`GET /api/channels/status` (`app/lib/channels/status-dot.ts`):

| Dot | Meaning |
|---|---|
| none | iMessage disabled. |
| neutral (grey) | Enabled but not checked yet (`checkedAt` null): after boot, or after a save that enabled iMessage or changed its server or password. The next catch-up tick (≤ 2 min) or **Test connection** resolves it. Not repeated on the Settings parent. |
| green | The last health check passed with the Private API on. |
| amber | It passed with the Private API **off**: AppleScript sends only, with no typing, tapbacks or approvals. |
| red | The last health check failed (BlueBubbles unreachable, bad password…). |

Delivery **badges** under assistant bubbles in `/agent`: `sent` (green), `sent (unconfirmed)`,
`sending`, `failed` (red). There is one per channel, showing the least-finished row, so a reply
split into text and image rows shows its worst state.

## Operational SQL

```sql
-- Stuck or failing deliveries
select id, channel, status, attempts, next_attempt_at, claimed_at, left(last_error, 120) err
from channel_deliveries
where status in ('pending','sending','sent_unconfirmed','failed')
order by created_at desc limit 50;

-- A delivery stuck in 'sending' longer than 2 min is reclaimed automatically on the next tick.
-- To retry a failed row by hand (it will run the duplicate check first):
update channel_deliveries set status = 'pending', next_attempt_at = now(), last_error = null
where id = '<id>' and status = 'failed';

-- Recent inbound iMessages and the runs they started
select i.guid, i.sender, i.received_at, i.run_id, r.status
from channel_inbound i left join agent_runs r on r.id = i.run_id
where i.channel = 'imessage' order by i.received_at desc limit 20;

-- Pending / recent approvals
select id, status, request->>'command' cmd, prompt_guid, expires_at, resolved_at
from channel_approvals order by created_at desc limit 20;

-- Channel activity (unknown senders, chat mismatches, skipped deliveries, approvals)
select created_at, name, status, meta from activity_log
where name in ('imessage:unknown-sender', 'imessage:chat-mismatch', 'channels:deliver-skipped', 'exec:approval')
order by created_at desc limit 50;
```

The status dot and `GET /api/channels/status` show BlueBubbles health. Server-side failures are
logged with the `[channels]` prefix (`journalctl -u mymind | grep '\[channels\]'` on prod).

## The fake BlueBubbles server (dev and tests)

`test/fixtures/fake-bluebubbles.ts` is an in-process HTTP fake of exactly the routes above. It
records every call and enforces `?password=fake`. Every automated test and dev check uses it, so no
real text is sent during development.

```bash
pnpm fake:bluebubbles --private-api           # listens on http://127.0.0.1:4455 (omit the flag for Private API off)
BLUEBUBBLES_FAKE_URL=http://127.0.0.1:4455 RESEND_FAKE=1 pnpm dev
```

- **`BLUEBUBBLES_FAKE_URL`** overrides the configured server entirely: the client points at the
  fake with password `fake`. Under vitest without it, `imessageClient()` is always `null`, so no
  test can reach a real server whose config sits on the shared dev DB.
- **`RESEND_FAKE=1`** makes `sendResendEmail` log `[resend-fake] would send …` and resolve instead
  of calling Resend. The guard is `process.env.RESEND_FAKE === '1' && import.meta.dev`, so it is
  inert in any production build.
- To simulate an inbound text, POST a BlueBubbles-shaped body (see `test/fixtures/bluebubbles/*.json`)
  to the webhook URL shown in Settings → Channels. The fake serves every attachment download as a
  1×1 PNG: a photo works, and a voice memo exercises the transcription-failure path.
- To simulate an outage, stop the fake. Deliveries retry on the backoff schedule, and they land
  once it is back.
- Programmatic options (tests): `failSends`, `sendHangs`, `heicAttachments`, `attachmentTypes`,
  `setPrivateApi()`, `setDown()`, `pushMessage()`.

## Data model (migrations 0057 + 0058, additive)

- `channel_deliveries`: see above. Indexes `(status, next_attempt_at)`, `(message_id)` and
  `(conversation_id)` — the last added by **migration 0058** (the per-thread deliveries read that
  every open `/agent` tab re-runs on each delivery event).
  `job_id` → `agent_jobs` on delete set null, `run_id` → `agent_runs` on delete set null.
- `channel_inbound`: `guid` pk, `channel`, `sender`, `received_at`, `run_id`, `created_at`.
  Index `(channel, received_at)`. Rows are never pruned.
- `channel_approvals`: `id`, `run_id` → `agent_runs` on delete cascade, `request` jsonb,
  `chat_guid`, `prompt_guid` (indexed), `status` (`pending | approved | denied | expired`),
  `expires_at`, `resolved_at`, `created_at`.
- `agent_runs.reply_to` jsonb: `{ channel: 'imessage', chatGuid, messageGuid }`.

**Rollback:** the tables are additive and nothing else reads them. To roll the code back, leave
the tables, or drop them along with `agent_runs.reply_to` once no deployed code uses them.

## Known limits

- Direct chats only; group chats are ignored. Tony is the only reachable person: `send_message`
  has no address parameter.
- There is no inbound email, and no voice replies over iMessage.
- Presence lives in memory per process and is lost on restart.
- A text sent while a turn is running on main waits for that turn to finish (inbound never steers).
- Catch-up reads at most the last 24 h; texts older than that (a long outage) are never answered.
- One BlueBubbles server serves one MyMind: dev and prod both enabled would both answer.
- `channel_inbound` is never pruned. Unknown senders' raw handles are stored unmasked there.
- See the handover's follow-ups for the parked review minors and the real-phone checks still owed.
