---
title: Coordinator — child workstreams, a `subagents` model class, per-model in-flight pools, budget-governed fan-out (cycle 83, harness step 4)
cycle: 83
date: 2026-10-12
status: deployed  # 2026-10-12 CD 38255467372; Tony UI fan-out acceptance pending
branch: feat/coordinator (worktree .claude/worktrees/feat+sandbox, base 6fe0595)
merged: true  # ff to master c973a52
deployed: true  # CD run 38255467372 (2026-10-12)
specs:
  - ../superpowers/specs/2026-10-12-coordinator-design.md
plans:
  - ../superpowers/plans/2026-10-12-coordinator.md
wiki:
  - ../wiki/workstreams.md
  - ../wiki/ai-providers.md
  - ../wiki/agent.md
  - ../wiki/agent-runtime.md
migrations:
  - 0077 workstreams.parent_id, model_label, workspace_mode, tree_budget, tree_used, tainted
  - 0078 workstreams.is_child, lifecycle_noted
  - 0079 workstreams.tree_away_at
  - 0080 workstream_question_tags
next: harness step 5 — judge (spec §9: out of scope here, along with depth > 1, eval/optimizer, Mac mini host move, cross-host workers, dollar budgets)
---

# Coordinator (cycle 83)

Any workstream can now **orchestrate**: split a goal, spawn child workstreams that run in
parallel, wait for them, read/steer/cancel them, and merge their results — governed by budget and
per-model concurrency, not a headcount cap. This closes harness step 4. Current-state reference:
[`wiki/workstreams.md` § Coordinator](../wiki/workstreams.md#coordinator-cycle-83).

## What shipped, by task and fix round

**Task 1 — `subagents` model class + per-model in-flight pools** (`b9e60e6`, fix round `7e6418f`):
`USAGES` gains `subagents`; `ModelDef` gains `description`/`maxInFlight`; `resolveSubagentModel`/
`listSubagentModels` (registry/resolve.ts); a pool is the live count of `running`
`kind='workstream'` `agent_runs` rows per `model_def_id`, enforced in `claimNextRun` under one
global advisory lock, FIFO overflow, chat/wakes never pooled; `segmentPrimaryModelId` stamps the
pool key once at enqueue. The fix round dropped the shipped default from the brief's 16 to **6**
(the vLLM ramp's measured knee was 8–10; see below), added save-time `subagentsProblems` (duplicate
labels, embedding models barred from `subagents`), and made the concurrent-claimers test
deterministic with a barrier seam.

**Task 2 — Coordinator core** (`b0b8a98`, `cd3bb5c`, `955730d`, `efe346a`; fix round 1 `2104a19`/
`6acbe16`/`d6e72b1`; fix round 2 `40a459c`/`185e634`; fix round 3 `9527f83`): migration 0077
(`parent_id`, `model_label`, `workspace_mode`, `tree_budget`, `tree_used`, `tainted`); the
`coordinator` toolset (`spawn_workstreams`/`wait_for_workstreams`/`read_workstream`/
`steer_workstream`/`answer_child`/`cancel_workstreams`) and child-side `export_to_coordinator`;
spawn validation (depth 1, ≤ 50/call, labels, all-or-nothing tree reservation); wait/park/wake
(works like `watch` — no segment, no wall clock while parked); `ask_tony` routing to the
coordinator first, escalation to Tony when the coordinator is itself held; taint propagation (D9);
the top-level cap (`MAX_ACTIVE_WORKSTREAMS`) deleted outright. Fix round 1 added migration 0078
(`is_child`, `lifecycle_noted`) and state-only lifecycle notes (S1), fixed a wake report that could
be dropped, and capped the child export's uncompressed size. Fix round 2 made Tony's own typed
words **always** persist as his own user row (never folded into a child report), indented
child-authored text in reports so it can never forge a label, and closed an export bypass (sparse
archive members). Fix round 3 closed a second export bypass (owner-name size spoofing via
`--numeric-owner`) and made an unread steered report never park the coordinator.

**Task 3 — coordinator UI** (`b814b93`, `1e4ae44`; fix round `92aa6cd`/`2651a98`): the Children
panel (tree budget meter, per-child Steer/Cancel), `/workstreams` nested under its coordinator,
`GET /api/workstreams/:id/children`, report rows (`ReportCard.vue`, escaped-plain-text-only) and
lifecycle rows (`LifecycleRow.vue`) in the log. The fix round bounded the embedded children list
(20 per coordinator + `childCount`, full list paged via `:id/children`) and moved the tree-budget
formula into one shared module (`packages/core/src/shared/types/workstreams.ts`) so the core's
spawn/resume checks and the UI's meter can never drift apart.

**Final fix wave — controller-dispatched, one wave, 12 commits** (`336c779` … `ae1d607`, base
`2651a98`): every Important finding (I1–I4) and every Minor (M1–M7) from the whole-branch final
review, plus every item parked across the three task reviews. See
[Deviations](#deviations-from-the-spec-and-key-rulings) below for what each one changed.

## Commits

28 commits, base `6fe0595` → HEAD `ae1d607`, branch `feat/coordinator`. In order:

```
b9e60e6 feat(ai): subagents model class and per-model in-flight pools
7e6418f fix(ai): pool default 6, unique non-embedding subagents, deterministic claim-lock test, inline max-in-flight error
b0b8a98 feat(workstreams): coordinator toolset, child workstreams, tree budgets
cd3bb5c test(workstreams): deterministic spawn-race barrier, stale-wait guard, tar refusal cause
955730d test(workstreams): match error text with expect.stringMatching (a bare RegExp in toMatchObject matches nothing)
efe346a test(workstreams): clean up every level of a coordinator tree
2104a19 fix(workstreams): coordinator fix round 1 — is_child, lifecycle notes, wake reports never dropped, export size cap, taint/park fixes
6acbe16 fix(workstreams): track orphaned children in the coordinator test cleanup
d6e72b1 fix(workstreams): key the pool-hook unit fixtures on isChild
40a459c fix(workstreams): Tony's words always his own user row, child report text indented, reports steered into running segments, tree-locked thread delete, sparse-safe export
185e634 fix(workstreams): pin the inbox drain contract (reports never drained as typed steers)
9527f83 fix(workstreams): unread steered reports never park a coordinator, same-connection appends under the claim lock, transactional leftover reports, numeric-owner export listing with an entry cap
b814b93 feat(workstreams): children panel and nested workstream list
1e4ae44 test(workstreams): pin the coordinator-always-live rule of the tree meter
92aa6cd fix(workstreams): bounded children in the list (20 per coordinator + childCount), paged children route, one shared tree budget formula
2651a98 test(workstreams): pin the children route's page-size clamp
336c779 fix(workstreams): the tree budget counts children's steps only; start_workstream takes a coordinator's treeBudget
d446673 fix(workstreams): children do not pre-load the workspace unless their spawn spec lists it
83677ee fix(workstreams): cap child text in wake reports and wait results; read_workstream pages the full summary
2f95595 fix(workstreams): tag question iMessages (#k) and route a reply by its tag, else to the most recently notified question
243d869 fix(workstreams): a coordinator's words in its child's thread are a Coordinator row, after the question they answer
b1ba317 fix(workstreams): finish while every remaining child is being cancelled; child notes wait for any run in the coordinator's thread
9e082b4 fix(workstreams): one away text per coordinator tree per 10 minutes; nudges per tree
c91cef8 fix(workstreams): a child's question counts as shown only once its report is durably read
5252b9c fix(ui): debounce the workstream list's live refetch (700 ms); the detail stays immediate
1fd795d fix(workstreams): a child's DTO names the model it resolves to; Children panel shows it instead of "default model"
fed6810 test(sandbox): explicit 30 s timeout for the network jump-repair test (flaky at 5 s under load)
ae1d607 docs(workstreams): wiki iMessage routing and per-tree away texts; backlog M6 and the read-replay cap
```

(`6fe0595` itself is the plan commit — no code. `ae1d607` is a partial wiki update dispatched in
parallel with the final fix wave's re-review; this handover's own commit integrates with it rather
than duplicating it, per the controller brief.)

## Test counts

| Gate | Before (base `6fe0595`, = cycle 82's final state) | After (HEAD `ae1d607`) |
|---|---|---|
| `pnpm test` | 3976 passed / 1 skipped (363 files) | **4042 passed / 1 skipped** (366 files) |
| `pnpm test:db` | 1028 passed (93 files) | **1116 passed** (96 files) |
| `pnpm typecheck` | green | green |
| `pnpm build` + worker build + `stage.mjs` | — | green ("Build complete!", worker bundle ~14.6 MB, "all externals load") |

Every task and fix round ran its own mutation checks (12 in Task 1 + 5 in its fix round, 37 in
Task 2 + 24/11/11 across its three fix rounds, 12 in Task 3 + 11 in its fix round, 22 in the final
fix wave — all reported KILLED, restored with `git checkout --`, never stashed), each run after a
commit and restored before the next. Full per-mutation tables are in the task reports and
`final-fix-report.md`.

## Migrations

- **0077** (`amazing_chameleon`) — `workstreams` gains `parent_id` (self-FK, `ON DELETE SET NULL`,
  indexed), `model_label`, `workspace_mode` (default `'own'`), `tree_budget`/`tree_used` (jsonb),
  `tainted` (boolean, default `false`). Additive; nullable or defaulted on every column.
- **0078** (`daily_callisto`) — `is_child` (boolean, default `false`, backfilled `true` where
  `parent_id IS NOT NULL`), `lifecycle_noted` (text). Additive.
- **0079** (`tree_away_at`) — `workstreams.tree_away_at` (timestamptz, nullable). Additive.
- **0080** (`workstream_question_tags`) — issued `#k` tags, never reused within 7 days (final re-review N2). Additive.

**Final follow-up (re-review N1–N4, 4e0cbe5, b79ac0e):** watch-park never hides unread child reports (N1); interrupted / card-parked segments un-show leftover questions (N3); monotonic tags, a closed tag gets an "already closed" text and is never rerouted (N2 — the reply still lands in main, so Bridget may also answer it); `claimTreeAway` guarded (N4). Counts 4042/1 unit, 1120 db.

All three are additive and safe on prod-shaped data per the final review: existing cycle 81/82
workstreams get `is_child=false`, `tree_budget=null`, so no coordinator path ever touches them; a
watch-parked workstream is excluded from `sweepCoordinators` (it requires `tree_budget is not
null`); a queued segment enqueued before the deploy has `model_def_id=null`, so it's simply
unpooled; the `ai_config` doc parses with `subagents: []` and null `description`/`maxInFlight`
(pools default to 6, children run on `reasoning`).

## Deviations from the spec, and key rulings

The spec (§1–§9, + its two dated amendments) sets the intent; code + this handover are what
actually shipped. Where they differ, or where a ruling changed the acceptance math:

1. **Default `maxInFlight` is 6, not the spec's stated 16.** The vLLM ramp (below) measured the
   server's actual batching knee at 8–10 concurrent streams, well under 16; the fix round shipped
   6 — below the knee — so a model's pool being full still leaves ~2 sequences of headroom for
   unpooled chat turns on the same model (ruling C1, Task 1 review).
2. **Tree budget semantics changed shape mid-cycle (final fix wave I1, spec amendment).** Task 2
   shipped the coordinator's own budget reservation *inside* the tree, with wall time summed across
   children as a second tree dimension. At the defaults (tree 2000 steps/8 h active, coordinator's
   own budget 400 steps/2 h, child default 1 h active each) that left 1600 steps but only 6 h of
   active time for children — six 1 h children was the practical ceiling, exactly the spec's
   own "≥ 6" prod-acceptance number. Worse, the final review (I1) found a coordinator **started
   with a large own-budget** (e.g. `maxWallMs: 8h`) would reserve its own budget straight out of the
   tree's wall dimension, leaving **zero** wall time for children — it could never spawn at all. The
   fix: the tree now counts children's **steps only**; the coordinator's own budget and reservation
   are entirely outside it; wall time is not a tree dimension at all (each child is bounded by its
   own `maxWallMs` instead). `start_workstream` gained a `treeBudget: {maxSteps}` param (default
   2000, max 10 000). With defaults, **ten** 200-step children now fit at once, not six. Spec §1/§2
   both carry dated amendments for this.
3. **Three columns the spec's original §2 data model didn't list** (`tainted`, `is_child`,
   `lifecycle_noted`) were added by Task 2, each covered by its own dated spec amendment:
   `tainted` persists D9's "this run read Google content" bit past the point the mail result
   itself leaves a child's history window; `is_child` is needed because `parent_id` goes `NULL`
   the moment a coordinator's row is deleted, and every child rule must survive that; `lifecycle_noted`
   is ruling S1's own dedupe key (one note per child event, ever).
4. **`#k`-tagged iMessage question routing is new** (final fix wave I2) — the spec's D8 text said
   the coordinator "answers or escalates" but never addressed **several** open questions existing
   at once (a coordinator's own `ask_tony` plus an escalated child, say), which the top-level cap's
   removal (D3) made routine rather than rare. `routeInboundAnswer` used to return `null` — dropping
   the reply into main chat — whenever more than one workstream qualified. Fixed by tagging every
   open question with a short `#k` handle; see the spec's new dated amendment and
   [workstreams.md § `ask_tony` routing](../wiki/workstreams.md#ask_tony-routing-and-escalation).
5. **Children no longer preload the `workspace` toolset** (final fix wave I4) — a narrowing of
   cycle 82's blanket "every workstream segment preloads `workspace`" rule. The final review found
   that the pool size of 6 concurrent segments, paired with cycle 82's preload, would make a
   6-child fan-out thrash against `SANDBOX_MAX_RUNNING` (default 2, sized for the OLD 3-workstream
   cap) — containers evicting each other mid-run. The fix: a child gets `workspace` only when its
   spawn spec explicitly lists it. Spec §5's "research children that never use the workspace never
   start one" is true in effect, but only because this cycle added the opt-in gate — without it,
   cycle 82's preload would have started a container for every child regardless of whether it
   touched a file.
6. **Child text is capped in wake reports and wait results** (final fix wave I3) — not in the
   original spec's testing section beyond "taint propagation on read/wait results." A wide fan-out
   with no size bound could blow the coordinator's own context at merge time (a wake report IS the
   next segment's prompt). Shipped: `CHILD_TEXT_CAP` = 1500 chars/field, `CHILD_REPORT_CAP` = 24 000
   chars/report (oldest children collapse to one line past that); `read_workstream` is uncapped,
   paged past 8000 chars. **Not fully closed:** a *replayed* `read`-kind tool result on a later
   segment is still capped at the pre-existing, general `READ_RESULT_CAP` (1500) — "I3 scenario B,"
   logged to the backlog below, not covered by this fix-wave ruling.
7. **A child's control routes (steer, cancel) reuse the top-level routes as-is** (Task 3 concern 1):
   steer requires a web session; cancel stays token-capable, by the cycle-81 ruling that "stopping
   work never widens it" — even though the plan brief's own text read "session-only" for children's
   routes specifically. Not revisited in the final fix wave.
8. **A coordinator's own words in a child's thread are a distinct event row, never Tony's words**
   (final fix wave M2/C4) — `answer_child`/`steer_workstream` write a `coordinator`-origin event,
   rendered as its own "Coordinator" bubble and read by the child's model as
   `[from your coordinator] …`, never with Tony's user-role authority. Not addressed at this level
   of detail by the original spec.

**Not fixed, parked to the backlog** (see below): I3 scenario B (replay cap); parked (b)'s
coverage is incomplete (only the `ask_tony`/attention branch has a dedicated test — `paused`, Stop,
idle-pause and watch-parked endings share the same `unshowLeftover` code path without one of their
own); the I2 single-question `#k` edge case (an unmatched tag still answers the one open question
whole, matching the pre-I2 behaviour, rather than being rejected) only matters once ≥ 2 questions
are open; `sweepCoordinators`'s lifecycle-note flush is O(coordinators × children) every 5 s
(final review M6).

**Rulings accepted as-is** (no code change needed): a coordinator's persisted `tainted` bit doesn't
seed later segments' run taint (follows cycle-79b's existing design); a coordinator with the
`history` toolset can read a tainted child's thread through `search_messages` without taint
(pre-existing cross-thread scope, not a coordinator-specific gap); Tony deleting a child's thread
drops its `used` from the tree (a Tony-only action; rows are the truth by design); the correlated
count subqueries in `claimNextRun` scale with the queued backlog (fine at homelab volume); an
old API client's PUT can still wipe `description`/`maxInFlight` (Task 1 M4).

## The vLLM ramp (Task 1, `scripts/vllm-ramp.ts`)

Run against the dev `reasoning` head (Qwen 3.8 Flash Next) through LiteLLM — concurrent streaming
waves of a fixed prompt, 256 max tokens, 60 s cutoff, stopping when TTFT p95 exceeds 10 s.

Run 1 (levels 1–32; stopped at 24, TTFT p95 11.1 s):

| N | ok | TTFT p50 (s) | TTFT p95 (s) | tok/s/stream p50 | tok/s/stream min | aggregate tok/s | wall (s) |
|---|---|---|---|---|---|---|---|
| 1 | 1/1 | 0.23 | 0.23 | 76.3 | 76.3 | 70.5 | 2.9 |
| 2 | 2/2 | 0.36 | 0.37 | 66.8 | 66.8 | 121.6 | 4.2 |
| 4 | 4/4 | 0.37 | 0.37 | 61.6 | 61.5 | 216.7 | 4.2 |
| 8 | 8/8 | 0.89 | 0.89 | 56.4 | 56.3 | 351.9 | 5.0 |
| 16 | 16/16 | 0.46 | 5.58 | 49.2 | 45.1 | 364.5 | 9.8 |
| 24 | 24/24 | 5.05 | 11.10 | 48.6 | 41.3 | 354.0 | 15.5 |

Run 2 (levels 8–16, to locate the knee):

| N | ok | TTFT p50 (s) | TTFT p95 (s) | tok/s/stream p50 | tok/s/stream min | aggregate tok/s | wall (s) |
|---|---|---|---|---|---|---|---|
| 8 | 8/8 | 0.42 | 0.42 | 55.9 | 55.6 | 370.8 | 4.9 |
| 10 | 10/10 | 0.39 | 4.54 | 52.6 | 52.0 | 286.6 | 7.8 |
| 12 | 12/12 | 0.55 | 5.19 | 52.7 | 49.8 | 312.3 | 8.6 |
| 14 | 14/14 | 0.46 | 5.06 | 52.7 | 49.4 | 336.3 | 9.4 |
| 16 | 16/16 | 0.41 | 5.46 | 50.0 | 45.9 | 365.6 | 9.8 |

**Knee between 8 and 10.** Up to 8 concurrent streams, every one starts in under 1 s and aggregate
throughput peaks (~370 tok/s) — the server batches ~8 sequences. From 10 on, later requests queue a
whole generation (4.5–5.5 s) for a server slot, with no further aggregate gain. The brief called
for a default "just below that knee," which Task 1 initially read as 16; the fix round corrected
the shipped constant to **6** (`DEFAULT_MAX_IN_FLIGHT`), deliberately below 8 so chat keeps
headroom on a fully-pooled model (ruling C1).

## Deploy results (2026-10-12)
- **LXC 114 resized** to 6 cores / 16 GB / 64 GB (`pct set` + `pct resize`, online); `SANDBOX_MAX_RUNNING=4` in `.env.native`; `pct reboot 114`.
- **Cycle 82 persistence probe passed:** after the reboot docker, mymind, mymind-worker and mymind-sandbox-net came back active; `-A FORWARD -j DOCKER-USER` first; MYMIND-SANDBOX-FWD/-IN present; worker `preflight ok`; every isolation probe still blocked, internet 200.
- **CD 38255467372** green (test + deploy): migrations 0077–0080 applied (81 total), `worker healthy`, `sandbox ok`, `/api/health` 200, 0 worker errors in the first 10 min. `workstreams.is_child`/`parent_id`/`tree_away_at` and `workstream_question_tags` present.
- **Not yet run:** the real ≥ 6-child fan-out and pool-queue probes need a session (start_workstream is session-only) — Tony's UI acceptance.

## Prod acceptance checklist

Adapted from `final-review.md`'s 5 probes, adjusted for the shipped I1/I2/I4 fixes (the review's
own probes assumed the pre-fix-wave state — a 6-child ceiling and a broken iMessage routing path):

1. **Fan-out ≥ 6 children with a merged summary.** With defaults this is now comfortably inside
   the 2000-step tree (ten 200-step children fit) — no need to spawn at exactly the ceiling or pass
   smaller child budgets. Include at least one child that **asks a question** (exercises escalation)
   and one that explicitly lists `"workspace"` in its `toolsets` (exercises I4 — a sandbox should
   start only for that one child).
2. **Pool limits visible in concurrent `agent_runs`.** Needs more than `DEFAULT_MAX_IN_FLIGHT` (6)
   workstream segments on one model at once — spawn ≥ 7 children with small budgets, or temporarily
   lower that model's `maxInFlight` in Settings. Then:
   ```sql
   select model_def_id, count(*) filter (where status='running') r, count(*) filter (where status='queued') q
   from agent_runs where kind='workstream' group by 1;
   ```
3. **Restart the worker mid-tree** (`systemctl restart mymind-worker` while children run and the
   coordinator is parked). Confirm: the coordinator stays `paused{waitingForChildren}`; the
   children's segments come back `queued` and get re-claimed; the coordinator wakes on the first
   tick after the last child ends.
4. **Delete a throwaway coordinator thread with a live child.** The child should be `cancelled`
   within 5 s, with no top-level orphan on `/workstreams`.
5. **Run the I2 flow by iMessage** (now possible — I2 shipped this cycle): get a coordinator into
   `attention{question}` on its own `ask_tony` AND an escalated child question open at the same
   time; confirm each outbound text carries a distinct `#k`; confirm a `#k`-prefixed reply answers
   the right one; confirm an untagged reply answers the most recently notified one; confirm Tony's
   confirmation names which workstream got the reply and lists the other's tag.
6. **Sandbox opt-in (I4).** Confirm a child spawned with no `"workspace"` toolset never starts a
   container (`docker ps` shows none for it), and a child that does list it gets one normally.
7. **Grouped away-iMessage (M4).** With ≥ 2 pending items in one tree (e.g. two children's
   approval cards) while away, confirm exactly **one** iMessage lists both — not two separate texts
   — and that it repeats at most once every 10 minutes.

## Prod prerequisites

- **LXC 114 resize to 6 cores / 16 GB RAM / 64 GB disk**, before this deploy. The per-model pool
  default of 6 concurrent workstream segments admits substantially more parallel sandbox-using work
  than the box was sized for under cycle 82's old 3-workstream cap (2 CPU / 8 GB).
- **`SANDBOX_MAX_RUNNING=4`** after the resize (still deliberately below the pool size of 6 — not
  every segment needs a sandbox now that children opt in per-child, per I4, but headroom stays
  tight; re-tune after real fan-out load is observed).
- Back up the DB first (`/root/db-backups`, gzipped, per the prod-backups memory); run `df` before
  deploying (the prod disk incident memory).
- After deploy, check `activity_log` for attempt-0 errors during the acceptance run if prod's
  `reasoning` head differs from the model the ramp measured — failover only advances on a throw,
  so a misrouted chain head can hide behind a working fallback (the "failover masks routing bugs"
  memory).

## Backlog (added or confirmed this round — see [`docs/BACKLOG.md`](../BACKLOG.md))

- **M6** — `sweepCoordinators` flushes lifecycle notes for every live coordinator every 5 s (a full
  `childrenOf` each, even when nothing changed); do the "pending note" test in SQL instead.
- **I3 scenario B** — a replayed `wait`/`read` tool result on a later segment is still capped at
  the general `READ_RESULT_CAP` (1500), not the new 24 000/1500 wake-report caps; the full summary
  is one live `read_workstream` away but not in replayed history.
- **(b) coverage gaps** — the leftover-report un-show fix is tested and mutation-killed only on the
  `ask_tony`/attention branch; the `paused`, Stop, idle-pause and watch-parked endings share the
  same helper with no dedicated test of their own.
- **I2 single-question tag edge** — with exactly one question open, a reply starting with a
  non-matching `#k` still answers it whole (tag text included), matching the pre-I2 behaviour;
  only matters once ≥ 2 questions are open at once (where it correctly falls through to main).
