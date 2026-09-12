---
title: Transcript ingest poison pill — one oversized line stopped all message ingest for 5 days
cycle: incident
date: 2026-09-11
status: >
  SHIPPED AND VERIFIED IN PROD. Deployed as 8567d1c (CD run 34695584536, test+deploy green,
  2026-09-12 13:20 UTC). Post-deploy: /api/health 200, the setup endpoint serves real JS, and the
  previously-wedged session 27ba72e2 flipped 400 -> 200 and ingested 220 messages. Full macOS
  backfill: **41/41 sessions, 0 failures, 23,275 messages, 267.9 MB**. Every session whose
  transcript exists on the Mac now has messages. Gates at HEAD: typecheck 0 / test 1513 passed
  (182 files) / build clean. REMAINING: run the backfill on the Windows and WSL machines — 113
  prod sessions are still at 0 messages and none of their transcripts are on the Mac.
branch: master
docs:
  - ../wiki/sessions.md (new "Wire limits" section under Ingestion; frontmatter bumped to 2026-09-11)
---

# Transcript ingest poison pill

## Symptom

Reported as "the enrichment service isn't running on prod, and sessions look fucked — a bunch of
0-message sessions."

**Enrichment was never down.** `activity_log` showed 96 `enrich-memories` runs in 24h (newest
01:45), 451 sessions in `mem_enrichment_state` with `status='ok'` and **zero** errors. It had
nothing to enrich. The 0-message sessions were the real signal, and the fault was one layer up.

## Root cause

`server/api/hooks/cc/transcript.post.ts` validated the batch with:

```ts
lines: z.array(z.string().max(100_000)).max(5000)
```

Claude Code JSONL lines routinely exceed 100 KB — one large tool result or file read does it.
Across the local corpus: **1,467 of 363,700 lines (0.403%) are over 100 KB, largest 2.08 MB.**

Zod rejects the **entire batch** on a single oversized element, and `cc-hook.sh` advances its
stored byte offset **only on a 2xx** (deliberately, so deltas are never silently dropped). Those
two correct-in-isolation behaviours compose into a **permanent head-of-line block**: one oversized
line wedges that session's whole stream forever, and every subsequent terminal event re-POSTs the
same doomed payload.

Evidence:

| signal | value |
|---|---|
| `transcript POST failed http=400` in `~/.mymind/cc-hook.log` | **11,545** |
| last `messages` row in prod | `2026-09-07 18:17 UTC` |
| prod sessions with 0 messages | 119 of 723 |
| `~/.mymind/transcript-offsets` last modified | 2026-09-07 |
| `POST /api/hooks/cc/transcript` in 24h `activity_log` | **absent** (while `PreToolUse` ×2259, `PostToolUse` ×2116) |

No deploy happened between 09-04 and the outage, so this was not a bad release — transcripts simply
grew past a fixed threshold. The 400s date back to at least 2026-07-31, which is when `cc-hook`
started logging HTTP status codes; earlier failures were invisible, so the true onset is older.

Controlled probe against live prod, one variable:

| line length | response |
|---|---|
| 99,000 chars | `200 {"ingested":0,"total":0}` |
| 101,000 chars | `400 Bad Request` (`code: too_big, maximum: 100000`) |

## Fix

**1. `server/lib/transcript/ingest-limits.ts` (new).** The per-line cap is gone. The batch is
guarded instead — `MAX_LINES` 50_000, `MAX_BODY_CHARS` 24_000_000 — so a runaway payload still
fails loudly and cheaply. The schema moved out of the route file because Nitro route files cannot
be imported under vitest (`defineEventHandler is not defined`), and the limits needed direct tests.

**2. `clampStrings` in `server/services/transcript-parse.ts`.** Size management moved to the
**parsed** fields: any string over `MAX_FIELD_CHARS` (200_000) is clamped with a
`… [truncated N chars]` marker, at the same choke point as `stripNul`.

> Truncating the raw JSONL line is **not** a valid fix, and this is the trap worth remembering:
> `parseTranscriptLines` does `JSON.parse(line)` inside a try/catch and `continue`s on failure.
> A truncated line is invalid JSON, so it would be skipped silently — the batch would 200 while
> the message vanished. The clamp must happen after the parse.

**3. `server/assets/setup/transcript-backfill.mjs` (new)**, served at
`GET /api/setup/transcript-backfill.mjs` (mirrors the `cc-hook` installers).

## Why a backfill script was required

A server fix alone does **not** recover the backlog, for two reasons:

- `cc-hook` ships only on a terminal event (`Stop`/`SubagentStop`/`SessionEnd`). Of the wedged
  sessions, **most are 7–30+ days dead** and will never fire another hook.
- It ships exactly **one 4 MB window** per event, so even live sessions drain one chunk at a time.

The script walks the local transcripts and **loops** 4 MB chunks until each is caught up. It is
safe to re-run: ingest is idempotent on `(session_id, external_uuid)` for messages and
`(session_id, tool_use_id)` for tool events, both `onConflictDoNothing`.

### Scope correction (important)

The first pass found "324 wedged sessions / 1.54 GB" by globbing every `*.jsonl`. That was wrong.
Of 1,541 local transcript files, **1,484 are `subagents/agent-*.jsonl`** — the filename is an
**agent id, not a session id** (the parent session is the *directory*), and 7 more are Workflow
`journal.jsonl`. Shipping those keyed by filename would have invented ~1,484 junk sessions.

Decisive check: **0 of 188 stored offsets are agent-named** — `cc-hook` has never shipped them, and
enrichment drops sidechain messages anyway. The script therefore only accepts **UUID-named**
top-level transcripts, matching `cc-hook`'s scope exactly.

Corrected figures: **50 session transcripts on disk, 42 with pending bytes, 26 wedged, ~270 MB.**

## Verification

- Regression tests: `test/transcript-oversized.test.ts` (7 tests). Verified non-vacuous by
  restoring the old cap and the old `stripNul`-only mapping — 3 tests go red, then green again.
- Gates at HEAD: **typecheck 0 / test 1513 passed (182 files) / build clean**.
- Script proven live against prod on a non-wedged session: **62 messages ingested**.
- Wedged session against live prod still returns `400 too_big` — confirming the deploy is the gate,
  and confirming offsets are *not* advanced past a failure.

## Outcome

Deployed as `8567d1c` (CD run 34695584536, 2026-09-12 13:20 UTC; `test` and `deploy` both green).

| check | result |
|---|---|
| `/api/health` | 200 `{"ok":true}` |
| `/api/setup/transcript-backfill.mjs` | serves real JS (11,228 bytes), no longer the SPA fallback |
| wedged session `27ba72e2` | **400 → 200**, 220 messages |
| full macOS backfill | **41/41 sessions, 0 failures, 23,275 messages, 267.9 MB** |
| messages clamped by `clampStrings` | 2 — the clamp is surgical, not a blunt instrument |
| zero-message sessions | 119 → 113; **none of the 113 has a transcript on the Mac** |

The remaining 113 are on the Windows/WSL machines or were pruned from disk by Claude Code. Anything
Claude Code has already deleted locally is **unrecoverable** — there is no other copy.

## Remaining

1. Run on the Windows and WSL machines:
   ```
   curl -fsSL https://brain.costanzoclan.com/api/setup/transcript-backfill.mjs -o transcript-backfill.mjs
   node transcript-backfill.mjs --dry-run     # then without the flag
   ```
2. Expect `enrich-memories` to take roughly **8 hours** to catch up (10 sessions per 15-min tick),
   each an LLM call. A slow drain is the design, not a second bug.

## Second poison pill — in the recovery tool itself (fixed)

The Windows run surfaced a variant of the same bug, reintroduced by me in the backfill script.
`readChunk` grows its window when a line has no newline in it, and the growth **doubled past** the
ceiling (4 → 8 → 16 → 32 MB), so it reassembled a 23.8 MB single line and the batch was rejected by
the server's own `MAX_BODY_CHARS` guard. 104 of 105 Windows sessions shipped; `aef771cc` failed.

Fix: clamp growth to `MAX_LINE_BYTES` (20 MB), and when one line still will not fit, **skip it and
advance the offset past it** rather than failing the session. Skipping costs little — the parser
clamps any field to 200_000 chars anyway, so a 24 MB line would have stored at most 200 KB — and
the alternative is the exact head-of-line block this whole incident is about.

Proven with a synthetic transcript (normal line / 25 MB line / normal line): the monster is skipped
with a loud per-line report, and **both** surrounding messages ship. Self-test artifacts were
removed from disk and from the prod DB afterward.

The lesson worth keeping: "reject the batch" and "never advance past unshipped data" are each
defensible alone and catastrophic together. Any component in this path needs a way to give up on
one poisoned element without giving up on the stream.

## Follow-ups worth considering

- `cc-hook` has no way to report a permanently-poisoned payload. A 4xx is currently retried forever
  in effect (once per terminal event). Consider a local "give up after N attempts, log loudly" path
  so a future wire-level rejection surfaces in days, not weeks.
- Nothing alerts on ingest going to zero. `messages` had a 5-day flatline with every liveness hook
  still green — a staleness check on the newest `messages` row would have caught this immediately.
- The 78 `agent-*` rows already in prod `sessions` came from the `[event]` hook path, not the
  transcript path. Unexamined; likely harmless, but they are not real sessions.
