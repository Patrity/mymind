---
title: Activity Log — centralized request/job/model/tool observability
cycle: 22
date: 2026-06-15
status: shipped
wiki: ../wiki/activity-log.md
spec: ../superpowers/specs/2026-06-15-activity-log-observability-design.md
plan: ../superpowers/plans/2026-06-15-activity-log-observability.md
shipped:
  - "server/db/schema/activity-log.ts + migration 0014_groovy_darwin — the `activity_log` table (trace_id/parent_id correlation, kind/status/severity, sanitized request/response/error jsonb, acked_at) with a partial `activity_unacked_error_idx` (status='error' AND acked_at IS NULL) powering the badge count."
  - "server/lib/observability/record.ts — createRecorder(deps) (DI: sink/publish/notify/now/newId) → {recordEvent, withSpan, flush}. AsyncLocalStorage carries the active span so nested work auto-correlates. withSpan records ONE row at completion (status+duration) and RE-THROWS fn's error; recordEvent is a sync enqueue. Non-interference invariant is tested: a throwing sink is swallowed, never propagated. Redaction is wired centrally in build() via safeSanitize. The wired singleton (recorder + withSpan/recordEvent/captureEnabled exports) has a DB-insert sink, publishes one `activity` live signal per flush, and routes error rows to the email digester. server/plugins/observe-flush.ts starts a 1s unref'd flush loop."
  - "server/lib/observability/redact.ts — truncate/sanitizeRequest/sanitizeResponse (drop secret keys, collapse embedding vectors to {dim,count}, cap blob sizes). Wired at the recorder choke point so every seam is covered."
  - "server/lib/observability/config.ts + types.ts — ObservabilityConfig (retention windows, per-kind capture toggles, badge/toast/email alert config) in the settings table under key 'observability_config'; zod-validated; redactObsConfig strips the Resend apiKeyEnc → hasKey."
  - "server/lib/observability/notify.ts + email.ts — shouldNotify (severity gate) + buildDigest (coalesce N errors→1) + createEmailDigester (one email per digestWindowMin window). Resend via minimal REST $fetch; key decrypted at send via ai/registry/crypto.ts."
  - "Six emit seams: withFailoverOver (model attempt rows + :all-failed) in resolve.ts; the agent reasoning loop in agent/run.ts (attempt rows); the agent tool wrapper in agent/ai-tools.ts (tool rows); the 4 cron tasks (job span + :summary); enrichment.ts (parse-failed/queued/doc-error structured rows, replacing the swallowed console.warn); and server/plugins/observe-requests.ts (flat inbound rows, metadata-only, self-logging loop avoided via SKIP_PREFIXES incl. /api/activity + /api/events)."
  - "server/services/activity.ts — buildActivityFilters (pure, tested), listActivity (filtered+paginated), getActivityTrace (row + all trace siblings), countErrors ({unacked, latest}), ackActivity/ackAllErrors, pruneCutoffs (pure, tested) + pruneActivity (SEVERITY-tiered deletes + maxRows OFFSET cap)."
  - "server/tasks/prune-activity-log.ts + nuxt.config scheduledTasks '0 3 * * *' — daily tiered retention prune (self-logged via a job span)."
  - "API: GET /api/activity (list), GET /api/activity/[id] (trace), GET /api/activity/count, POST /api/activity/[id]/ack, POST /api/activity/ack-all; GET|PUT /api/settings/observability-config (redacted read, write-only key with apiKey/keep/null union)."
  - "Live + UI: 'activity' added to the ResourceName union + a live-dispatch override (list+count invalidation). app/composables/useActivityLog.ts + useObservabilityConfig.ts. app/pages/activity/index.vue (live list with TRUE pause (freezes displayed rows), kind/status/text filters, Ack-all) + [id].vue (nested trace tree, per-row Ack, request/response/error/meta JSON). app/components/settings/ActivityAlertsTab.vue + a new /settings tab. app/layouts/default.vue: Activity nav item + unacked-error badge + new-error toast — badge AND toast are gated by the alerts.badge/alerts.toast config flags; the toast is de-duped by the latest error's timestamp so acking the top error doesn't re-toast an older one."
  - "Gates: pnpm typecheck=0, pnpm test=250 (was 223; +27 across obs-redact/config/record/notify/failover/activity-where/prune + live-dispatch additions), pnpm build OK, pnpm db:migrate applied. 23 commits on master (work was done directly on master per Tony's explicit choice — no feature branch)."
deferred:
  - "Model request/response BODY capture: the actual chat prompt + assistant completion are NOT stored yet — only attempt-level metadata, errors, and the :all-failed cause are. So 'was there an error / did it get sent' is fully answerable; 'what exactly did the model return on a SUCCESSFUL call' is not (errors are). The redaction layer is already wired at the choke point, so adding body capture (e.g. emit a `model` row from chat()/run.ts carrying sanitized request+response) is a small fast-follow — this is the highest-value next increment."
  - "Happy-path `model` parent span: withFailoverOver emits only `attempt` rows on success (a `model` row only on chain exhaustion), so successful attempts render as siblings under the active job span rather than nested under a `model` node. The trace tree still groups correctly by trace_id; it's just flatter than the spec's headline example on the success path. Wrapping the failover loop in a withSpan('model', …) would nest them — deferred because it's hot-path surgery best done with the body-capture change above."
  - "Single completion row (no separate in-flight `running` row, by design — avoids update-by-id churn in a buffered logger). Inbound rows are flat (not parents of the work they trigger; ALS-wrapping the Nitro handler is the future seam). Per-user event scoping not built (single-user app)."
  - "Live E2E with the real homelab rigs is PENDING USER ACCEPTANCE (see below). All static gates (typecheck/test/build/migrate) are green; the dev-server smoke run was not executed here to avoid disrupting Tony's running dev session."
  - "`debug` severity is declared but never emitted (vestigial). captureEnabled('inbound') awaits a cached config read per response (cheap after first load). Prune row-cap uses an OFFSET delete (fine at this scale; revisit if the table ever gets very large)."
---

# Activity Log — cycle 22 handover

## What this is
A centralized, live, queryable observability ledger answering the three recurring questions —
*"Did that get sent to the model?"*, *"What did the model return?"*, *"Was there an error?"* —
that previously had no surface (errors were swallowed into `console.warn`). Built brainstorm →
spec → plan → subagent-driven build, 23 commits, all on `master`.

See [`../wiki/activity-log.md`](../wiki/activity-log.md) for how it works today.

## Decisions Tony locked during brainstorm
1. **Breadth:** the broadest scope — inbound + jobs + model (per attempt) + agent tools. A true
   "everything the system did" ledger.
2. **Retention:** keep all, tiered prune (14d info / 90d error / 500k row cap), tunable in settings.
3. **Alerts:** badge + toast + Resend email, all configurable; email severity-gated + windowed.
   (This also stood up Resend, closing the long-open "Email (ReSend) not built" backlog item.)
4. **Live UI:** ride the cycle-21 live-data convention (no second SSE channel).
5. **Workspace:** Tony explicitly chose to commit directly to `master` (no feature branch).

## Build notes
- One ordering fix during execution: the recorder's `publishChange({resource:'activity'})`
  needs `'activity'` in the `ResourceName` union, so Task 16 (register the live resource) was
  pulled ahead of Task 7 (wire the singleton).
- A final opus review found real gaps; all must-fixes were applied before this handover:
  redaction was wired at the choke point (it had been dead code), the prune was re-keyed from
  `status` to `severity` (spec intent), the agent reasoning loop got instrumented (it had been
  invisible), `runInTrace` dead code removed, the inbound skip-prefix query-string bug fixed,
  the alert toggles are now honored client-side, the toast is de-duped, and Pause now truly
  freezes the tail. The two design-level under-deliveries (model body capture, happy-path model
  parent span) are documented above as deferred, not silently dropped.

## Pending user acceptance — recommended live smoke (dev server)
Static gates are green; please validate against the real rigs:
1. Trigger `enrich-input` (`POST /_nitro/tasks/enrich-input` or wait for the schedule) → a
   `job enrich-input` row appears live on `/activity` (no reload), with a `:summary` child.
2. Click it → the detail page shows the nested trace (job → reasoning attempt rows).
3. Point a reasoning provider's baseURL at a bad host in `/settings`, save, trigger again → an
   `:all-failed`/`:doc-error` **error** row appears, the sidebar **Activity badge** increments,
   and a **toast** pops on another page. Restore the provider.
4. In `/settings → Activity & Alerts`: enable email with a Resend key + recipient, force an
   error, confirm one digest email arrives within the window; then toggle off. Toggle
   `capture.embeddings`/`model` off and confirm those rows stop.
5. Confirm **Pause** holds the list steady while new rows are being written, and **Ack all**
   clears the badge.

## Where the next seam is
**Model body capture** is the highest-value fast-follow: emit a `model`-kind row from
`chat()` (and the agent `run.ts`) carrying the sanitized request messages + assistant
completion, wrapping the attempt rows underneath it — this both answers "what did the model
return?" fully and delivers the spec's nested model→attempts trace on the happy path. The
redaction + recorder plumbing is already in place for it.
