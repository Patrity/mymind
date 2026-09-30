---
title: Bridget reliability pass — one active run per job, crash-safe fires, interrupted runs count, Stop beats 👍, outbox off the tick, unsatisfiable active_hours rejected
cycle: 75b (unplanned follow-on to 74/75)
date: 2026-09-29
status: built
branch: fix/bridget-reliability (worktree .claude/worktrees/reliability, base bb8e5b9)
merged: false
deployed: false
specs: []  # in-chat design approved 2026-09-29; briefs in .superpowers/sdd/2026-09-29-reliability/task-{1,2,3}-brief.md
plans: []
wiki:
  - ../wiki/agent-jobs.md
  - ../wiki/channels.md
  - ../wiki/agent-runtime.md
migrations:
  - 0059 unique index agent_runs_one_active_per_job (job_id where status in queued/running); agent_job_fires.run_id (fk agent_runs, on delete set null)
  - 0060 agent_jobs.fire_failures integer not null default 0
  - 0061 channel_deliveries.seq bigserial not null (claim-order tiebreak)
  - 0062 index agent_runs_job_created_idx on agent_runs(job_id, created_at) (final review M5)
migrations_run_on_prod: false  # 0059-0062 applied on the shared dev DB only; prod is at 0058 (cycles 74 + 75 deployed 2026-09-29 by CD 36506477530 + 36511966371)
prod_precheck_0059: passed  # no prod job has more than one queued/running run (4 job runs total), so the unique index applies cleanly
seed_jobs_enabled: false  # unchanged; the four seeds and the /jobs templates pass the new active_hours check (tested)
final_review: fixed  # whole-branch review 0 C / 1 I / 7 M; I1 and M1-M7 all fixed in one fix wave (.superpowers/sdd/2026-09-29-reliability/final-fix-report.md)
mymind_task: 8e66ffd0-a94f-4017-a9a1-99deea55c7bb  # tracked under the cycle 75 task
---

# Reliability pass: Bridget jobs and channels

Cycles 74 and 75 shipped with a known list of reliability gaps. A job could run twice. A fire
could be lost to a crash. A run killed by a restart never counted against its job. A Stop could
lose to a 👍 arriving at the same moment. A slow BlueBubbles host could stall every other
background task. Those gaps mattered less while job results stayed in the app, but now they reach
Tony's phone. This pass closes them in three tasks, built subagent-driven on
`fix/bridget-reliability`.

## What shipped

### Task 1: one active run per job, crash-safe fires (c499ed8, 79f2ff3)

- **The database enforces one active run per job.** Migration 0059 adds a partial unique index,
  `agent_runs_one_active_per_job`, on `job_id` where the status is `queued` or `running`. Every
  fire path keeps its `hasActiveRun` pre-check as a fast path. A fire that races past the
  pre-check fails its run insert with 23505. `fireJob` returns `{ overlap: true }`, and each path
  handles that as its ordinary overlap skip:
  - every/cron jobs → `skipped`;
  - `at` jobs → disabled with the "its previous run was still going" note;
  - `runJobNow` and `run_job` → `{ skipped: 'overlap' }`;
  - event jobs → the fire key is released.
- **A failed `at` wake is retried, up to a cap.** The claim is undone: `fired_at` is cleared and
  `next_run_at` goes back to the at instant, so the next tick retries. Each failure increments
  `agent_jobs.fire_failures` (migration 0060). The 5th failure disables the job and posts the
  did-not-fire note ("waking it failed 5 times in a row (…)"). The count resets whenever a run is
  created, and when a human or the agent re-arms the job with a future time.
- **A failed event wake releases its fire rows.** The rows are deleted so the key can fire again,
  `last_outcome` becomes `failed`, and `last_run_at` is stamped, so `task.due` waits out the
  5-minute gap before retrying. On success, the new `agent_job_fires.run_id` records the run.
- **Crash sweep.** `sweepCrashedFires()` runs first in every unscoped `workerTick`. It repairs
  what a crash between a fire's commit and its wake left behind, in two cases:
  - An enabled `at` job with `fired_at` set, where `fired_at` is more than 2 minutes old and no
    run of the job has been created since. The sweep re-arms it, and each re-arm counts toward the
    5-failure cap.
  - An event fire row with no `run_id`, between 2 minutes and 24 hours old, where no run of the job
    has been created since. The sweep deletes it.

  The sweep's UPDATE re-checks every condition, staleness included.

### Task 2: interrupted runs, Stop beats 👍, the outbox off the tick (9cce477, 41948fd, 533e4ff, 9998eba)

- **Interrupted job runs count as failures.** `recoverOnBoot` and `recoverStale` report every
  recovered job run to `onRunFinished` as `failed` ("interrupted by a restart"). `last_outcome`,
  the streak and the 3-strike auto-disable all move. Tony's Stop is never recovered, because it
  ends `aborted` in its own process, so it still does not count.
- **Stop always beats a late 👍.** On abort, the approval wait resolves `denied` synchronously,
  before any DB write, so a 👍 landing at the same moment cannot flip it, and the exec never runs.
  `denyOnAbort` then settles the row in the background, moving it from `pending` **or `approved`**
  to `denied`. The audit row therefore agrees with the run.
- **The outbox runs off the worker tick.** `startDeliveries()` starts `deliveriesTick` without
  awaiting it, and it is single-flight: a tick that finds a batch still sending starts nothing.
  Claimed rows are grouped by `channel + target`:
  - groups send concurrently (`Promise.allSettled`);
  - rows within a group send one at a time, in claim order.

  Claim order is `(next_attempt_at, seq)`. `seq` is a new bigserial column (migration 0061) that
  breaks the tie between rows inserted in one transaction. This keeps a text ahead of the images
  split from it.

### Task 3: unsatisfiable `active_hours` rejected on write (8884a08)

- `activeHoursNeverMatchError(spec)` in `schedule.ts` checks a cron/every job that has
  `active_hours`. If `nextFireTimes(spec, 1)` is empty within the 366-day horizon, it returns
  "active_hours: the schedule never fires inside <start>-<end>".
- `writeJob` throws that message as a `JobValidationError`, for enabled and disabled jobs alike.
  `writeJob` is the path for create, save, enable, revert and restore. The API returns it as a
  400, and the agent tools return it as `ok:false`.
- `at` and event jobs are exempt. Boot `revalidateAll` does not run the check.
- One guard beyond the brief: a schedule that has no fire time in the horizon **even without the
  hours** (for example `0 9 29 2 *`, every 29 February) is not blamed on the window. It still
  saves, as it did before. Without the guard, such a job would be rejected with a message naming
  a window that isn't the cause.
- Tests: pure tests in `test/jobs-schedule.test.ts` (cron, monthly cron, empty window, the
  wrapping window, exemptions, 29 February, and all 4 seeds plus the 4 `/jobs` templates), and
  scoped DB tests in `test/jobs-store.db.test.ts` (create enabled and disabled, save, and an `at`
  job outside the hours).

## Gates (on 8884a08)

- `pnpm test`: 280 files, 2752 passed, 1 skipped.
- `pnpm test:db` (full suite): 65 files, 646 passed.
- `pnpm typecheck`: exit 0.
- `pnpm build`: passes.
- Shared dev DB, real rows before and after the gate runs are identical: 4 jobs (0 enabled),
  42 agent_runs, 0 fires, 0 deliveries, 25 conversations, 146 messages, 30 revisions. No test rows
  are left.

Mutation evidence for each task is in its report under `.superpowers/sdd/2026-09-29-reliability/`.

## Final review fix wave (1f90ed1, 7e67bcd, 2a3aa65, 7cc8e81, plus this docs commit)

The whole-branch review found 0 C / 1 I / 7 M. One wave fixed all of them:

- **I1:** a crash between a fired `at` job's run and its self-disable left it enabled forever
  (never pruned, holding a slot toward the 50 cap). The crash sweep now also turns off an
  enabled `at` job with a stale `fired_at` whose run exists since. It posts no note, because it
  did fire. The disable is pinned to the content hash the sweep read (`setJobEnabled(…, expectedHash)`),
  so a re-arm since wins. `sweepCrashedFires` returns `disabled: string[]`.
- **M1:** after a crash mid-send, a chat's later rows went out before the interrupted row that
  waited 2 min to be reclaimed. The claim now skips a `pending` row while any row of its chat
  (`channel + target`) is `sending`.
- **M2:** re-arming an `at` job deletes its `at:not-fired` marker in the same transaction, so a
  re-armed reminder that gives up again posts its note. Cycle 74's test 6b asserted the old
  behaviour and now expects one note per arming.
- **M3, M4:** deferred item 4 above and the jobs handover's follow-up 5 are reworded.
- **M5:** migration **0062** adds `agent_runs_job_created_idx (job_id, created_at)` (applied on dev).
- **M6:** the jobs and channels handovers and roadmap rows 74/75 now record the 2026-09-29 deploy
  (CD 36506477530 + 36511966371, prod at 0058, prod `agent_timezone` America/Chicago).
- **M7:** the jobs wiki's Known limits say to turn off a legacy unsatisfiable job with the enable
  switch, not the editor.

Gates on the wave: `pnpm test` 280 files, 2752 passed, 1 skipped; `pnpm test:db` 65 files, 650
passed; `pnpm typecheck` and `pnpm build` exit 0. Every behaviour fix was mutation-checked (the
fix broken one file at a time, the test went red, restored with `git checkout`). Details:
`.superpowers/sdd/2026-09-29-reliability/final-fix-report.md`.

## Rulings (from the SDD ledger)

1. `fired_at` serves as the sweep clock. The sweep uses a 24 h window, and it keeps a fire row
   when the job has run since. Cost if wrong: an orphan older than 24 h is never re-fired.
2. An `at` job whose wake keeps throwing must not retry every 5 s forever. After 5 consecutive
   failed wakes it is disabled with the did-not-fire note. Cost if wrong: a reminder gives up
   after about 25 s of wake failures.
3. The retry count is a persistent counter, `agent_jobs.fire_failures` (new migration 0060,
   because 0059 was already applied on dev). It is incremented on each failed wake **and** on each
   sweep re-arm, and reset when a run is created. At 5, the job is disabled with the note. The
   same fix round added three things:
   - the sweep's UPDATE re-checks `fired_at < stale`, so a job cannot be re-armed twice;
   - a `task.due` wake that throws stamps `last_run_at`, so the 5-minute gap throttles retries;
   - the count also resets when an `at` job is re-armed with a future time (an implementer
     addition).
4. Concurrent sends must keep per-chat order. They are concurrent across targets and serial, in
   claim order, within a target. Cost if wrong: none.
5. When Stop resolves a wait as denied, the audit row must end `denied` even if a 👍 wrote
   `approved` first. The abort's update matches `pending` or `approved` for that approval id.
   Cost if wrong: none.
6. Migration 0061 is accepted. It is additive and gives a deterministic text-before-images order.
   Cost if wrong: one extra column.
7. Parked: a text that fails with a retryable error still lets its image rows arrive first,
   because retries are per row. Cost if wrong: a photo before its caption on a flaky send.
8. Task 3 (implementer call, flagged for review): a schedule with no fire time in the horizon
   even without its hours is not rejected (see Task 3 above).

## Deferred and parked (follow-ups)

From Task 1:
1. **An overlap on an isolated job's first-ever fire can leave an empty thread.** `enqueue`
   resolves the session before `createRun`. This is the same shape as the existing wiki limit.
2. **The sweep wiring is untested.** Removing the `sweepCrashedFires()` call from `workerTick`
   leaves every test green, as with the `jobsTick`/`dueTaskEvents` calls. The unscoped tick is
   never run against the shared dev DB. The wiring was confirmed by reading the code.
   **Follow-up task (final review ruling):** a pure test that mocks `../jobs/tick` and asserts
   the unscoped `workerTick` calls `sweepCrashedFires` before `jobsTick`, without touching the DB.
3. **Test log noise.** The wake-failure and sweep tests print the expected
   `console.error`/`console.warn` lines.
4. **The first sweep on prod** deletes an event fire row from the last 24 h only when it has no
   `run_id` AND no run of its job was created since: a fire whose wake never produced a run.
   Rows written before 0059 have no `run_id`, so the "no run since" check is what keeps a
   pre-0059 fire that did run. A deleted `task.due` row would re-fire. Prod has no enabled event jobs (all jobs are
   disabled), so there is nothing to re-fire today.
5. **Undo race.** A concurrent `fireEvent` for the same key that lost the insert gives up and does
   not retry after the failed wake's undo. A `cc.session_end` lost this way is not digested. This
   is the same shape as the existing pre-check skip.
6. **A `cc.session_end` lost to a crash** cannot be re-fired, because the payload is gone. The
   sweep only frees its key for a redelivery.

From Task 2:
7. **A Stop pressed just before a crash counts as a failure.** If the process dies before
   `finishRun` writes `aborted`, or Stop hits a run whose owner is already dead, recovery counts
   the run. Both windows are narrow.
8. **Tight wall-clock bounds in the outbox tests** (`< 1000` ms and `< 1500` ms) are the likeliest
   flakes under load.
9. **Worst-case single-flight hold ≈ the largest same-chat group × 15 s** (the adapter timeout).
   It is bounded but can span several ticks. The channels handover's follow-up 6 (a slow batch vs
   the 2-min reclaim) still applies within one chat.
10. **Photo before caption on a flaky send** (ruling 7). Its crash-reclaim cousin (a chat's later
    rows overtaking a row stuck `sending`, final review M1) is fixed: the claim skips a chat
    while any of its rows is `sending`.
11. **The claim-order re-sort and the `seq` tiebreak are defensive.** Postgres returned
    `RETURNING` rows in picked order in every run, so no test proves them.

From Task 3:
12. **Jobs stored before this check** whose hours can never match keep `next_run_at = null` until
    their next save, which will now be rejected until the hours or trigger are fixed.
    `revalidateAll` deliberately does not re-check. The page still shows "no fire time falls
    within active_hours" for them.

Also:
13. **MyMind task and wiki mirror** for `agent-jobs`, `channels` and `agent-runtime`: the pass is
    tracked under the cycle 75 task (`mymind_task` above); the wiki mirror is left to the
    controller.

## Earlier follow-ups this resolves

- Jobs handover ([2026-09-28-bridget-jobs.md](2026-09-28-bridget-jobs.md)): follow-ups **1**
  (unsatisfiable `active_hours`), **3** (interrupted runs leave `last_outcome` stale), **4**
  (at-most-once across a crash) and **5** (the `runJobNow` race). Each is marked resolved there.
- Channels handover ([2026-09-28-bridget-channels.md](2026-09-28-bridget-channels.md)):
  follow-up 14's **M3** (slow sends stall the worker tick) and the final re-review's **Stop / 👍
  race**. Both are marked resolved there.

## Deploying (when merged; the controller deploys)

1. Take a pre-deploy dump to `/root/db-backups`, gzipped (not `/opt/mymind`, which CD wipes).
2. CD applies **0059, 0060, 0061 and 0062** on top of prod's 0058.
   - **0059's pre-check is done.** No prod job has more than one queued or running run (4 job runs
     in total), so the unique index builds cleanly. If the deploy is delayed, re-run the check:
     `select job_id, count(*) from agent_runs where job_id is not null and status in ('queued','running') group by job_id having count(*) > 1;`
     It must return no rows.
   - 0060, 0061 and 0062 are additive. 0062 is a plain `CREATE INDEX` on `agent_runs(job_id,
     created_at)`, a brief lock on a small table. 0061 adds a `bigserial` column to the populated
     `channel_deliveries`, which fills existing rows from the new sequence.
3. After boot, check the journal for `[jobs]` sweep lines on the first ticks. Deferred item 4 is
   the only expected one-time effect, and prod has no enabled event jobs.
4. Nothing to configure. The four seeds and the templates pass the new `active_hours` check.

**Rolling back:** the four migrations are additive, and a 75 build runs with them in place:
- It ignores `run_id`, `fire_failures`, `seq` and the 0062 index. `seq` fills itself on insert.
- The index would turn a lost fire race into a raw insert error in the old code instead of a
  second run. To remove that, run `drop index agent_runs_one_active_per_job;`.

## Where the next cycle starts

- Merge `fix/bridget-reliability`, deploy, then run the channels real-phone checklist (still
  owed).
- Cycle 76 (self-improvement) is next on the roadmap. The open reliability edges are follow-ups
  1, 4, 7 and 9 above.
