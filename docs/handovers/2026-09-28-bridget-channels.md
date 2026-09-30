---
title: Bridget channels — two-way iMessage via BlueBubbles, outbound email via Resend, presence-aware delivery
cycle: 75
date: 2026-09-28
status: shipped
branch: feat/bridget-channels (worktree .claude/worktrees/bridget-channels, base dea0d69)
merged: true
deployed: 2026-09-29 (CD run 36506477530, commit b71f342; follow-up CD 36511966371, bb8e5b9, the prompt timezone fix)
specs:
  - ../superpowers/specs/2026-09-28-bridget-channels-design.md
plans:
  - ../superpowers/plans/2026-09-28-bridget-channels.md
wiki:
  - ../wiki/channels.md
  - ../wiki/agent-jobs.md
  - ../wiki/agent-runtime.md
migrations:
  - 0057 channel_deliveries, channel_inbound, channel_approvals; agent_runs.reply_to (jsonb)
  - 0058 index channel_deliveries(conversation_id) (final review fix wave)
migrations_run_on_prod: true  # 0056 + 0057 + 0058 applied by CD on 2026-09-29; prod is at 0058
seed_jobs_enabled: false  # the four seeds were upgraded (deliver lines) by the hash-guarded boot upgrade and stay DISABLED
fake_acceptance: passed  # spec §11 scenarios 1-7 + email, against the fake BlueBubbles server and RESEND_FAKE
real_phone_acceptance: pending  # spec §11 scenarios 1-5 with Tony's phone; checklist below
final_review: with-fixes-applied  # whole-branch review (1 C / 4 I / 9 M) → fix wave done on this branch; see "Final review fix wave" below
prod_agent_timezone: America/Chicago
mymind_task: 8e66ffd0-a94f-4017-a9a1-99deea55c7bb
---

# Cycle 75: Bridget channels

Cycle 74 let Bridget talk on her own, but only inside the app. Cycle 75 takes her outside it.
Tony can **text her over iMessage** through his BlueBubbles server (Private API). The text lands
on the main thread and her reply goes back to his phone. Photos are described, and voice memos are
transcribed. Exec approvals work with a 👍 tapback. Job results and her new `send_message` tool can
go out by **iMessage or email** (Resend). Whether a job texts him depends on **presence**: when he
is active in the app, it stays in the app. All outbound traffic goes through a DB outbox with
retries and a duplicate check, so a retry never double-texts him.

**Status:** built on `feat/bridget-channels`. All gates are green, and the fake-server acceptance
(spec §11 scenarios 1–7, plus email) passes. **Not merged, not deployed.** Migrations 0057 and 0058
are on the shared dev DB only. The real-phone acceptance (scenarios 1–5) is still owed and needs
Tony; the checklist is [below](#real-phone-acceptance-checklist-for-the-controller-with-tony). The
controller's final whole-branch review ran ("with fixes") and its fix wave is done — see
[Final review fix wave](#final-review-fix-wave). The headline behaviour change: **an inbound
iMessage never steers into a running turn**; it always gets its own run and its own phone reply.

How it works today: [`docs/wiki/channels.md`](../wiki/channels.md), plus the updated
[`agent-jobs.md`](../wiki/agent-jobs.md) (`deliver`) and
[`agent-runtime.md`](../wiki/agent-runtime.md) (`reply_to`, iMessage approvals, deliveries in
the persist transaction).

## What shipped

- **Migration 0057** (additive, the only migration this cycle):
  - `channel_deliveries`, the outbox, with `source` and `first_claimed_at`;
  - `channel_inbound`, keyed by message GUID, which does the dedupe;
  - `channel_approvals`, with `chat_guid` and `prompt_guid`;
  - `agent_runs.reply_to`.
- **`server/lib/channels/`:**
  - `config`: three settings keys; the password is encrypted, and the token appears only in the
    session-authed GET;
  - `handles`: normalisation and the allowlist;
  - `presence`: app presence, plus read receipt and typing in the reply chat;
  - `bluebubbles/client`, `parse`, `channel`;
  - `email/render`, `channel`: markdown → DOMPurify-sanitised HTML + text;
  - `inbound`: the pipeline, plus the 2-min catch-up, the health check and unconfirmed confirmation;
  - `outbox` + `backoff`;
  - `deliver`: `resolveDeliverChannels`, `planDeliveries`;
  - `approvals`: tapback approvals.
- **Runtime integration:**
  - `enqueue`/`createRun` carry `replyTo`; inbound iMessage enqueues with `noSteer: true`, so it
    is always its own run (final review C1 — the build first steered it and set `reply_to` on the
    joined run);
  - the runner plans deliveries inside the append transaction (in a savepoint), starts and stops
    chat presence, and registers a `reply_to` approval channel for interactive runs without a
    socket channel;
  - `workerTick` runs `deliveriesTick` and `catchUpTick`.
- **Jobs:**
  - `deliver` accepts `app | auto | imessage | email` and defaults to `[auto]`;
  - an enabled job may name a channel only while that channel is enabled (checked on write);
  - the seeds gained `deliver:` lines;
  - `upgradeSeedJobs` moves unedited cycle-74 seeds forward on boot;
  - the job panel shows **Delivers to**, and the templates carry `deliver:`.
- **Agent tool `send_message`** (`imessage | email`, no address parameter, 20/hour/channel,
  allowed headless).
- **HTTP:**
  - `POST /api/channels/bluebubbles/webhook?token=` (public, 404 on a bad token);
  - `GET|PUT /api/settings/channels`, `regenerate-token`, `test-imessage`, `test-email`;
  - `GET /api/channels/status`, `POST /api/presence`, `GET /api/conversations/:id/deliveries`.
  - All are session-only except the webhook.
- **UI:**
  - **Settings → Channels** (`ChannelsTab.vue`) with the copyable webhook URL and a Private API
    badge;
  - the nav status dot (green, amber or red);
  - the 📱 marker on iMessage-origin user messages in `/agent`;
  - delivery badges under replies;
  - `presence.client.ts` pings.
- **Dev/test:**
  - `test/fixtures/fake-bluebubbles.ts` (`pnpm fake:bluebubbles`, `BLUEBUBBLES_FAKE_URL`) and
    real-shaped payload fixtures;
  - **`RESEND_FAKE=1`** (this task): a dev-only Resend stub, guarded by
    `process.env.RESEND_FAKE === '1' && import.meta.dev`, with a unit test proving it is inert
    outside dev.

## Gates

| Gate | Cycle-74 final (on master) | After Task 1 (d063979) | Build end (2aae9e1 + docs) | After the final fix wave |
|---|---|---|---|---|
| `pnpm test` | 261 files · 2497 pass · 1 skip | 261 files · 2498 pass · 1 skip | 277 files · 2716 pass · 1 skip | **279 files · 2735 pass · 1 skip** |
| `pnpm test:db` (whole suite) | 54 files · 483 pass | — | 64 files · 599 pass | **64 files · 616 pass** |
| `pnpm typecheck` | clean | clean | clean | **clean** |
| `pnpm build` | ok | — | ok | **ok** |

The fix wave was re-verified in the browser (playwright-cli, dev on :3075 against the fake on
:4455): after a Save that enabled iMessage the Channels dot was **neutral** (`checkedAt` null, not
repeated on the Settings parent), and Test connection turned it green; two texts sent one second
apart gave **two runs and two phone replies** (the second queued behind the first, no steer row),
the first texted as plain text ("Fruits | - Mango…" from "## Fruits / - **Mango**…"); a text whose
chat was not the sender's own returned `ignored:chat-mismatch`.

Every new test was mutation-checked by its task's implementer. This task's test
(`test/resend-fake.test.ts`) went red when the `&& import.meta.dev` half of the guard was removed.
The SDD ledger is `.superpowers/sdd/2026-09-28-bridget-channels/progress.md`, with per-task
reports and reviews alongside it.

## Fake-server acceptance (playwright-cli, dev on :3075, 2026-09-28 15:17–15:27 CDT)

Setup:

```bash
pnpm fake:bluebubbles --private-api
PORT=3075 BETTER_AUTH_URL=http://localhost:3075 BLUEBUBBLES_FAKE_URL=http://127.0.0.1:4455 RESEND_FAKE=1 pnpm dev
```

- Settings → Channels was filled with real clicks: the Enabled switch, the server URL and
  password, the allowed-handle tag `+15551234567`, the default handle from the select, email
  **Send to** `tony@fake.test`, presence **1 min**, then Save. The GET DTO read back the saved
  values with `hasPassword: true` and no password or token field apart from `webhookUrlPath`.
- **Test connection** showed the green **Private API on** badge. **Send test email** logged
  `[resend-fake] would send … subject="Bridget · test"`.
- Resend readiness needs a key and a sender, so a throwaway `observability_config` was written
  first: key `re_fake_acceptance`, from `bridget@fake.test`, alert email off.
- Inbound messages were simulated by POSTing BlueBubbles-shaped `new-message` bodies to the
  webhook. A wrong token returned **404**.
- The model runs were real, on dev main. The assertions are on DB rows, the fake's request log and
  the DOM, never on the model's wording.

| # | Scenario (spec §11) | Result | Evidence |
|---|---|---|---|
| 1 | Text Bridget → reply on the phone and in `/agent` main (📱 marker, delivered badge) | **PASS** | The webhook returned `enqueued`. The run had `reply_to.messageGuid=ACC75-TEXT-1` and ended `done`. One `channel_deliveries` row: `imessage` to `iMessage;-;+15551234567`, `source=reply`, `sent`, 1 attempt. The fake logged `chat/…/read`, `typing` POST, `typing` DELETE, then `message/text`. `/agent` showed the user bubble with the phone marker and the reply with a green "sent" badge (screenshot `s1.png`). |
| 2 | A photo → she describes it | **PASS** | The attachment was `image/heic` `IMG_0001.HEIC`. It downloaded with `original=false` (the fake returns a PNG), was stored as a webp gallery image and was attached to the run input (`kind: image`). She described it ("a blank solid periwinkle/lavender-blue square", which is right for the fake's 1×1 PNG). The reply was delivered and marked `sent`. |
| 3 | A voice memo → she answers its content | **PASS (failure path)** | `audio/x-caf` `Audio Message.caf`. The fake serves PNG bytes for every download, so STT failed as expected (`[channels] inbound voice memo … STT failed: 500`). The run input was exactly `(a voice memo I couldn't transcribe)`, and she replied asking him to resend. Delivered and `sent`. **The success path needs a real memo (real-phone scenario 3).** |
| 4 | An exec approval → 👍 tapback → it runs | **PASS** | She called `exec` `echo acceptance-75`. A `channel_approvals` row went `pending` with `prompt_guid=fake-msg-4` and the chat GUID. A `like` tapback webhook with `associatedMessageGuid: "p:0/fake-msg-4"` returned `tapback`, and the row went `approved`. Activity `exec:approval` recorded `outcome: approved`, `channel: imessage`. The handler ran; exec itself is disabled on a non-root Mac ("native exec requires running as root in the LXC"), which she reported back over iMessage (`sent`). |
| 5 | Run now on the morning brief while away → it reaches the phone | **PASS** | With presence at 1 min and no browser input for 75 s, `POST /api/jobs/morning-brief/run` was sent through `fetch` (no input events). The run was headless with `job_id` set and ended `done`. One delivery: `imessage` to the default chat, `source=job`, `sent`, with the text "Morning brief, Mon Sep 28: …". The seed stayed disabled and its hash was unchanged. |
| 6 | An `email` job → arrives by email with subject `Bridget · <slug>` | **PASS** | A temporary job `acc75-email` (`deliver: [email]`, disabled) was created with Run now. One delivery: `email` to `tony@fake.test`, `source=job`, subject **`Bridget · acc75-email`**, `sent`. The stub logged `[resend-fake] would send to=tony@fake.test … subject="Bridget · acc75-email" text=54 chars, html=259 chars`. The job page showed "Delivers to: App · Email" (`s6.png`). |
| 7 | BlueBubbles stopped → the delivery retries, then lands once it is back | **PASS** | The fake was killed (PID-verified) and a text was sent. Its reply row failed its 1st send (a network error) and then its 2nd (`duplicate check failed, not resending yet: … fetch failed`, so nothing was sent blind). It was `pending` with `attempts=2` and `next_attempt_at` at +2 min, which matches the 30 s → 2 m backoff. After the fake restarted, it went **`sent` at attempt 3**, and the fake logged exactly **one** `message/text`. |

**Cleanup:**
- `channel_*` rows: **0/0/0 before; 8 deliveries, 5 inbound and 1 approval created; all deleted;
  0/0/0 after**. They were re-verified as still 0 after the full `pnpm test:db` run.
- The temporary job `acc75-email` was deleted through the API, and its 2 revision rows were deleted
  by `target_id`.
- Settings: the snapshot found `channel_imessage` **present** (not absent, as the brief assumed; a
  cold config load on this branch had written it with `enabled: false` and a token), and
  `channel_email`, `presence_away_minutes` and `observability_config` absent. The three absent
  keys were deleted, and `channel_imessage` was restored byte-for-byte, including its
  `updated_at`.
- **The four seed jobs are unchanged:** all disabled, with `content_hash` identical before and after
  (`evening-wrap 5adbcfc8…`, `heartbeat 3e488eb4…`, `morning-brief a3726804…`,
  `session-digest 6d81e60a…`).
- Main keeps this run's rows, as accepted: 7 `agent_runs` (5 interactive iMessage turns, 2 job
  wakes) and their messages, plus the one webp gallery image from scenario 2 (attached to its
  message).

## Deviations from the spec (rulings, all from the SDD ledger)

**Planning rulings** (the plan's self-review):
- **The duplicate check is by own-message text within the claim window, not by `tempGuid`.**
  BlueBubbles does not persist `tempGuid` to chat.db, so the spec's `findByTempGuid` can't be
  built. `first_claimed_at` bounds the window.
- **Two schema additions:** `channel_deliveries.source` (for the tool rate limit, and so failure
  notes don't recurse) and `channel_approvals.chat_guid`.
- ~~**`reply_to` on steers:** steered iMessage text is persisted without `origin`, so steers get no
  📱 marker.~~ Superseded by final-review Ruling C1: inbound iMessage never steers.
- **A rescued turn** creates no delivery.
- **A job naming a channel that is now disabled** is skipped with an activity `warn`, not a note
  on main.
- **Seed `deliver` changes** reach existing installs only through the hash-guarded
  `upgradeSeedJobs`. Edited seeds are never touched.
- **Phone normalisation** is a small in-house function with a US default, not libphonenumber.
- **The webhook token is visible in the session-authed settings GET**, inside the copyable URL.

**Preflight rulings:**
- **Ruling 1:** the webhook token may appear ONLY in the session-authed settings GET inside
  `webhookUrlPath` (Tony must paste it into BlueBubbles). The password never appears.
  `global-constraints.md` was amended. Cost if wrong: a session-authed page shows a capability URL.
- **Ruling 2:** `attempts` = sends made. After the n-th failed send, n ≥ `MAX_ATTEMPTS` (6) →
  `failed`, else the next delay is `BACKOFF_MS[n-1]`. That is 6 sends total, and `BACKOFF_MS[5]`
  is unused but kept per the plan. Cost if wrong: one fewer retry.
- **Ruling 3:** jobs with no `deliver:` key change from `[app]` to **`[auto]`** (spec §9). On dev,
  any enabled job may start texting when Tony is away. This is acceptable: dev uses the fake
  server, and prod has no enabled jobs yet. **Cost if wrong: unexpected texts from custom jobs
  after deploy.** Review any custom job before enabling it.
- **Ruling 4:** the "channel must be configured" check runs only on job writes (create, save,
  enable), never in boot `revalidateAll`. A channel disabled later is skipped at delivery time.
  Cost if wrong: an enabled job keeps naming a dead channel silently (an activity warn only).

**Task rulings:**
- **Task 2 → 7:** an unrecognised `associatedMessageType` (iOS 18 emoji reactions 2006/3006) would
  have become a turn. Task 7's pipeline now drops ANY message with `associatedMessageGuid` set that
  isn't a recognised tapback. Cost if wrong: an odd reaction is ignored.
- **Task 3:** `requireSession` on the channels GET, PUT and regenerate routes and on
  `presence.post` (an API-token ping must not mark Tony present). The same fix round also covered:
  - tolerant parsing of a malformed stored row (defaults plus a warning, never a 500 on the
    webhook);
  - a PUT never writes `webhookToken`, so a concurrent regenerate isn't undone;
  - `serverUrl` restricted to http/https;
  - route tests for 400, 422, 403 and regenerate.
- **Task 4:** `findOwnMessage` uses `GET /api/v1/chat/:guid/message` (BlueBubbles serves it as GET;
  the plan said POST). Cost if wrong: the duplicate check 404s, which is treated as not found, so
  a duplicate is possible.
- **Task 4:** images must not be silently lost when the text sent but an image failed. Task 6's
  `insertDeliveries` splits an iMessage payload into one text row plus one row per image, each
  retried on its own. The adapter skips the duplicate check when `payload.text` is empty (an image
  retry may duplicate the image). Cost if wrong: a rare duplicate photo.
- **Task 4 → 6:**
  - `imessageClient()` returns null under VITEST unless `BLUEBUBBLES_FAKE_URL` is set;
  - 408 and 429 are retryable;
  - the adapter returns `ok:false` (non-retryable, "nothing to send") when nothing was sent;
  - there are adapter tests for unconfirmed pass-through and for `findOwnMessage` throwing (no
    resend).
- **Task 4 → 7:** image-only `sent_unconfirmed` rows can't be confirmed by text match, so the
  catch-up marks them sent after 10 min. Cost if wrong: an unconfirmed photo is reported sent.
- **Task 5:** the plan's `html()` override alone let `javascript:` hrefs survive, so the rendered
  email HTML goes through isomorphic-dompurify with links and images restricted to
  http/https/mailto. Spec §3 ("sanitised HTML") binds over the plan's technique.
- **Task 6:** reclaiming a stale `sending` row counts as a send (attempts+1), so the adapter's
  duplicate check runs. This extends Ruling 2. Cost if wrong: one fewer retry after a crash.
- **Task 6:** `findOwnMessage` HTTP 404 = "not found", so the send proceeds (a server lacking the
  route must not fail every retry). Any other error is retryable and nothing is sent. Cost if
  wrong: a possible duplicate on servers without the route. The fix round also made a reclaim at
  `attempts >= MAX` go to `failed` (not a 7th send) and added a SKIP LOCKED test.
- **Task 6 → 7:** `catchUpTick`'s `serverInfo` result refreshes the cached client's Private-API
  mode. Cost if wrong: a stale mode until restart.
- **Task 7** accepted these (cost if wrong: none material):
  - activity kind `inbound` (there is no `channel` ActivityKind);
  - photos stored as webp (`createImage` converts);
  - unknown senders' GUIDs recorded, to stop repeat warnings;
  - catch-up pagination, the early already-seen check and the in-memory high-water mark;
  - the widened `catchUpTick` test seams;
  - steered text without `origin` (moot since Ruling C1).
- **Task 7 → 8:** `planDeliveries` reads `agent_runs.reply_to` FRESH from the DB at finish (steers
  set it after the run started). Since Ruling C1 nothing sets it after creation; the read stays and
  is simply current.
- **Task 7 → 9:** `resolveTapback` applies the allowlist, group and from-me filters itself
  (tapbacks are routed before those filters).
- **Task 8** accepted all four implementer choices (cost if wrong: one extra read per app turn):
  - `planDeliveries` runs for every persisted reply (one PK read; the steer fresh-read needs it);
  - planning read errors are logged and never roll back the reply (insert errors still do);
  - `reply_to` deliveries require iMessage to be enabled;
  - tests stub the channel config instead of writing shared dev settings.
- **Task 8, two minors promoted to a fix round:**
  - planning reads use the append transaction (a second pooled connection per open transaction
    could deadlock the pool, max 10, under concurrent turns). They now run in a savepoint on it.
  - the seed upgrade treats an unedited seed that is only enabled as unedited, and keeps it
    enabled. Otherwise an enabled `session-digest` would have inherited `[auto]` and texted.
  - The same round added: no delivery for an empty reply; image markdown stripped from iMessage
    text when the image is attached; and a test that a planning failure still saves the reply.
- **Task 8:** boot revalidation applies the new `deliver` enum through the parser. Prod has no
  `agent_jobs` yet (cycle 74 is undeployed), so no invalid values can exist there. Resolved.
- **Task 9:** lazy registration of a `reply_to`-rereading approval channel for every interactive run
  that lacks one (the plan's literal `if (run.replyTo)` can't see a `reply_to` set by a steer). A
  socket channel from `ws.ts` overwrites it. Cost if wrong: one DB read per approval request on
  socketless app runs.
- **Task 11** accepted:
  - the extra `GET /api/conversations/:id/deliveries` (the `/agent` transcript isn't a vue-query
    read, so `['conversation']` invalidation alone can't refresh badges);
  - the amber/red dot repeated on the collapsed Settings parent.
  - Cost if wrong: one extra small request per viewed thread.
- **Task 11:** the 4 dev seed jobs were upgraded by this branch's boot code (the sanctioned Task 8
  upgrade). They are still disabled, and master's cycle-74 parser accepts the new `deliver` values.
  Cost if wrong: dev seeds show `deliver` lines ahead of master.
- **Task 11, review fix:** the deliveries and `channels/status` GETs gained `requireSession`. The
  same round made a malformed conversation id return 400, computed badges once per message, and
  moved the origin tests into `app/lib/agent/to-ui-messages.test.ts`.
- **Task 13 (this task):** `RESEND_FAKE=1` is a dev-only stub in `sendResendEmail`, guarded by
  `process.env.RESEND_FAKE === '1' && import.meta.dev`. It is the only product-code change in the
  acceptance task.

**Dev-DB notes from the build:**
- Task 3 and Task 11 each hand-reverted a mutation loop; both re-reviews found no leftover
  mutations.
- A Task 10 mutation run inserted one real pending `channel_deliveries` row on dev. It was deleted,
  and dev had no channel config at the time, so nothing could send.

## Final review fix wave

The controller's whole-branch review (`.superpowers/sdd/2026-09-28-bridget-channels/final-review.md`)
returned **with fixes**: 1 critical, 4 important, 9 minor, plus a triage of the parked minors. The
rulings below are binding; the fix wave implemented them in focused `fix(channels): …` commits
(`df281d8..` on this branch). Full evidence (tests, mutation checks, browser re-verification):
`.superpowers/sdd/2026-09-28-bridget-channels/final-fix-report.md`.

**Final-review rulings:**
- **Ruling C1 — inbound iMessage NEVER steers.** `enqueue` has a `noSteer` option, applied only in
  the steer check; `handleInbound` always passes it, so channel input is always its own queued run
  carrying `reply_to` and `origin`. The "set `reply_to` on the steered run" path is deleted. This
  removes the whole class: a steer the run never read being requeued without `reply_to` (lost
  phone reply), an app turn inheriting `reply_to`, and the `reply_to`-after-`pushSteer` gap. App
  steering is unchanged. **Cost if wrong:** a text sent mid-turn waits for that turn to finish
  instead of being merged into it.
- **Ruling I1 — the iMessage approval wait honours the run's abort signal.** The runner passes
  `ac.signal` into `replyToApprovalChannel`; an abort settles the row `pending → denied` and denies
  at once (reason `aborted`), so Stop and `/clear` unwind the run instead of waiting out the
  10-minute expiry. Covers the parked T9 "cancel on run end" minor.
- **Ruling I2 — the chat must be the sender's own direct chat.** Webhook and catch-up drop a
  message whose chat GUID's handle part (`<service>;-;<handle>`, any service prefix) does not
  normalise to the sender: `ignored:chat-mismatch` (+ an activity warn). `resolveTapback` applies
  the same match. **Cost if wrong:** a real direct chat whose GUID names a different handle form
  than the sender (to verify on the real server — checklist below) would be ignored.
- **Ruling I3 — a failed run with `reply_to` queues a short iMessage note**, "Sorry — something
  went wrong answering that." (`source: 'note'`, via the outbox). Not for aborted runs or app runs.
- **Ruling I4 — every test that inserts `channel_deliveries` commits them non-claimable** (future
  `next_attempt_at` in the same transaction, or a non-due status); scratch runs sit behind a
  `running` sentinel whose `alive_at` is in 2100.
- **Minor rulings fixed now:**
  - **M1** catch-up: the first-ever cursor is `now − 5 min` (was 1 h), and it never processes
    messages older than 24 h;
  - **M2** docs: one BlueBubbles server ↔ one MyMind (dev and prod both enabled both answer);
  - **M4** email keeps image links, as the wiki said: app-relative images become absolute links
    on `BETTER_AUTH_URL`'s origin, app-relative links are made absolute;
  - **M5** the wiki's "email can be enabled only when…" reworded (UI-only; not enforced server-side);
  - **M6** the status dot is neutral before the first check (and after a save that enables
    iMessage or changes its server/password);
  - **M7** iMessage text is converted from markdown to plain text (headings/emphasis stripped,
    links as `text (url)`); email keeps markdown;
  - **T7** the inbound DB test deletes its queued runs before the busy run stops running, and the
    sentinel's `alive_at` is in 2100;
  - **T9** the approval prompt's command is capped at 300 chars;
  - **T11 M3** `channel_deliveries(conversation_id)` indexed by a **new migration 0058** (0057 was
    already applied on dev — an applied migration is never edited);
  - **T7** `verifyWebhookToken` inside the try (a failing check is a 404, never a 500);
  - **T7** the `queue.ts` ↔ `inbound.ts` import cycle broken with a dynamic import in `workerTick`;
  - **T7** photos past the fourth get one "(more than 4 photos, the rest were skipped)" note.
- **Final re-review (controller fix):** `markdownToPlainText` mangled code and URLs (`__init__.py` →
  `init.py`, `?q=*foo*` → `?q=foo`). Code spans and URLs are now shelved behind placeholders before
  the emphasis passes, and `**`/`__` need word edges; 7 regression cases in
  `test/channels-plain-text.test.ts` (red on the previous version). Cost if wrong: none.
- **Deferred to follow-ups:** M3 (slow sends stall the tick), M8 (presence plugin session fetch),
  M9 (denial reasons to the model), and every other parked minor — listed below.

## Follow-ups (every parked item, plus what acceptance found)

**Parked minors from the task reviews.** Items marked "→ final fix wave" were earmarked for the
controller's final-review fix wave; what it fixed is struck through, the rest stays parked.

1. **isGroup** OR-branches are not independently covered; the fixtures carry both signals, as real
   BlueBubbles does. (T2)
2. **`isAway` may write the webhook token on a cold cache.** Harmless. (T3)
3. ~~**`imessageClient()` builds a fresh client per delivery**~~ (T4). Addressed on the branch:
   `clientFor` caches one client per (server URL, password), so Private-API detection happens once
   per config.
4. **The fake's `/message/query`** handles `sort: DESC`, which the client never sends. (T4)
5. **No `escapeHtml` helper reuse** in email rendering (it is the only usage). (T5)
6. **A 10-row batch of slow sends can outlast the 2-min reclaim.** Claim-fenced writes keep it
   consistent. `sentAny` is cosmetic. (T6)
7. **Inbound (T7) → final fix wave:**
   - ~~`verifyWebhookToken` sits outside the webhook's try~~ — fixed (404 on a failing check);
   - ~~the inbound DB test marks the headless run done before deleting the queued run~~ — fixed;
   - ~~a `queue.ts` ↔ `inbound.ts` import cycle~~ — fixed (dynamic import in `workerTick`);
   - STT is double-billed in a true webhook/catch-up race;
   - unknown senders' raw handles are stored unmasked in `channel_inbound`, which is never pruned
     (the reviewer would prefer masked or hashed; not a blocker);
   - ~~the test sentinel never bumps `alive_at`~~ — fixed (`alive_at` in 2100);
   - a crash between the dedupe insert and the enqueue loses the message (plan-accepted);
   - ~~a 5th photo gets a misleading note~~ — fixed;
   - the 20 MB cap is checked after the download.
8. **Deliveries (T8):**
   - the config cache is skipped when a caller passes the pool explicitly (tests only);
   - a cold token write holds the settings row lock until the append commits (first load only);
   - image-link extraction accepts any host;
   - the no-client presence test is weak.
9. **Approvals (T9) → final fix wave:**
   - ~~cancel a run's pending approvals on run end~~ — fixed by Ruling I1 (the wait honours the
     abort signal and settles the row `denied`);
   - a failed expiry update leaves the row `pending` (housekeeping re-expires it);
   - the runner test covers only the ws-first order;
   - ~~the command is shown raw (no length cap)~~ — fixed (300 chars);
   - the group check is only `;+;` (safe via the chat match);
   - the tests were written after the code.
10. **`send_message` (T10):**
    - the rate-limit check-then-insert is not atomic;
    - `subject` is silently dropped for iMessage;
    - disabled/no-target is covered for a single channel only.
11. **UI (T11):**
    - ~~M3: no `conversation_id` index~~ — fixed by migration 0058;
    - M5: clearing the presence field gives a 422 with no hint;
    - M6: the ref+load draft pattern departs from `live-data.md` (brief-mandated).
12. **The voice memo success path and real HEIC conversion were not exercised on the fake.** The
    fake serves PNG bytes for every download. Covered by real-phone scenarios 2 and 3.
13. **The wiki mirror to MyMind** for `channels`, `agent-jobs` and `agent-runtime` is left to the
    controller.
14. **Deferred from the final review:**
    - ~~**M3 slow sends stall the worker tick:**~~ **Resolved** in the reliability pass ([reliability handover](2026-09-29-bridget-reliability.md)): the outbox runs off the tick (single-flight) and sends concurrently across chats. Original note: a blackholed BlueBubbles host costs 15 s × (duplicate
      check + send) × up to 10 rows, plus catch-up's 15 s, delaying `recoverStale`, `jobsTick` and
      `dueTaskEvents` for minutes. Fix idea: a per-tick send budget (~20 s) or running
      `deliveriesTick` outside `ticking`.
    - **M8 `presence.client.ts` calls `authClient.getSession()` on every route change** — one
      extra request per navigation. Fix idea: sync once, plus on a 401.
    - **M9 approval denial reasons stay in activity meta:** the model only sees `{denied:true}`, so
      over iMessage Tony can't tell "you said no" from "approvals can't work right now"
      (`private-api-off`, `prompt-send-failed`, `aborted`). Fix idea: return a reason the model can
      relay.
    - From the triage, accepted as-is: T2 isGroup coverage; T3/T8 cold-cache token writes; T4 fake
      DESC; T5 escapeHtml; T6 slow batch vs reclaim (fenced); T7 STT double-billing, crash window,
      20 MB after download, unmasked unknown-sender handles; T8 pool-passed cache skip, image-link
      host, weak presence test; T9 failed-expiry update, ws-first-only test, `;+;` group check;
      T10 non-atomic rate limit, subject dropped for iMessage, single-channel coverage; T11 M5
      presence 422 hint, M6 draft pattern.
15. **Email with Resend unconfigured (M5):** the server does not refuse `email.enabled: true`
    without a Resend key/sender (only the UI does). Each email delivery then fails non-retryably
    and posts a failure note on main. Enforcing it server-side is a possible follow-up.

### Real-phone acceptance checklist (for the controller with Tony)

Run this against **dev** (or prod after deploy), with dev's own webhook token registered in
BlueBubbles for the session. Unset `BLUEBUBBLES_FAKE_URL` and `RESEND_FAKE`, and set Settings →
Channels to the real server. Before starting, snapshot and afterwards restore the channel settings
on the shared dev DB.

**Before starting: prod's iMessage must be disabled** (one BlueBubbles server ↔ one MyMind — both
would answer every text), and restore dev's settings afterwards.

1. **Text Bridget → reply on the phone and in `/agent` main.** Check the 📱 marker on his message,
   the green "sent" badge on her reply, and typing dots and a read receipt on the phone while she
   works. The reply must arrive as **plain text** (no `**`, `#` or `[..](..)` syntax).
   - **Double-text:** send a second text while she is still answering the first → it waits, then
     gets **its own reply** on the phone (inbound never steers — Ruling C1).
2. **A photo → she describes it.** Use a real iPhone HEIC photo. It must arrive as JPEG (via
   `original=false`) and be described, not "(couldn't load the photo)".
3. **A voice memo → she answers its content.** It must be transcribed, not "(a voice memo I
   couldn't transcribe)".
4. **An exec approval → 👍 tapback → it runs.** Also try 👎 (denied), and silence for 10 min
   (expired, which counts as a denial).
5. **Run now on the morning brief while "away"** (no app activity for `presence_away_minutes`) → it
   reaches his phone. Repeat while active in the app: `[auto, imessage]` still texts (explicit
   `imessage`), while an `[auto]`-only job (e.g. evening-wrap) should NOT text.

Also verify these things on Tony's real server, which the fake cannot show:
- **The chat GUID form on real payloads (Ruling I2):** the webhook's `chats[0].guid` must be
  `<service>;-;<handle>` with the handle matching `handle.address` after normalisation (e.g. a
  phone number vs an Apple ID email in the same chat would not match). If his texts come back
  `ignored:chat-mismatch` (activity `imessage:chat-mismatch`), log both values.
- **The voice memo's real MIME type** (expected `audio/x-caf`, "Audio Message.caf") and that STT
  accepts it. Check the `[channels] inbound voice memo` log and the persisted input text.
- **Whether the webhook fires before the attachment has finished downloading on the Mac.** If the
  download 404s or comes back empty on the first try, the message goes through with the failure
  note, and the catch-up will not re-handle it (the GUID is already recorded). Log what happens.
- **Whether the tapback target prefix is stripped correctly** on real payloads (`p:0/<guid>`,
  `bp:<guid>`). The approval row must go `approved` on a real 👍.
- **Whether the `findOwnMessage` route exists** on Tony's server:
  `curl "http://<mac>:1234/api/v1/chat/iMessage%3B-%3B%2B1…/message?password=…&limit=1&sort=DESC"`
  must return 200. A 404 means the duplicate check is skipped, and a retry could double-text.

**Final re-review leftovers (parked):**
- ~~A Stop and a 👍 landing within milliseconds can report "approved" to the run after the Stop~~
  **Resolved** ([reliability handover](2026-09-29-bridget-reliability.md)): Stop denies before any DB write, and the row always ends `denied`. Original note: a Stop and a 👍 landing within milliseconds can report "approved" to the run after the Stop
  (`approvals.ts` `onAbort` waits on its DB update before resolving). The exec pre-spawn abort
  check still stops the command from running.
- A transitive import cycle remains: queue → runner → approvals → inbound → queue (call-time only).
- The status dot can stay neutral for up to 2 min after enabling iMessage (until the first
  catch-up or a Test connection).

## Deploying (when merged)

Cycle 74 is not deployed either. Deploying 74 and 75 together applies migrations **0056, 0057 and
0058**. Follow the cycle-74 handover's deploy steps first (backup, the skills move, the seed
install), then:

1. Take a pre-deploy dump to `/root/db-backups` (not `/opt/mymind`).
2. CD applies **0056**, **0057** and **0058**. On first boot, the four seeds are installed with this cycle's
   `deliver:` lines (a fresh install writes `SEED_JOBS` directly), **disabled**.
3. **Set the prod `agent_timezone`** (from cycle 74): Settings → Bridget → Agent timezone =
   `America/Chicago`, before enabling any job.
4. **Settings → Activity & Alerts:** the Resend API key and sender (email needs both).
5. **Settings → Channels:** enable iMessage (Server URL, password, allowed handle, default handle)
   and Email (Send to), then Save. **First make sure dev's iMessage is disabled** — one BlueBubbles
   server ↔ one MyMind; the catch-up polls regardless of the webhook, so both would answer every
   text. Prod's first catch-up reaches back only 5 minutes (and never more than 24 h), so it will
   not replay texts dev already answered.
6. **Register the webhook in BlueBubbles:** Settings → API & Webhooks → add the URL, with events
   **New Messages** and **Message Updates**. Use the prod LAN URL
   `http://192.168.2.89:3000/api/channels/bluebubbles/webhook?token=…` (LXC 114), or the public
   `https://brain.costanzoclan.com/api/channels/bluebubbles/webhook?token=…`. Copy the token from
   Settings → Channels. Make sure LXC 114 can also reach the Mac's BlueBubbles port.
7. **Confirm the Private API badge:** Test connection → green **Private API on**, and a green nav
   dot. Amber means AppleScript only: no tapbacks, and exec approvals are denied.
8. **Send test message** and **Send test email**, then run the real-phone checklist above.
9. **Remember preflight Ruling 3:** jobs without a `deliver:` line now default to `[auto]` and will
   text Tony when he is away. Review any custom job before enabling it.

Full steps and the network notes: [`DEPLOYMENT.md` §19](../DEPLOYMENT.md#19-bridget-channels--imessage-bluebubbles--email-resend-cycle-75).

**Rolling back:** 0057 and 0058 are additive and nothing older reads its tables, so a redeploy of the
cycle-74 build works with the tables left in place. Unregister the BlueBubbles webhook first;
otherwise its calls just fail harmlessly (the cycle-74 build has no such route, so they are
rejected by auth).

## Where cycle 76 starts

- Cycle 76 is the self-improvement cycle on the roadmap. Before it, merge 74 + 75, deploy, and run
  the real-phone checklist with Tony.
- The final whole-branch review ran and its fix wave is done. What it deferred is follow-up 14.
- The cycle-74 reliability follow-ups (interrupted runs leave `last_outcome` stale, at-most-once
  across a crash, the `runJobNow` race) matter more now that job results reach a phone.
  (Resolved in the reliability pass: [reliability handover](2026-09-29-bridget-reliability.md).)
