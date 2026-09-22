---
title: "Agent chat affordances — a conversation becomes a tree, and the action row becomes visible (cycle 68)"
cycle: 68
date: 2026-09-21
status: >
  BUILT, NOT MERGED, NOT DEPLOYED. All 11 tasks complete on `feat/chat-affordances`, branched from
  LOCAL master `3a65f2b` — and **this is the first branch in this program cut from a DEPLOYED
  baseline**: master is pushed and live as of 2026-09-21 (cycles 64-67 plus the turn-persistence and
  exec-allowlist hotfixes are in prod). **There is a migration — `0045_busy_solo.sql` — and it has
  NOT been run on prod.** One additive `ALTER TABLE conversations ADD COLUMN active_leaf_id uuid`
  plus a backfill that points every existing thread's leaf at its structural tail; it is
  self-healing and safe to re-run, but until it runs, every prod conversation has a null leaf and
  every read falls back to the flat path — correct, but with no branching.
  **The complaint that started this cycle was "no copy message button, no fork conversation at
  message, missing lots of stuff", and reading the code changed its shape: copy, regenerate, the
  timestamp and a token count ALREADY EXISTED in `ReplyActions.vue`, hidden behind
  `opacity-0 group-hover:opacity-100` — invisible until hover and unreachable on touch. A third of
  the complaint was a DISCOVERABILITY defect, not a feature gap.** The rest finished the branching
  model cycle 28 reserved and deferred: `conversation_messages.parent_id` had been written linearly
  and read by nothing. **Behaviour change worth flagging loudly: retry used to TRUNCATE the thread
  and now BRANCHES** — the previous reply is kept and reachable through a ‹ n/N › pager, and
  `app/lib/agent/retry.ts` (`truncateForRetry`) is deleted. Live-validated in a real browser against
  a real model (Haiku 4.5): **all 10 items PASS**, including a pre-cycle thread resuming untouched
  and the cycle-65 one-WebGL2-canvas invariant. Gates: `pnpm typecheck` exit 0 / `pnpm test` 219
  files, 1,933 tests / `pnpm test:db` 25 files, 246 tests / production build at 4096 MB passes
  (**267 client JS files, 2,112,258 B gzip — no new chunk, +94 B, +0.004%** over cycle 67).
  **The most useful thing in this document is not the feature: it is that five of this cycle's
  findings were tests that could not fail, and every one was caught by deliberately breaking the
  code and watching the test stay green.**
branch: feat/chat-affordances
spec: ../superpowers/specs/2026-09-21-agent-chat-affordances-design.md
plan: ../superpowers/plans/2026-09-21-agent-chat-affordances.md
docs:
  - ../wiki/agent.md (UPDATED — cycle bumped to 68; a cycle-68 header note; two new sections, "The
    conversation tree (cycle 68)" (the leaf column, the one shared `loadActivePath` and why both
    read paths must agree, the one-primitive fork/edit/regenerate table with regenerate's stated
    deviation, branch switching as a server round-trip with the two client-side guards, and four
    named limits) and "The message action row (cycle 68)" (what the row holds, why the pager is not
    the vendored component, and the timing fields with `rateLabel`'s stated tool-wait inaccuracy);
    the conversation-store section rewritten for `active_leaf_id`, the now-read `parent_id` edge,
    `message_count` counting the whole tree and the new service functions; the stale
    `app/lib/agent/retry.ts` reference corrected to record its deletion; the "Branching UI" deferred
    bullet struck through and closed)
  - ../wiki/voice-agent.md (UPDATED — cycle bumped to 68; the frontend files table gains
    `app/lib/agent/metrics.ts` and `app/components/agent/BranchPager.vue`, and its
    `app/lib/agent/retry.ts` row is struck through as deleted — this was the stale wiki reference
    the brief flagged)
  - ../superpowers/plans/00-roadmap.md (UPDATED — cycle 68 row added)
  - ../BACKLOG.md (UPDATED — reconciliation preamble bumped to cycle 68; a new §2 block recording
    what the cycle closes, including cycle 28's deferred branching line, and what it leaves open)
tasks:
  - "No MyMind task was created or updated from inside this cycle — the MCP points at PROD and the
    controller owns that surface. The follow-ups this cycle OWES a task are listed in `deferred:`:
    branching the first turn of a thread (Ruling 22), and the parked concurrent-writer race on the
    leaf (Rulings 8/9)."
shipped:
  - "**The path walk (Task 1, `87273af`)** — `shared/utils/conversation-path.ts`: `activePath(rows,
    leafId)` walks `parent_id` upward from the leaf and returns the path root-first, and
    `branchIndex(rows)` returns each message's 1-based position among its siblings. Pure, zero
    imports, no I/O. Nine tests including a cycle guard and an unknown leaf returning `[]` (the
    caller then falls back to the flat read — a HALF path would be worse than an obvious empty).
    The reviewer broke it three ways and restored each. Recorded because a future reader could
    over-generalise from it: without the cycle guard this walk does not hang, it dies with
    `RangeError: Invalid array length` after ~3.2s — whereas the descent added in Task 5 spins
    forever (2.7e9 hops in 20s), because the descent allocates nothing."
  - "**The leaf column and the backfill (Task 2, `47bb96f` + `cc97215`)** — `0045_busy_solo.sql`:
    one `ALTER TABLE conversations ADD COLUMN active_leaf_id uuid`, plus a hand-appended backfill.
    The backfill identifies each thread's tail **structurally** — the message no other message names
    as parent (`NOT EXISTS`) — after review rejected the first version's `ORDER BY created_at DESC,
    id DESC`: `id` is a random uuid uncorrelated with insertion order, so among messages sharing the
    newest timestamp (cycle 66 measured a 26% collision rate on the sessions `messages` table, and a
    turn writes its user and assistant rows microseconds apart here) it picked a random row, and if
    that row was not the tail its real child would be unreachable from BOTH read paths. An
    `OR EXISTS (leaf has a child)` clause makes it self-healing and re-runnable. `MessageUsage` gains
    `startedAt`/`ttftMs`/`durationMs`; the DTO gains `parentId`, `branch` and `siblingIds`."
  - "**One walk, two readers (Task 3, `837439d` + `f2385cd`)** — `server/services/conversation-path.ts`'s
    `loadActivePath` is now the ONLY place a transcript is resolved, and `getConversation` (the user)
    and `getAgentHistory` (the model) both reduce to the same single call: one query, one where, one
    `orderBy(createdAt, id)`, one column set, no limit, with the null-leaf fallback INSIDE the shared
    function so neither caller can own a different one. This is the cycle's load-bearing task and its
    central property is proven by three independent break-and-restore runs across three agents."
  - "**Writes chain from the leaf (Task 4, `6703805` + `d22cd72`)** — `appendMessages` takes its
    parent from `active_leaf_id` rather than the newest row (once a branch exists those differ), and
    `branchParent(conversationId, messageId, op)` answers where a new branch hangs from: fork → the
    message, edit/regenerate → its parent. The inserts and the leaf move are now ONE transaction: a
    crash between them would leave rows written while the leaf still pointed at the old tail, and
    `loadActivePath` walks straight past those — invisible in both read paths. That failure mode is
    one this cycle CREATES (pre-cycle, the flat read still showed them), which is why it was fixed
    rather than parked with the concurrency race."
  - "**Switching branches (Task 5, `a5a4402` + `25c563b`)** — `PATCH /api/conversations/:id/leaf`,
    plus `branchTip` (renamed from `deepestDescendant`, because that name was a lie: it follows the
    NEWEST child at each step, which is what resuming a branch should do). `setActiveLeaf` descends
    to the tip before writing and returns the RESOLVED id, so the response never claims a leaf it did
    not set; the conversation-scoped row query doubles as the ownership guard."
  - "**Turn timing and the captured leaf (Task 6, `0a0fda4` + `ac2c74b`)** — `ws.ts` stamps
    `startedAt`/`ttftMs`/`durationMs` into the turn's `usage` through one `buildUsageWithTiming()`
    closure used at BOTH persist sites (success and rescue — two copies of that literal is the exact
    shape of this file's one production bug), and captures `active_leaf_id` at turn start
    (`captureTurnLeaf`) so a branch switch mid-turn cannot re-home the turn's messages.
    `app/lib/agent/metrics.ts` formats `durationLabel`/`rateLabel`, guarded with `Number.isFinite`
    because `NaN <= 0` is false."
  - "**The pager (Task 7, `e404020`)** — `app/components/agent/BranchPager.vue`: three plain
    `UButton`s, `v-if=\"total > 1\"` so an unbranched thread has no pager in the DOM, each arrow
    disabled at its own end. The only clean-first-pass task of the cycle."
  - "**The always-visible action row (Task 8, `f3a3168`)** — `opacity-0 group-hover:opacity-100` is
    gone from `ReplyActions.vue`; the row wraps rather than overflowing and holds copy, regenerate,
    edit, fork, the pager, the timestamp, the duration, the tok/s figure and an info button."
  - "**Fork, edit and regenerate as branches (Task 9, `5374231` + `3a4b795`)** — the cycle's largest
    task, where four rulings converge: `branch`/`siblingIds` widened through `agent-ui.ts` and
    `to-ui-messages.ts` (the client transform had been silently dropping them), an optional `op` on
    the leaf route, all three operations routed through one `moveLeaf`, and a CONTROLLED tooltip for
    the details button because reka ignores `pointermove` for touch. Live tok/s was fixed here too —
    the metadata chunk already flowed and simply carried no timing."
  - "**The hero Persona (Task 10, `03ffc9c` + `d32977c`)** — `size-40` → `size-56 sm:size-72`, capped
    by viewport height so a short screen is no worse off than before (measured 77.2% of the disc
    visible at 800×480, against the old size-40's 74.4%)."
  - "**This handover, the wiki, the roadmap and the backlog (Task 11)** — plus the live validation
    below, and the stale `app/lib/agent/retry.ts` reference in `docs/wiki/voice-agent.md` corrected."
deferred:
  - "**Branching the FIRST turn of a thread is unsupported, and the error message is the fix
    (Ruling 22).** `branchParent` returning null is genuinely ambiguous — it means both 'this is a
    root' and 'not found' — and `active_leaf_id = null` already means 'fall back to a flat read', so
    expressing 'start a second root' would change what null means to BOTH read paths, which is too
    much with 246 DB tests resting on it. The endpoint now distinguishes the two cases
    (`conversationHasMessage`) and says *'The first message of a thread cannot be branched yet'*
    instead of claiming the message is not in the conversation. **Verified live in this cycle's
    validation.** Rephrasing an opening question needs a new thread — which is what it needed before
    this cycle too, since editing did not exist at all. Owed a MyMind task."
  - "**The concurrent-writer race on the leaf is PARKED, not fixed (Rulings 8 and 9).** Read leaf →
    insert → write leaf is not serialized: no `SELECT … FOR UPDATE`, no advisory lock, deliberately,
    and the implementer recorded that omission in-file so the transaction added in Task 4 cannot
    later be mistaken for a half-finished attempt at it. It **predates** this cycle (newest-row
    chaining had the identical race) and branching makes its consequence strictly less harmful: the
    losing turn is now reachable through the pager instead of being an unreadable orphan. Measured
    context when the ruling was made: prod's entire `conversation_messages` table is **267 rows**,
    largest thread 14 messages, avg 4.2, single user. (A review line in the ledger pairs '671
    conversations' with '228,692 messages' — the second figure is the **sessions** `messages` table,
    not this one, and the two cannot both describe `conversation_messages`. Neither number was
    re-checked against prod from this branch.) Owed a MyMind task."
  - "**A mid-turn branch switch is overridden when the reply lands (Ruling 12).** The turn's leaf is
    captured at start so its messages attach to the branch it was sent from — the data-integrity
    half — but the leaf then moves to the new reply unconditionally, pulling the user to it. A
    compare-and-set on the move would need a new `appendMessages` parameter and its own tests for a
    race whose window is seconds long on a single-user app. UX surprise, not data loss; both
    branches stay reachable."
  - "**Out of scope by the spec, and absent from every task:** branches on the thread rail,
    delete/merge/rename a branch, and per-branch message counts. `message_count` still counts every
    row in the tree (Ruling 3), so a branched thread's rail count legitimately exceeds what is on
    screen — 10 rows against 4 displayed is normal, and it is visible in this cycle's own
    screenshots."
  - "**`rateLabel` is knowingly inaccurate for a tool-calling turn.** A turn that calls tools spends
    much of its wall-clock waiting on them and that time is inside the measured window, so such a
    turn reads slower than the model generated. `durationLabel` sits beside it so a low figure is
    attributable. Measuring only the streaming intervals would be more machinery than a monitoring
    readout justifies — stated in the code, the wiki and here rather than quietly wrong."
  - "**`getConversation` now reads the conversation row twice** (one extra PK lookup) and
    `getAgentHistory` selects all columns instead of four. Both were measured before being accepted
    (Ruling 6): prod's entire `conversation_messages` table is 267 rows and 39 kB of reasoning, the
    biggest conversation 14 messages, p95 10. The regression is two orders of magnitude smaller than
    the review assumed, and a projection parameter would have forced the cycle's single load-bearing
    assertion (`expect(model).toEqual(ui)` over full objects) down to an id-sequence comparison."
  - "**`ws.ts` still has no test file at all.** The leaf capture was extracted to `captureTurnLeaf`
    and DB-tested precisely because of that (Ruling 13) — including the deterministic form of the
    race — but the wiring inside `ws.ts` itself is verified by reading, typecheck and the browser.
    Exercising `ws.ts` needs a real crossws WebSocket upgrade, which is why `turn-persist.ts` was
    extracted in the first place."
  - "**A committed `.githooks/commit-msg` rejecting `Co-Authored-By` / model-name trailers — raised
    for the THIRD cycle running.** It slipped in once this cycle (Task 2, amended out, verified
    independently by reflog). The cause is structural, not carelessness: the harness sends every
    subagent an attribution reminder instructing exactly those lines and the global CLAUDE.md
    overrides it, so every dispatch re-wins the same conflict. A hook via `core.hooksPath` makes it
    impossible instead. Offered at the end of cycle 65 and not taken up; still a repo-level change
    outside this plan's scope, and worth re-offering."
  - "**Shared scratchpad filenames across concurrent agents are a collision risk.** An implementer
    reported its scratchpad DB helper being overwritten between rounds by a different agent's file
    of the same name; it rewrote it and re-verified every number rather than reporting stale ones.
    No defect resulted. Worth a unique prefix per agent in future cycles."
next_seam: >
  **Merge and deploy this branch, and run `0045_busy_solo.sql` with it.** Unlike the four cycles
  before it, this one starts from a deployed baseline, so the only thing between it and prod is the
  migration — additive, self-healing and safe to re-run, but load-bearing: until it runs, every
  conversation has a null leaf and every read takes the flat fallback, which is correct but means no
  branching at all. Run it, then spot-check the invariant the backfill exists to establish: **no
  conversation's `active_leaf_id` may have a child** (`SELECT count(*) FROM conversations c WHERE
  c.active_leaf_id IS NOT NULL AND EXISTS (SELECT 1 FROM conversation_messages m WHERE m.parent_id =
  c.active_leaf_id)` must be 0 — it is 0 on dev). After that, the two follow-ups this cycle owes
  tasks for (branching a thread's first turn; the parked leaf race) are the natural next seam, and
  neither is urgent. **The transferable lesson is in "Five tests that could not fail" below** — it is
  the strongest argument this program has produced for keeping break-it-and-watch-it-redden mandatory
  rather than advisory.
---

# Agent chat affordances (cycle 68)

## The complaint, and what reading the code did to it

Tony's words were *"no copy message button, no fork conversation at message, missing lots of
stuff"*. Three of those four things were already built.

`ReplyActions.vue` already had **copy**, already had **regenerate**, already had the **timestamp**
and a **token count**. They sat behind `opacity-0 group-hover:opacity-100 focus-within:opacity-100`.
On a desktop you found them by accident; on a touch device, where there is no hover at all, you
could not reach them by any gesture.

**So a third of the complaint was a discoverability defect, and the fix was deleting a CSS class.**
That is worth stating plainly rather than quietly folding into a feature list, for two reasons: it is
the cheapest bug this program has fixed, and it is the kind that a diff-shaped review will never
find, because the code that implements the feature is present and correct.

What was genuinely missing was **fork** — and behind it, the whole branching model that cycle 28
reserved `conversation_messages.parent_id` for and then deferred. The column had been written
linearly, every message's parent being the previous turn, and **read by nothing at all**.

## What changed for someone using it

- **The action row is always visible**, at every width, and wraps instead of overflowing at 375px.
- **Fork from any message.** Clicking it arms the composer — *"Your next message branches from …"* —
  and the branch is created when you send, not when you click.
- **Edit a user message in place.** Saving does not rewrite it: the edited question lands as a
  sibling and the original stays reachable.
- **Regenerate keeps the previous reply.** This is the behaviour change to flag: it used to
  **truncate the thread** (`truncateForRetry` cut everything from the retried turn onward and threw
  it away). Anyone relying on the old semantics — "retry replaces the answer" — will be surprised.
  Nothing is deleted any more.
- **A ‹ n/N › pager** appears on any message that has siblings, and only on those.
- **Every assistant message shows its duration and tok/s** — live, during the turn, not only after a
  reload.

## Regenerate does not follow the spec's literal wording, and that is deliberate

The spec's table says *"Regenerate a reply → that reply's parent"*, which would make the new reply a
second child of the user message. **It cannot be implemented that way**, because of a constraint the
spec did not account for: the WS turn **always persists a `[user, assistant]` pair**. There is no
path anywhere in `ws.ts` that appends an assistant message alone. Resending under the user message
would therefore write `U → U2 → R2` and duplicate the question inside the regenerated branch.

So regenerate **shares the edit mechanism** — position the leaf at the user message's parent, then
send the same text unchanged — and the **pager sits on the user message rather than on the reply**.

The user-visible promise the spec actually made ("the previous reply stays reachable") is kept
exactly. What changed is where the pager appears, which is also where a chat UI conventionally puts
it.

## The property this cycle is actually built to protect

Two readers resolve a transcript: `getConversation` for the user, `getAgentHistory` for the model.
**If they ever disagree about which messages exist, the model answers a conversation nobody is
reading and nothing in the UI says so.**

Both now reduce to one call to `loadActivePath`, with the null-leaf fallback *inside* the shared
function so neither caller can own a different one. The test that pins it is
`expect(model).toEqual(ui)` over full message objects — and the proof it is not vacuous was run
three times by three different agents: reverting `getAgentHistory` to the leaf-ignoring select
reddens exactly those two assertions, **at the equality line rather than the UI assertion above it**
(so the UI was right and the model was the one reading a different conversation, with the diff
showing the model handed BOTH branches while the user read one), and the other tests stay green.

That last part is the finding: **nothing else in 1,933 unit tests and 246 DB tests would have
noticed.**

## Five tests that could not fail

This is the part worth copying into the next cycle.

| # | Where | What it claimed | What it actually did |
|---|---|---|---|
| 1 | The plan's Task 4 leaf test | "appends to the LEAF, not the newest row" | In the fixture, every branch created was also the row written last, so the third append resolved to the same parent either way. Reverting to newest-row chaining left it **green**. Found by the implementer, confirmed independently by the reviewer, renamed rather than deleted — its assertions are real, just not the ones its name claimed. |
| 2 | `conversation-path.db.test.ts`'s null-leaf fallback | "both read paths fall back together" | Asserted only `ui.length` and **never called `getAgentHistory` at all**. Proven vacuous by construction: making `getAgentHistory` return `[]` on a null leaf while the UI showed all 4 rows left all five tests green. That is the exact path any conversation the backfill missed would take. |
| 3 | `branchParent`'s cross-conversation guard | scoped to the conversation | Dropping the `conversationId` predicate outright left all 230 tests green, because the only negative case was a nonexistent UUID that passes either way. Task 5 then exposed that guard over HTTP with user-supplied message ids. |
| 4 | Task 5's `setActiveLeaf` | covered by a route test | The route test **mocked the service entirely** and no DB test touched it, so both of the reviewer's breaks — dropping the conversation scoping, and writing the requested id instead of the descended one — stayed fully green (1905/1905, 233/233, typecheck clean). The damning detail: the test that should have caught the first is the direct analogue of a test whose own comment names Task 5 as where it matters. |
| 5 | `conversation-path.ts`'s sibling sort | ordering is correct | Reversing the comparator reddened three tests, but **deleting the sort block outright stayed green**, because every fixture was already pre-sorted. Fixed with a deliberately out-of-order fixture. |

Every one was found the same way: **break the production code on purpose and watch what the suite
says.** Not one would have been found by reading the tests, and all five had plausible names.

Three further defects came from the **browser** and nothing else could have found them: live message
ids are stream UUIDs rather than row ids, so every branch action 404'd on a fresh turn until the page
re-read the thread; that re-read was then **skipped on the first turn of a new thread**, because the
orchestrator emits `idle` before `ws.ts` has created the conversation — the likeliest moment for
anyone to try fork or regenerate; and an **abandoned** edit or fork silently truncated the thread
with no way back, which is this cycle's central failure mode reached from the UI instead of the
database.

## Rulings (from the SDD ledger, with cost-if-wrong)

Twenty-four, in the order they were made.

- **Ruling 1 — `siblingIds` is added in Tasks 2 and 3, not deferred to Task 9.** Branch switching
  needs each path message's sibling ids, because only the active path is fetched and the client
  cannot otherwise resolve "the next sibling". *Cost if wrong:* two tasks carry a field whose only
  consumer arrives much later, so their reviewers may flag it as unused — their dispatches said why
  it was there. The alternative, a later task reaching back to change an earlier task's type, is how
  a cycle ends up with two sources of truth for one DTO.
- **Ruling 2 — the unfinished-turn rescue passes no explicit `parentId`**, so after Task 4 it
  inherits the active-leaf default, which is correct: the rescue fires when a turn dies, and the leaf
  at that moment is the thread the user was typing in. *Cost if wrong:* a turn dying immediately
  after a branch switch could attach to the new branch rather than the one it was sent to. Widened,
  not reversed, by Ruling 7.
- **Ruling 3 — `message_count` keeps counting every row, inactive branches included** (spec-stated).
  *Cost if wrong:* the rail's count exceeds what a branched thread displays — a visible oddity,
  documented in the spec and the wiki, not a correctness bug. It is visible in this cycle's own
  screenshots (10 rows, 4 displayed).
- **Ruling 4 — the backfill identifies the tail STRUCTURALLY, not temporally.** The tail is the
  message no other message names as parent; the first version's `ORDER BY created_at DESC, id DESC`
  was deterministic but arbitrary, and `id` is a random uuid uncorrelated with insertion order. *Cost
  if wrong:* a conversation with two tails from a historical concurrent append picks one
  deterministically instead of erroring — the better failure. Proven by construction, because dev's
  15 conversations could not discriminate: a fixture whose newest two messages share a `created_at`
  with the mid-chain row's uuid sorting higher makes the OLD expression pick the wrong row and the
  new one pick the tail.
- **Ruling 5 — the walk is in-memory, not the spec's single `WITH RECURSIVE`.** The spec's own stated
  priority is that the two read paths agree, and an in-memory walk means both call one unit-tested
  pure function rather than duplicating the walk in SQL. It fetches no more rows than
  `getConversation` already fetched. *Cost if wrong:* a thread far larger than any here would
  transfer rows it does not display; revisit at session scale (max 5,622 messages).
- **Ruling 6 — the all-columns select is DISMISSED, measured rather than argued.** The review costed
  it at "~5,600 messages, tens of MB per voice resume" — that is session scale, not conversation
  scale. Prod: 267 `conversation_messages` rows in total, 39 kB of reasoning across the whole corpus,
  biggest conversation 14 messages, p95 10, avg 4.2. *Cost if wrong:* a voice resume on a
  conversation far larger than any that exists transfers reasoning text it discards — a one-line fix
  in one place, and those numbers are the trigger to revisit. A projection parameter would have
  forced the cycle's single load-bearing assertion down to an id-sequence comparison.
- **Ruling 7 — the turn captures the leaf at turn start and passes it to BOTH persist calls.**
  `s.lock` protects session state; the leaf is a DB column, so it protects nothing, and Task 5's HTTP
  route (or a second tab) is unserialized against a running turn. *Cost if wrong:* a branch switch
  mid-turn lands the reply on the branch the user left rather than the one they were typing into;
  recoverable through the pager either way.
- **Ruling 8 — the unlocked read-modify-write on the leaf is PARKED.** It predates cycle 68 (the old
  newest-row chaining had the identical race) and branching makes its consequence strictly less
  harmful. *Cost if wrong:* two genuinely concurrent turns on one conversation produce a surprise
  branch rather than silent loss.
- **Ruling 9 — but the inserts and the leaf move ARE made atomic**, which revises Ruling 8 rather
  than contradicting it: a crash between them leaves rows written while the leaf still points at the
  old tail, and `loadActivePath` walks straight past them, so they are invisible in **both** read
  paths — whereas pre-cycle the flat read still showed them. That is a failure mode this cycle
  **creates**, which is exactly the line Ruling 8 drew. `db.transaction` for atomicity, explicitly no
  `FOR UPDATE`. *Cost if wrong:* none identified; the omission is recorded in-file so the transaction
  is not later mistaken for a half-finished concurrency fix.
- **Ruling 10 — switching descends to the sibling's branch tip.** The brief's `setActiveLeaf` wrote
  the id it was handed; the spec says the deepest descendant. Left as written, switching to a sibling
  that has its own continuation would make everything below the switch point invisible to both read
  paths — the exact silent-hiding shape this cycle exists to prevent — and the client cannot close
  the gap, because it only ever fetches the active path. *Cost if wrong:* one extra in-memory walk
  over a conversation that holds at most 14 messages in prod.
- **Ruling 11 — `deepestDescendant` is RENAMED to `branchTip`, not re-specified.** The reviewer was
  right that the name was a lie — it follows the newest child at each step, which need not reach the
  deepest node — but the behaviour is right: resuming a branch should land where the user last was.
  *Cost if wrong:* a thread whose older arm is longer resumes at the recent tip, which is what a chat
  UI should do anyway.
- **Ruling 12 — the leaf capture is for CHAINING ONLY; no compare-and-set on the leaf MOVE.** The
  captured leaf decides which branch the turn attaches to, which is the half that can silently lose
  content. *Cost if wrong:* a mid-turn branch switch is overridden when the reply lands — a UX
  surprise, both branches still reachable.
- **Ruling 13 — the leaf capture gets a REAL DB TEST, not a browser check**, which widened Task 6's
  scope to allow extracting `captureTurnLeaf`. The argument that overturned the earlier inclination
  to defer it: **when the leaf capture fails, the UI still looks correct** — only the tree is wrong —
  so a visual check cannot see it. *Cost if wrong:* one more exported function on a service that
  already owns the leaf.
- **Ruling 14 — the pager DISABLES the arrow that has nowhere to go** (previous at `index <= 1`, next
  at `index >= total`), which the brief did not specify and the spec calls presentation-only. An
  arrow that silently does nothing is a worse affordance than one that shows it cannot move. *Cost if
  wrong:* the pager renders enabled arrows at the ends and Task 9 guards instead. Carried with an
  explicit caveat — read the vendored source before assuming a `disabled` prop exists — which was
  justified twice over: the vendored components have no such prop, hardcode a single shared
  `totalBranches <= 1`, wrap around, and count branches from slotted VNodes.
- **Ruling 15 — the client transform is widened in Task 9.** The pre-flight scan checked DTO → Task 9
  but missed the layer between: `to-ui-messages.ts` deliberately excluded `branch` and `siblingIds`
  when building `AgentUIMessage`, so the client never saw them and the pager could not display real
  data however correct the server was. *Cost if wrong:* the pager renders 1/1 and therefore nothing —
  a visible no-op, not a silent corruption.
- **Ruling 16 — live-turn metrics are investigated and fixed in Task 9, with an escape hatch.** The
  headline feature was half-built: duration and tok/s appeared only after a reload, because the WS
  persisted the timing-enriched usage but never streamed it back. Confirmed by measurement (a real
  turn showed only the timestamp; the same row after a reload gained "1.5s / 144.9 tok/s") rather
  than taken on report. *Cost if wrong:* a WS protocol change would have blown up Task 9's scope —
  hence the escape hatch, which went unused: no protocol change was needed.
- **Ruling 17 — the native `title` tooltip on the token count is replaced by a real tooltip.** A
  native title is hover-only and unreachable on touch — the exact failure this task existed to fix,
  reintroduced for secondary metadata, and spec-directed, so the spec's defect rather than the
  implementer's. *Cost if wrong:* secondary metadata stays desktop-only, which is where it was.
- **Ruling 18 — Task 9's brief is the weakest in the plan and is resolved in the dispatch** rather
  than left for an implementer to guess. It was visibly the controller thinking aloud, and its Step 4
  note was stale. *Cost if wrong:* an implementer builds the stale instruction.
- **Ruling 19 — the leaf route gains an optional `op`, because fork was broken by Ruling 10.** The
  descent is right for switching and wrong for forking: `setLeaf(conv, messageId)` landed on that
  branch's tip instead of the message, which is "carry on as normal" — no fork at all. With an `op`
  the route resolves `branchParent` and sets **that** id exactly, no descent, reusing Task 4's tested
  primitive and keeping every tree decision server-side. *Cost if wrong:* one optional field on a
  route whose existing behaviour is unchanged and still covered. An unknown `op` is a 400, not a
  silent fall-back.
- **Ruling 20 — regenerate cannot follow the spec's literal table.** See the section above. *Cost if
  wrong:* the pager appears one message earlier than the spec's wording implies, which is also where
  a chat UI conventionally puts it.
- **Ruling 21 — abandoned edits and abandoned forks get DIFFERENT fixes, because they differ in
  kind.** Edit gets capture-and-restore (remember the leaf, put it back if the send fails or throws).
  Fork cannot use that guard — abandoning a fork has no event to hang off, the user simply navigates
  away — so fork **defers the leaf move to send time**, which is also the better UX. *Cost if wrong:*
  fork would have needed its own task if deferring required restructuring the composer's send path;
  it did not, because `sendText` is a prop.
- **Ruling 22 — editing or regenerating the FIRST turn stays unsupported, and the LIE is fixed
  instead.** See `deferred:`. *Cost if wrong:* rephrasing an opening question needs a new
  conversation, which is what it needed before this cycle too.
- **Ruling 23 — the controller was WRONG and the implementer was right to refuse.** The instruction
  to wrap `Conversation.vue`'s `title` in a tooltip would have **hidden text that is currently on
  screen**: it is `UAlert`'s `title` PROP, rendered as visible text, not a native tooltip attribute.
  Adjudicated by a reviewer reading `Alert.vue` itself. Recorded because it is the mirror image of
  cycle 67's failure — there the controller invented an interface that did not exist, here it assumed
  an attribute that was actually a prop. **Both are the same error: reasoning about a component
  without reading it.**
- **Ruling 24 — the hero Persona is capped by VIEWPORT HEIGHT, and the acceptance measurement is
  specified rather than the mechanism.** The reviewer overruled the implementer by measuring: at
  800×480 the old `size-40` clipped 26% of the disc (74% visible, still a legible circle) while the
  new `size-56` clipped 59% (41% visible, a thin arc) — so the change took the portrait from
  mostly-visible to mostly-gone, undercutting the task's own goal. *Cost if wrong:* the hero is
  slightly smaller on tall screens than the unconstrained version would be. **Re-measured
  independently in this cycle's validation: 77.2% visible at 800×480.**

## Live validation (playwright-cli, dev on :3219, Haiku 4.5)

Per the project rule, `playwright-cli` — never the MCP. Logged in as `test@example.com`, at
1440×900 (light and dark), 375×812 and 800×480. **Haiku 4.5 was selected in the composer** because
the dev default chain's head (qwen at `192.168.2.25:8004`) is down. Screenshots are gitignored
scratchpad evidence, not committed. Tree shapes were read **directly out of Postgres**, not inferred
from the screen.

| # | Item | Result |
|---|---|---|
| 1 | A real turn shows duration and tok/s | **PASS.** The first reply rendered `1.5s 875.0 tok/s` **live**, before any reload, and the info button read `11.0k tok · 4144d313-…` (Haiku 4.5's registry id, so the figure belongs to the model that actually answered). |
| 2 | The action row is visible without hovering, and reachable at 375px | **PASS.** With zero hover simulated: `opacity: 1`, `visibility: visible`, and the class list is `flex flex-wrap items-center gap-2 pt-0.5 text-dimmed` — no `opacity-0`, no `group-hover`. At **375×812** every control (copy, regenerate, fork, the `4/4` pager, timestamp, duration, tok/s, info) is inside the viewport by bounding box, and `scrollWidth === clientWidth === 375`. |
| 3 | Copy copies the message text | **PASS**, and instrumented rather than assumed: `navigator.clipboard.writeText` was wrapped to record its argument **and still call through**. A real ref-click passed exactly `"ALPHA-ONE"` — the message text — and the real write **resolved** (`ok: true`), with no error toast. |
| 4 | Regenerate creates a branch; `1/2` shows the original reply, unchanged | **PASS.** Regenerating gave `2/2` on the **user** message (Ruling 20's shape) with a new reply at `1.5s 2000.0 tok/s`; paging to `1/2` restored the original at `1.4s 363.6 tok/s`, byte-identical to its pre-regenerate row. In Postgres: one assistant message `a7ee6479` with **two** user children, each with its own reply. Next is disabled at `2/2`, previous at `1/2`. |
| 5 | Edit a user message creates a branch; the original question is still reachable | **PASS.** Editing "Reply with exactly: BETA-TWO" to "…GAMMA-THREE" gave `3/3`; paging back reached `2/3` (the regenerated BETA-TWO) and `1/3` (the original BETA-TWO, still `363.6 tok/s`). Nothing was rewritten or removed. |
| 6 | Fork from a mid-thread message; the next turn continues from there | **PASS.** Clicking fork on the first assistant message did **not** rewind the transcript (4 messages still on screen, still `1/3`) and armed the composer: *"Your next message branches from "ALPHA-ONE"" with a Cancel* — Ruling 21's deferral. Sending then produced `4/4`, and in Postgres the new user row's `parent_id` is `a7ee6479`, a genuine fourth sibling. |
| 7 | Switch branches, reload, confirm the switch persisted | **PASS, both directions.** On `1/2`, a full navigation re-rendered `1/2` with the original reply; switching to `2/2` and reloading re-rendered `2/2` with the regenerated one. The leaf is server state, not a client toggle. |
| 8 | A thread with no branches shows no pager anywhere | **PASS.** `document.querySelectorAll('[data-branch-pager]').length === 0` on the 16-message pre-cycle thread, and on the new thread at both 2 and 4 messages before any branch existed. It is a `v-if`, so the element is absent from the DOM rather than hidden. |
| 9 | Resume a pre-cycle-68 thread — it renders in full, in order | **PASS — the migration's real test.** `da162368…` (created 2026-09-19, 16 rows) rendered **16 messages in strict user/assistant alternation**, first and last matching the database's own `(created_at, id)` order exactly, with no pager anywhere. The invariant the backfill exists to establish holds across all 16 dev conversations: **0** have a null leaf, and **0** have a leaf with a child. |
| 10 | Hero Persona is larger; exactly one WebGL2 canvas; voice mode still one | **PASS.** `/agent` empty thread: **1 canvas, 1 webgl2 context, 288×288**, and the disc is now the dominant element of the page. Full-screen voice mode: **2 canvases but exactly ONE webgl2** (384×384) — the second is MicBand's pre-existing 1440×55 **2D** canvas, which is why this has to count **contexts, not canvases**; a naive count reports a false violation. At 800×480 the capped hero is **77.2% visible**, above Ruling 24's 74% bar. |

**Ruling 22 confirmed live, deliberately:** regenerating the **first** turn of a thread produced the
toast *"Could not branch from here — The first message of a thread cannot be branched yet"*, not the
old lie about the message not being in the conversation.

**Console:** one error across the entire session, and it is that deliberate 404 (`/leaf` returning
*"The first message of a thread cannot be branched yet"*). Zero unexpected errors.

**NOT VERIFIED, stated plainly:**

- **Nothing here ran against prod, and the migration has not run there.** Every measurement is dev
  against dev's 16 conversations / 53 messages.
- **No real touch device was used.** The action row's touch reachability is argued from geometry and
  from the controlled tooltip's construction (plus a synthetic `pointerType:'touch'` tap during
  Task 9's review), not from a finger on glass.
- **The concurrent-writer race was not exercised in a browser** — it is parked, and its deterministic
  form is covered by a DB test instead.
- **Voice mode was not exercised with the mic on**, and no audio was played; the voice-mode check
  here is the canvas invariant only.
- **`rateLabel` on a tool-calling turn was not measured.** Every validation turn was a plain chat
  turn, so the documented tool-wait inaccuracy is stated from the code rather than observed.

**Dev data restored, checked rather than assumed:** the one conversation this validation created was
deleted (`DELETE /api/conversations/:id` → 200, 0 rows left under that id); the corpus is back to the
16 pre-existing conversations / 53 messages it started at, with **0 null leaves and 0 leaves with a
child**. No pre-existing conversation was modified or deleted.

## Measured gates

```
pnpm typecheck                                    → exit 0, 0 errors
pnpm test                                          → 219 files, 1,933 tests passed
pnpm test:db                                       → 25 files, 246 tests passed
NODE_OPTIONS=--max-old-space-size=4096 pnpm build  → "Build complete!",
                                                     .output/server/index.mjs present (939 B)
                                                     267 client JS files / 2,112,258 B gzip
                                                     total output 70.9 MB (21 MB gzip)
```

(Success is `.output/server/index.mjs` existing plus "Build complete!" in the log, **not** an exit
code — `/usr/bin/time` has reported 0 on an OOM in this repo before.)

## Bundle

| Point | Client JS files | gzip total |
|---|---|---|
| Cycle 67 (the branch's inherited baseline, as recorded) | 267 | 2,112,164 B |
| Cycle 68 (this handover) | **267** | **2,112,258 B** |
| **Delta** | **0** | **+94 B (+0.004%)** |

Measured with deploy.yml's exact build command, `.output/` removed first, as
`cat .output/public/_nuxt/*.js | gzip -c | wc -c` over 7,385,142 raw bytes. **Two caveats worth
stating rather than burying**, because +94 B for a cycle that adds a component, a module and ~250
lines of page wiring reads as suspiciously small:

1. **No new chunk was created.** `BranchPager.vue` and `metrics.ts` are small and were bundled into
   chunks that already existed rather than becoming code-split boundaries, which is why the file
   count did not move. The new code **is** in the output — `data-branch-pager` appears in one chunk
   and `tok/s` in two — and `truncateForRetry` appears in none, confirming the deleted module was
   dropped rather than merely orphaned.
2. **The comparison is against cycle 67's recorded figure, not a build I ran myself.** The exact
   command earlier cycles used was never written down. This method lands within 94 B of cycle 67's
   number at the same file count, which is strong evidence it is the same one; a per-file sum
   (`Σ gzip(each file)`) gives 2,173,222 B, ~61 KB higher, so it is definitely **not** that. If a
   future cycle wants a hard delta rather than a cross-cycle comparison, build the branch base and
   measure both with one script.

Build memory was a non-event at 4096 MB, with cycle 65's `modules/tailwind-build-context.ts` doing
its job.

## A note on the ledger

The SDD ledger (`.superpowers/sdd/2026-09-21-agent-chat-affordances/progress.md`) ends with
*"Task 10: scoped re-review dispatched"* and carries no Task 10 completion line, unlike every other
task. The work itself did land — `d32977c` is on the branch and its result was re-measured
independently during this cycle's validation (77.2% visible at 800×480, above the 74% bar Ruling 24
set) — but the ledger's own record of that task is incomplete, and it is better to say so here than
to let a future reader infer a closure that was never written down.
