---
title: Activity Log (Observability)
status: shipped
cycle: 22
updated: 2026-06-15
---

# Activity Log — Centralized Observability

**status: shipped** (cycle 22)

A single, queryable, live ledger of everything the system does — inbound requests, background
jobs, model calls (per failover attempt), and agent tool/reasoning calls — stored in Postgres,
browsable + tailing at `/activity`, with badge + toast + Resend-email error alerts. The design
goal: observability that **never alters or breaks** the work it observes.

Motivating incident: the 2026-06-14 "provider returned HTML/200, `chat()` read it as `''`,
`withFailover` thought it succeeded and never failed over" bug ran silently for an unknown
stretch. With this system that reads as one trace: `attempt#0 → error (no usable content) →
attempt#1 → ok`. See [`ai-providers.md`](ai-providers.md).

## Pipeline

```
inbound request ─┐
  cron job  ──────┤  withSpan(input, fn)  /  recordEvent(input)     server/lib/observability/record.ts
  agent turn ─────┤    → AsyncLocalStorage carries the active span (trace_id + parent_id)
  model attempt ──┤    → buffered, flushed every ~1s, FIRE-AND-FORGET (never throws into the caller)
  tool call ──────┘    → request/response sanitized at the choke point (redact.ts)
                          │
                          ├─ INSERT activity_log (Postgres)
                          ├─ publishChange({resource:'activity',action})  → /api/events SSE  (cycle-21 bus)
                          └─ error rows → email digester (Resend, severity-gated + windowed)
                          ▼
   /activity  (vue-query): live list (true pause) + trace-tree detail + ack/ack-all
   sidebar Activity ●N badge   ·   new-error toast   (both gated by settings flags)
```

## Storage — `activity_log` (`server/db/schema/activity-log.ts`, migration `0014_groovy_darwin`)

One row per captured span. Key columns: `id`, `trace_id` (the root operation), `parent_id`
(self-ref nesting), `kind` (`inbound|job|model|attempt|tool`), `name`, `status`
(`ok|error|warn`), `severity` (`debug|info|warn|error` — drives retention + alerts), `usage`,
`provider` (label@host — **never the key**), `model_id`, `attempt`, `duration_ms`, `tokens`,
`request`/`response`/`error` (jsonb, sanitized), `meta`, `acked_at` (badge), `created_at`,
`finished_at`. Indexes: `created_at DESC`, `trace_id`, `kind`, `severity`, and a **partial**
`activity_unacked_error_idx` on `(acked_at) WHERE status='error' AND acked_at IS NULL` (the
badge-count hot path).

## The recorder — `server/lib/observability/`

- **`record.ts`** — `createRecorder(deps)` (pure, dependency-injected: `sink`/`publish`/`notify`/
  `now`/`newId`) returns `{ recordEvent, withSpan, flush }`. `withSpan(input, fn)` opens a span,
  runs `fn` inside an `AsyncLocalStorage` context, and records **one row at completion** (status
  `ok`/`error` + duration) — it re-throws `fn`'s error (observes, never swallows). `recordEvent`
  is a sync enqueue. **Non-interference is the hard invariant:** `recordEvent`/`flush` swallow
  their own errors to `console.error`; a dead DB drops the batch, never the request. The wired
  app singleton (`recorder` + `withSpan`/`recordEvent`/`captureEnabled` exports) has a DB-insert
  sink, publishes one `activity` live signal per flush, and routes error rows to the email
  digester. A Nitro plugin (`server/plugins/observe-flush.ts`) starts a 1s `unref`'d flush loop.
- **`redact.ts`** — `truncate` / `sanitizeRequest(kind, …)` / `sanitizeResponse(…)`. Applied
  **centrally in the recorder's `build()`** (defensive `safeSanitize` wrapper), so every seam is
  covered: secret keys (`apiKey`/`authorization`/…) are dropped, embedding vectors collapse to
  `{dim,count}`, oversize blobs are capped (~8 KB/part, ~32 KB total).
- **`config.ts`** — `observability_config` doc in the `settings` table (zod-validated, mirrors
  the `ai_config` registry). `redactObsConfig` strips the Resend `apiKeyEnc` → `hasKey`. Cached
  with explicit invalidation.
- **`notify.ts` / `email.ts`** — `shouldNotify` (severity gate) + `buildDigest` (coalesce N
  errors → 1 email) + `createEmailDigester` (one email per `digestWindowMin` window). Resend via
  a minimal REST `$fetch` (no SDK). Key decrypted at send-time via `ai/registry/crypto.ts`.

## Emit sites (the seams)

| Seam | Where | Rows |
|---|---|---|
| Model failover | `withFailoverOver` (`ai/registry/resolve.ts`) | one `attempt` row per model tried (ok=info / fail=warn); a `model` `:all-failed` (error) when the chain is exhausted |
| Agent reasoning | `server/lib/agent/run.ts` loop | one `attempt` row per reasoning model tried; `model` `:agent-all-failed` on exhaustion |
| Agent tools | `server/lib/agent/ai-tools.ts` (`buildAiTools` handler wrap) | one `tool` row per call (name + sanitized args), nested under the turn |
| Cron jobs | the `server/tasks/*.ts` crons | one `job` row per run (liveness, always) + a `:summary` child carrying the service's return (`{proposed,skipped,…}`) **only when the run did real work** (`recordJobSummary` → `jobDidWork`: any non-`remaining` counter > 0). All-zero no-op ticks are suppressed so the feed doesn't read as constant re-embedding/churn |
| Enrichment | `server/services/enrichment.ts` | `enrich-input:parse-failed` (warn), `:queued` (info), `:doc-error` (error) — the old swallowed `console.warn` is now a visible row |
| Inbound | `server/plugins/observe-requests.ts` (Nitro `request`/`afterResponse`) | one flat `inbound` row per authed `/api/**` request (method/path/status/who/duration, **metadata only**). Skips `/api/auth|share|i|events|activity` (no self-logging loop) |

## Retention — `prune-activity-log` cron (`0 3 * * *`)

`pruneActivity` deletes `info`/`debug` rows older than `retainInfoDays` (14), `warn`/`error`
older than `retainErrorDays` (90) — **keyed on `severity`**, per spec — then enforces a hard
`maxRows` cap (500k, oldest-first via `OFFSET`). All three values + per-kind capture toggles
live in settings.

## UI + live

- `activity` is a `ResourceName` (`shared/types/live.ts`); the recorder's `publishChange` rides
  the existing `/api/events` SSE. `app/utils/live-dispatch.ts` invalidates `['activity','list']`
  + `['activity','count']`.
- **`/activity`** (`app/pages/activity/index.vue`) — live list (time · kind · name · status ·
  provider/model · duration) with kind/status/text filters and a **Pause** toggle that truly
  freezes the displayed rows, plus **Ack all**. Detail (`[id].vue`) reconstructs the nested
  **trace tree** (group by `trace_id`, indent by `parent_id`) with request/response/error/meta
  JSON and per-row **Ack**.
- **Alerts** (all in `observability_config`, edited at `/settings` → **Activity & Alerts**):
  sidebar `Activity ●N` unacked-error badge, a new-error toast (de-duped by timestamp), and
  Resend email — each independently toggleable; the layout honors `alerts.badge`/`alerts.toast`.
  **Email is off by default** until a key + recipient are set.

Endpoints: `GET /api/activity` (filtered list), `GET /api/activity/[id]` (trace), `GET
/api/activity/count` (`{unacked, latest}`), `POST /api/activity/[id]/ack`, `POST
/api/activity/ack-all`; `GET|PUT /api/settings/observability-config` (redacted read; write-only key).

## Deliberately deferred (v1 scope)

- **Model request/response *body* capture** — chat prompts + assistant text are **not** stored
  today; only attempt-level metadata, errors, and the `:all-failed` cause are. The redaction
  layer is already wired at the choke point, so adding body capture is a small fast-follow.
- **Happy-path `model` parent span** — on success `withFailoverOver` emits only `attempt` rows
  (a `model` row appears only on chain exhaustion), so successful attempts render as siblings
  under the active job span rather than under a `model` node.
- **Single completion row** (no separate in-flight `running` row); **inbound rows are flat**
  (not parents of the work they trigger — ALS-wrapping the handler is the future seam);
  **per-user scoping** not built (single-user app).

Spec: [`../superpowers/specs/2026-06-15-activity-log-observability-design.md`](../superpowers/specs/2026-06-15-activity-log-observability-design.md) ·
Plan: [`../superpowers/plans/2026-06-15-activity-log-observability.md`](../superpowers/plans/2026-06-15-activity-log-observability.md) ·
Handover: [`../handovers/2026-06-15-activity-log.md`](../handovers/2026-06-15-activity-log.md)
