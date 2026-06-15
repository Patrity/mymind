---
title: Activity Log — Centralized Request/Job/Model Observability
date: 2026-06-15
status: spec
supersedes: null
related:
  - docs/superpowers/specs/2026-06-12-live-reactivity-design.md
  - docs/superpowers/specs/2026-06-10-ai-config-registry-design.md
  - docs/superpowers/specs/2026-06-03-sessions-view.md
---

# Activity Log — Centralized Request/Job/Model Observability

## Problem

MyMind does most of its real work **out of band and invisibly**: four cron jobs
(`embed-documents`, `enrich-input`, `enrich-images`, `enrich-memories`) call AI models on a
5–15 min cadence, the agent/voice/MCP surfaces make model + tool calls, and machine clients
(CC/Hermes hooks, ShareX uploads, API-token callers) hit inbound endpoints. When any of this
misbehaves there is **nowhere to look**. The questions that recur — *"Did that get sent to the
model?"*, *"What did the model return?"*, *"Was there an error?"* — have no answer surface.
Errors are routinely swallowed into `console.warn`/`console.error` that nobody reads.

The canonical failure is the 2026-06-14 drop-native-anthropic bug: a misconfigured provider
returned an **HTML shell with HTTP 200**, `chat()` read it as `''`, `withFailover` treated the
empty result as success and **never failed over**, and `enrich-input` silently produced zero
proposals every 10 minutes for an unknown stretch — discovered only because the user happened
to notice repeated "parse failed" log lines. A request ledger would have shown, in one glance:
*sent to provider `litellm-gateway` → got HTML/200 → extractContent threw → failed over to
local-qwen → ok*. We are flying blind on the most failure-prone part of the system.

## Goal

A single, queryable, **live** ledger of everything the system does — inbound requests,
background jobs, model calls (with each failover attempt), and agent tool calls — stored in
Postgres, browsable + tailing in real time at `/activity`, with proactive error surfacing
(badge + toast + throttled email). Observability that **never alters or breaks** the work it
observes.

### Non-goals
- OpenTelemetry / distributed-trace export. (Clean future seam; not now.)
- Per-user event scoping — single-user app; data rows carry no `userId`.
- Sampling — we chose keep-all + tiered prune instead.
- Full inbound request/response **body** capture (metadata only for inbound).
- Metrics charts / dashboards. The table + filters are enough for v1.
- Replacing `console` everywhere. We convert the high-value swallowed-error sites only.

## Decisions (locked during brainstorm)

| # | Decision | Choice |
|---|---|---|
| 1 | Breadth | The broadest scope: **inbound requests + background jobs + model calls (per failover attempt) + agent tool calls.** A true "everything the system did" ledger. |
| 2 | Data model | **Approach A — one unified `activity_log` table.** Every captured thing is a row with a discriminated `kind` + `trace_id`/`parent_id` correlation. (Rejected: per-domain tables = 4× sync surface; JSONL files = not SQL-queryable, awkward live tail/alerting.) |
| 3 | Retention | **Keep all, tiered prune.** Daily cron: `info`/`debug` > 14 d deleted, `warn`/`error` > 90 d, + hard row cap (oldest-first). Windows tunable in settings. |
| 4 | Error surfacing | **Badge + live toast + Resend email**, every channel toggleable in settings. Email is severity-gated + throttled/digested. (Closes the long-standing "Email (ReSend) not built" backlog item.) |
| 5 | Live UI | **Follow the cycle-21 live-data convention** (the `add-live-resource` skill): `activity` becomes a `ResourceName`, vue-query reads + `publishChange` writes over the existing `/api/events` SSE → invalidation → refetch. **No second SSE channel.** |
| 6 | Capture safety | Capture is **fire-and-forget and self-isolating**: it can never throw into the caller and never change the real call's outcome or timing meaningfully. |

## Architecture

```
inbound request ─┐
  cron job  ──────┤  withSpan(kind,name,fn)         server/lib/observability/record.ts
  agent step ─────┤    → opens a `running` row (AsyncLocalStorage carries current span id)
  model call ─────┤    → runs fn; nested spans auto-attach via parent_id
  tool call  ─────┘    → closes row ok|error + duration
                          │
                          ├─ buffered insert (≈1s / N-row flush queue) → activity_log (Postgres)
                          ├─ publishChange({resource:'activity', action})  (coalesced)  → /api/events SSE
                          └─ notifier (server-side): severity≥threshold → throttled Resend email
                          ▼
   /activity page (vue-query): list + detail trace tree + live-tail pause toggle
   sidebar badge ●N (unacked errors)   ·   toast on error signal   ·   email when away
```

### The data model — `activity_log` (one table)

`server/db/schema/activity-log.ts`, following the existing `pgTable` conventions (uuid PK,
jsonb, timestamptz):

```
id          uuid pk            default gen_random_uuid()
trace_id    uuid    not null   -- groups one logical operation (root + all descendants)
parent_id   uuid    null       -- self-ref nesting: attempt → model → job → inbound
kind        text    not null   -- 'inbound' | 'job' | 'model' | 'attempt' | 'tool'
name        text    not null   -- 'POST /api/hooks/cc' | 'enrich-input' | 'chat:reasoning' | 'save_memory'
status      text    not null   -- 'running' | 'ok' | 'error' | 'warn'
severity    text    not null   -- 'debug' | 'info' | 'warn' | 'error'  (drives retention + alerts)
usage       text    null       -- registry Usage for model/attempt kinds (reasoning/bulk/vision/…)
provider    text    null       -- provider label + host ONLY (never the key)
model_id    text    null
attempt     integer null       -- failover position (0,1,2…) for attempt rows
duration_ms integer null
tokens      jsonb   null        -- { prompt, completion, total } when the provider returns usage
request     jsonb   null        -- captured input (messages/args/payload), truncated + redacted
response    jsonb   null        -- captured output (text/result), truncated; NEVER vectors/keys
error       jsonb   null        -- { message, stack, cause }
meta        jsonb   not null default '{}'  -- related ids (docId/imageId/sessionId), http status, …
acked_at    timestamptz null    -- powers the unacked-error badge
created_at  timestamptz not null defaultNow()
finished_at timestamptz null
```

Indexes: `created_at DESC`, `trace_id`, `kind`, `severity`, and a **partial index on
`status = 'error'`** (the badge/alert/error-filter hot path).

**Correlation is the point.** The Anthropic bug reads as one trace:
```
model   chat:reasoning                         status=error
  ├ attempt#0  provider=litellm-gateway         status=error  error="no usable content (HTML/200)"
  └ attempt#1  provider=local-qwen              status=ok
```
A `job` row parents the `model` rows it triggers; an `inbound` row parents the whole job/agent
turn it kicks off — reconstructable by `trace_id`, nestable by `parent_id`.

### Capture primitive — `server/lib/observability/`

- **`recordEvent(partial)`** — fire-and-forget insert. Wrapped in its own try/catch that only
  `console.error`s on failure. **Hard invariant: it never throws into the caller and never
  changes the real call's result.** Observability that breaks the observed path is worse than
  none.
- **`withSpan(kind, name, fn, meta?)`** — opens a `running` row, runs `fn` inside an
  `AsyncLocalStorage` context holding the current span id, and closes the row `ok`/`error` with
  `duration_ms` (and, on throw, the captured `error`). Returns `fn`'s result untouched and
  **re-throws** any error `fn` throws (it observes, it does not swallow).
- **Buffered writes** — inserts go through a small in-memory queue flushed on a ~1 s timer or at
  N rows, so hot paths (an embedding per document) don't pay a per-call DB round-trip.
- **Nesting** — `withSpan` reads the active span id from ALS for `parent_id` and inherits/creates
  `trace_id`. `withFailover` runs inside whatever span is active, so model/attempt rows
  auto-attach with no changes to call signatures.

### Five instrumentation seams (the entire footprint)

| Seam | Where | Emits |
|---|---|---|
| Inbound | `server/middleware/auth.ts` (or a sibling middleware) | `inbound` row: method, path, who (token name/session), http status, duration. **Metadata only.** |
| Job runner | the 4 `server/tasks/*.ts` (one `withSpan` wrap each) | `job` row + its summary return (`{proposed, skipped, …}` stops evaporating) |
| Model call | `withFailover`/`withFailoverOver` (`resolve.ts`) + `chat()` (`chat.ts`) | one `model` row + one `attempt` row per failover step (the existing `attempts[]` array is the source) |
| Agent step | `runAgent` loop (`server/lib/agent/`) | `model` rows per reasoning step |
| Tool call | `server/lib/agent/tools.ts` | `tool` row: name, args, result (these spots already `publishChange`) |

### Per-kind capture / redaction rules

Single-user homelab → favor debuggability, but stay sane on size and never leak secrets:

- **model / chat** — full prompt messages + assistant text, each truncated (~8 KB/part, ~32 KB
  total) with a `…truncated` marker; `tokens` if the provider returns usage. **Never** the
  decrypted `apiKey`; `provider` is label + host only.
- **embeddings** — input text (truncated) + count; response is `{ dim, count }` — **never the
  2560-d vector** (huge + useless).
- **vision** — text prompt + an image **reference**/size, not the base64 blob.
- **stt / tts** — transcript/text + audio duration/size, not raw audio.
- **job** — task args + the summary object returned.
- **tool** — args + result (truncated).
- **inbound** — metadata only (method/path/status/who/duration), not bodies.

Per-kind capture can be **toggled off** in settings (e.g. silence `embeddings` if too noisy).

### Retention — `prune-activity-log` cron (daily)

Deletes `info`/`debug` older than `retainInfoDays` (default 14), `warn`/`error` older than
`retainErrorDays` (default 90), then enforces a hard `maxRows` cap (default 500k, oldest-first).
All three values live in `observability_config`. Errors outlive the routine noise.

### Live UI — the cycle-21 convention (no new channel)

`activity` is added to the closed `ResourceName` union (`shared/types/live.ts`). `recordEvent`
calls `publishChange({ resource: 'activity', action })` after insert (**coalesced/debounced** —
one signal per ~1 s burst so embedding spam can't cause an invalidation storm). The existing
`/api/events` SSE, `live.client.ts` `EventSource`, and `live-dispatch.ts` registry carry it.

- **Reads** — `useActivityLog` composable, vue-query keys per the live-data rule:
  `['activity','list',params]` (params in a `computed`), `['activity', id]` detail,
  `['activity','count']` for the error badge. Data is **read-only** — iterate
  `computed(() => data.value ?? [])`, refresh via invalidation; no hand-rolled `loadX()`.
- **`live-dispatch.ts` `activity` override** — invalidates `['activity','list']` +
  `['activity','count']`; on an **error-action** signal it also fetches that row by `id`
  (`/api/activity/[id]`) and raises a toast — staying within the thin-signal convention
  (refetch by id, no payload on the wire).
- The list query only mounts on `/activity`, so other tabs pay nothing; vue-query `staleTime`
  dedupes refetches.

### `/activity` page

Sidebar sibling to **Sessions**. A table — time · kind · name · status (color-coded) ·
usage/model · duration — with filters: kind / status / severity / usage / time-range / text
search + trace-id lookup. Row click → a detail drawer showing request/response/error JSON **and
the nested trace tree** (grouped by `trace_id`, indented by `parent_id`). A **"live tail" pause
toggle** freezes auto-refetch so a busy log can be read without rows jumping.

### Alerting (three channels, all in `observability_config`)

1. **Badge** — sidebar `Activity ●N` of unacked errors, event-driven via `['activity','count']`
   invalidation (same pattern as the Memory/Review badges — no poll). Ack (per-row or "ack all")
   sets `acked_at` and clears it.
2. **Toast** — via the `activity` dispatch override on an error signal (above); `useToast` with a
   `[View]` action linking to the record.
3. **Email (Resend)** — a **server-side** notifier on the insert path (not the client). On
   `severity ≥ threshold` it coalesces errors into **one email per `digestWindowMin`** (default
   15) and sends via Resend. Resend API key encrypted at rest via the existing `crypto.ts`.

### Settings — new `/settings` tab "Activity & Alerts"

Edits an `observability_config` doc stored in the generic `settings` table under
`key = 'observability_config'`, zod-validated exactly like `ai_config`:

```ts
interface ObservabilityConfig {
  version: 1
  retainInfoDays: number        // default 14
  retainErrorDays: number       // default 90
  maxRows: number               // default 500_000
  capture: Record<Kind, boolean>            // per-kind on/off (silence embeddings, etc.)
  alerts: {
    badge: boolean              // default true
    toast: boolean              // default true
    email: {
      enabled: boolean          // default false
      recipient: string | null
      apiKeyEnc: string | null  // Resend key, AES-GCM via crypto.ts; server-only
      minSeverity: 'warn' | 'error'   // default 'error'
      digestWindowMin: number   // default 15
    }
  }
}
```

The email `apiKeyEnc` is **never serialized to the client** (redacted to `hasKey: boolean`,
same as provider keys in `ai_config`).

## Components & boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `server/db/schema/activity-log.ts` | table + indexes + types | drizzle |
| `server/lib/observability/record.ts` | `recordEvent`, `withSpan`, ALS context, buffered flush | live-bus, db, config |
| `server/lib/observability/config.ts` | load/save/validate `observability_config` (zod), redact, crypto | settings store, crypto.ts |
| `server/lib/observability/notify.ts` | server-side email notifier (severity gate + digest + Resend) | config |
| instrumentation edits | `resolve.ts`, `chat.ts`, the 4 tasks, agent loop/tools, inbound middleware | `record.ts` |
| `server/tasks/prune-activity-log.ts` | retention prune | config, db |
| `server/api/activity/index.get.ts` · `[id].get.ts` · `[id]/ack.post.ts` · `ack-all.post.ts` · `count.get.ts` | query + ack endpoints | db |
| `server/api/settings/observability-config.{get,put}.ts` | settings CRUD (redacted read; write-only key) | config |
| `app/composables/useActivityLog.ts` | vue-query reads (list/detail/count) | vue-query |
| `app/pages/activity/index.vue` + detail drawer | the UI | composable |
| `app/components/settings/ActivityAlertsTab.vue` | the settings tab | useObservabilityConfig |
| `shared/types/live.ts` + `app/utils/live-dispatch.ts` | register the `activity` resource | — |

## Testing

- **record/withSpan** — nesting (parent_id/trace_id via ALS), `ok`/`error` close + duration,
  and the **non-interference invariant**: a `recordEvent` that throws internally must not affect
  `fn`'s result or propagate; `withSpan` re-throws `fn`'s error unchanged.
- **redaction** — apiKey never present; embeddings store `{dim,count}` not the vector; oversize
  bodies truncated with the marker.
- **failover capture** — `withFailoverOver` over a chain where #0 throws and #1 succeeds yields
  one `model` row + two `attempt` rows with the right statuses (regression-guards the Anthropic
  bug class).
- **retention** — prune deletes by the tiered windows + row cap; errors survive past the info
  window.
- **config** — zod validation, redaction strips `apiKeyEnc`, encrypt/decrypt round-trip.
- **notifier** — digest coalescing (N errors in a window → 1 email), severity gate.
- **live wiring** — `activity` in the `ResourceName` union resolves in `live-dispatch` (type
  check); error signal triggers count invalidation + toast path.

## Risks & mitigations

- **Invalidation storm from embedding volume** → emits are coalesced/debounced; list mounts only
  on `/activity`; per-kind capture can be disabled.
- **Capture latency on hot paths** → buffered queue, not per-call inserts; fire-and-forget.
- **Email spam from a flapping job** → severity gate + per-window digest, off by default.
- **Secret leakage** → redaction rules + server-only key fields, mirrored on the existing
  `ai_config` precedent.
- **The capture path itself failing** → fully isolated try/catch; degrades to `console.error`,
  never the user's request.

## Open seams for later (noted, not built)
- OpenTelemetry export · metrics/aggregate charts · per-user scoping · fuller inbound body
  capture · feeding `error`-kind rows into the cycle-15 notification/review surface.
