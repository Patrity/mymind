---
title: "Voice studio — `DesignPane` split into three children, the speak box in composer chrome, and the microphone fix (cycle 67)"
cycle: 67
date: 2026-09-20
status: >
  BUILT, NOT MERGED, NOT DEPLOYED. All 8 tasks complete on `feat/voice-studio-refactor`, branched
  from LOCAL master `3d91a31` — and local master is **90 commits ahead of `origin/master` and
  unpushed** (cycles 64, 65 and 66 also live only locally), so nothing in any of the four cycles has
  reached prod. **No migration this cycle**; nothing in `server/` was touched at all — the whole diff
  is 11 files under `app/`. **This cycle is deliberately smaller than 64-66**, because measuring the
  deferred line found two thirds of it empty (see "What the deferred line promised, and what was
  actually there"). **The one user-visible change in the entire cycle is the microphone fix**:
  before it, choosing a microphone in settings did nothing for reference-clip recording and the
  studio silently used the system default. Everything else is refactor or chrome, and its success
  criterion is that nothing changed. `DesignPane.vue` went **1,101 → 470 lines**. Live-validated in
  a real browser against a **reachable rig** — all **9 items PASS**, none NOT VERIFIED, zero console
  errors; the 375px speak-panel gap found alongside them was proven **pre-existing** by a controlled
  probe against the branch base. Gates at the end of this cycle: `pnpm typecheck` exit 0 /
  `pnpm test` 215 files, 1,863 tests / production build at 4096 MB passes (267 client JS files,
  2,112,164 B gzip — **+1 file, +4,001 B, +0.19%** over cycle 66). **The most useful thing in this
  document is not the code: it is that two of my own briefs invented interfaces the original never
  had, and both were caught only because implementers flagged instead of building.** In a refactor
  whose premise is "nothing changes", a plausible invented interface is the likeliest way to break
  that quietly.
branch: feat/voice-studio-refactor
spec: ../superpowers/specs/2026-09-20-voice-studio-refactor-design.md
plan: ../superpowers/plans/2026-09-20-voice-studio-refactor.md
docs:
  - ../wiki/voice-studio.md (UPDATED — cycle bumped to 67; a new "Component layout (cycle 67)"
    section with the per-file line counts and the three rules that hold the split together
    (page-owned draft, no-emit draft mutations, one generation guard); "`useRigRender` — why the
    clock is shared and the render is not"; "The speak box is a composer" with the Enter/caret/wrap
    facts and why the Elements `PromptInput` wrapper was NOT adopted; "The studio honours the chosen
    microphone" with the constraint table and the browser evidence; the 375px split-pane gap recorded
    against "The page"; the `STARTERS` duplication note re-pointed at `DesignDescription.vue`; the
    Files table extended with the three children, `useRigRender.ts` and `mic.ts`)
  - ../wiki/agent.md (UPDATED — `VoiceSettingsSlideover` → `AgentSettingsSlideover`, 3 references)
  - ../wiki/voice-agent.md (UPDATED — same rename, 1 reference; the studio-files row now names the
    three `Design*` children)
  - 2026-08-27-agent-surface-redesign.md (UPDATED — the same rename, 3 references, with a
    parenthetical on the first recording that the component was called `VoiceSettingsSlideover` at
    the time. A handover is a point-in-time record, so the name was corrected rather than the history
    rewritten.)
  - ../BACKLOG.md (UPDATED — reconciliation preamble bumped to cycle 67; the cycle-67 line in the
    "agent surfaces on AI Elements" block flipped from deferred to BUILT, recording that Home was
    descoped and what replaced it)
  - ../superpowers/plans/00-roadmap.md (UPDATED — cycle 67 row added; the 4-cycle program closes)
tasks:
  - "d321c732 (MyMind, cycle 67) — update to reflect BUILT / NOT MERGED (controller does this after
    mirroring). Note the task's title still says \"voice studio + Home\"; Home was declined at spec
    time and is NOT in this cycle."
  - "9745f72d (MyMind) — \"at 375px the metadata panel squeezes the transcript to 0px\": filed in
    cycle 66 for `/sessions/[id]`, still OPEN, and this cycle found the SAME defect on `/voice` (the
    speak panel resolves to ~2px at x=391). One split-pane behaviour, two pages. Measured identically
    on this branch's base commit, so it is not a cycle-67 regression."
shipped:
  - "`useRigRender` (Task 1, `eb1a3e8`) — `app/composables/useRigRender.ts` (59 lines): `renderWav`
    plus the elapsed clock (`elapsedMs`, `queued`, `startClock`, `stopClock`), moved out of
    `DesignPane.vue:207-256` VERBATIM. `diff -w` of the original block against the composable body is
    EMPTY — only re-indentation from the function wrapper — and all three comment blocks survive
    unedited. Four fake-timer tests, proven non-vacuous by the reviewer: removing `elapsedMs.value =
    0` reddened the restart test (`expected 1000 to be +0`) and moving the queued threshold
    4000 → 0 reddened the threshold test. One necessary deviation, self-reported: an explicit
    `import { ref, computed } from 'vue'`, because `vitest.config.ts` runs plain `vitest run` with no
    Nuxt auto-import plugin and the test calls the composable directly."
  - "`DesignDescription.vue` (Task 2, `67207f8` + `3f6ac7e`) — 88 lines: the Instruction field, its
    hint popover, and the eight `STARTERS`. Verified against the TRUE 1,101-line original
    (`git show 3d91a31`), not against the already-modified working file, which is what caught the
    invented `disabled` prop. Takes `presetId` purely to reset `starterKey` on a preset switch; the
    reviewer confirmed the watch keys on the same preset identity the parent's own switch watcher
    uses, so it fires between two non-null presets too."
  - "`DesignSeedAudition.vue` (Task 3, `d181d20`) — 301 lines: \"Try 4 seeds\", the four takes, the
    star toggle and the kept-seeds strip. The template block is byte-identical to the original
    (`diff -w` exit 0, zero differences); the script has exactly TWO forced deviations, both
    reproduced by the reviewer rather than taken on trust. The stale-token guard moved unmodified."
  - "`DesignReferenceClip.vue` (Task 4, `1a05010`) — 332 lines and the largest extraction: recording,
    uploading, playback, clearing, and the transcript. `diff -w` is EMPTY for BOTH the script and
    template spans against the true original. `recordingToken`'s capture-at-start timing and its
    comment are byte-identical. The bare `getUserMedia` bug was deliberately left intact here so
    Task 5's diff would show the fix cleanly."
  - "The microphone fix (Task 5, `e821461`) — `app/lib/voice/mic.ts` (23 lines): `BASE_AUDIO`,
    `micConstraints(deviceId)` and `isStaleDeviceError(err)`, mirroring `useVoice.ts:330-346`.
    `DesignReferenceClip`'s `toggleRecording` now requests `deviceId: { exact: … }` with an
    `OverconstrainedError`-ONLY fallback that clears the dead cookie value. Four tests (+4 on the
    suite); the reviewer forced `isStaleDeviceError` to `return true` and watched ONLY \"does not
    swallow a permission denial\" go red while the other three stayed green. **The only user-visible
    change in the cycle.**"
  - "The slideover move (Task 6, `739b69f`) — `git mv app/components/voice/SettingsSlideover.vue
    app/components/agent/SettingsSlideover.vue`, plus the one consumer at
    `app/pages/agent/index.vue:338`. Nuxt derives the auto-import name from the directory, so
    `<VoiceSettingsSlideover>` became `<AgentSettingsSlideover>` — a missed reference here is a
    runtime blank, not a type error, which is why this task's gates included a full production
    build."
  - "The speak box in composer chrome (Task 7, `2578e40`) — `SpeakPane.vue` (419 lines):
    `InputGroup` + `InputGroupTextarea` + `PromptInputFooter`/`PromptInputTools` replace the
    `UFormField` + `UTextarea` and the loose tag row. Enter inserts a newline, tags insert at the
    caret, no attach button / model select / action menu. Found and fixed a real layout bug no gate
    could see — see \"The defect browser validation existed to catch\"."
  - "Documentation, live validation and the two doc fixes (Task 8, this handover) — the wiki page
    rewritten against the shipped code, this handover, the roadmap and backlog, plus the two
    corrections the earlier tasks deferred: every `VoiceSettingsSlideover` reference in the docs
    tree, and `DesignPane.vue`'s stale \"Load / reset on selection\" comment."
deferred:
  - "**`app/pages/home` / `AskBrain.vue` was DESCOPED, not deferred.** The program's deferred line
    said \"voice studio + Home\". `AskBrain.vue` is 23 lines — a `UInput` that navigates to
    `/agent?q=` and never sends — and turning it into a full composer was offered to Tony and
    DECLINED: it would add attachments and a model picker to a box whose entire job is to hand a
    question to the page that already has both. This is not waiting for anyone; it is closed. The
    MyMind task `d321c732` still carries the old title."
  - "**\"Shared voice pieces between `/agent` and `/voice`\" does not exist, and the search for it is
    the finding.** `AgentMicBand` is imported only by `/agent`; `WaveformTrack` only by the studio.
    They visualise different things — a live level band versus levels-over-time with a duration — so
    merging them would force two shapes into one. No component is duplicated between the surfaces.
    Recorded here so nobody re-opens the question expecting to find something."
  - "**Unifying mic acquisition between `useVoice` and `DesignReferenceClip` — offered and
    declined.** `app/lib/voice/mic.ts` duplicates the constraint-building and stale-device logic
    rather than refactoring `useVoice` to consume it, because streaming speech through a VAD and
    recording a ten-second clip are different jobs. The cost is real and stated in Ruling 2: a future
    change to mic handling must be made twice. `mic.ts` carries a comment pointing at
    `useVoice.ts:330-346` as the original."
  - "**At 375px the `voice-speak` panel is unreachable — PRE-EXISTING, and PROVEN so.** The three
    resizable `UDashboardPanel`s resolve it to ~2px at `x=391`, off the right edge. The controlled
    probe: `git checkout 3d91a31 -- DesignPane.vue SpeakPane.vue` into the running dev server and the
    identical measurement re-run gave the speak panel at **x=375, width 32**, with its textarea at
    **x=391, width 20** — the same off-screen shape, before any of this cycle's code existed. It is
    the split pane, not the composer. Same defect, same `x`, as cycle 66 measured on `/sessions/[id]`
    (MyMind task `9745f72d`). The design pane at 375px is fully usable."
  - "**`@kept` is a slightly misleading emit name** — the studio's UI uses \"keep\" for the *star*
    toggle, while `@kept` fires for the **Use** button. The reviewer ruled the BINDING correct
    (`toggleStar` only mutates the shared draft, so an emit there would be a no-op; Use is the only
    action crossing the must-not-persist boundary), so this is a readability nit, not a defect. Rename
    it `@use` if the file is opened again."
  - "**`mic.ts` types its catch parameter `unknown` where `useVoice` uses `Error`** — cosmetic, and
    the brief specified `unknown`. Related and PRE-EXISTING: `DesignReferenceClip.vue:75-76` wraps
    the failure through `errorMessage(e)` rather than surfacing the raw browser message; the denial
    still reaches the user, just reworded."
  - "**`app/composables/useDocumentTree.ts:278` calls an unimported `ref()`** and relies on Nuxt's
    build-time auto-import; its test avoids the problem by never invoking that function. Spotted by
    Task 1's reviewer while checking OUR import deviation. **Strictly pre-existing and not ours** —
    noted because it is the same trap Task 1 had to work around, and it will bite whoever next tries
    to unit-test that composable directly."
  - "**One unexplained `bulk:all-failed` toast** appeared once during Task 7's manual testing with no
    matching console error, and did not reproduce. Nothing in this cycle's scope touches fetch or
    activity code. Recorded, not investigated."
  - "**A committed `.githooks/commit-msg` rejecting `Co-Authored-By` / model-name trailers — raised
    in cycle 66, still not built, and this cycle is the evidence it is worth doing.** Cycle 66
    reported the trailer slipping in twice. This cycle it slipped in ZERO times — every task report
    records checking the message before committing — but that is vigilance, not a mechanism: the
    harness sends every subagent an attribution reminder instructing exactly that, and Tony's global
    CLAUDE.md overrides it, so every dispatch re-wins the same conflict. A hook via `core.hooksPath`
    makes it impossible instead. Still a repo-level change outside this plan's scope."
next_seam: >
  **The four-cycle "agent surfaces on AI Elements" program is COMPLETE** — cycle 64 (the conversation
  on `UIMessage`s), 65 (the `/agent` page), 66 (`/sessions/[id]`), 67 (the voice studio). There is no
  cycle 68 queued behind it. **The one thing that must happen before any new cycle starts is the
  merge/push backlog, and it is now the largest risk in the repo by a wide margin:** local master is
  **90 commits ahead of `origin/master`** with FOUR stacked unmerged, unpushed cycles. Cycle 65
  carries `modules/tailwind-build-context.ts` — the production-build OOM fix master does not have, so
  cycle 64 on master is a deploy risk today. Cycle 66 carries `0044_low_pride.sql`, the only
  migration in the stack, unrun on prod. This cycle adds nothing to that load (no migration, no
  server change, `app/` only), which makes it the cheapest of the four to ship and the worst one to
  keep waiting behind the other three. That is a decision for Tony, not a task.
---

# Voice studio refactor (cycle 67)

## What the deferred line promised, and what was actually there

Cycle 64 reserved this cycle as *"voice studio + Home on the shared voice pieces and
`PromptInput`"*. Two thirds of that did not survive contact with the code:

- **Home was declined.** `AskBrain.vue` is 23 lines and hands a question to `/agent`. Making it a
  composer would give it attachments and a model picker it has no use for.
- **There were no shared voice pieces.** `AgentMicBand` is agent-only, `WaveformTrack` is
  studio-only, they visualise different quantities, and nothing is duplicated between the surfaces.

What the measurement *did* surface were two real defects, and they replaced that goal: a settings
slideover filed in the wrong directory, and a studio that ignored the user's microphone. So this
cycle is a large refactor plus one small fix — and it is deliberately smaller than the three before
it. **Measuring the intent before planning against it is the reason this cycle is honest rather than
padded**, and it is the part worth copying.

## The one thing a user will notice

**Everything in this cycle is invisible except the microphone fix.**

`DesignPane.vue`'s recorder called bare `navigator.mediaDevices.getUserMedia({ audio: true })`. The
live agent (`useVoice.ts:330-346`) had honoured the saved `micDeviceId` since cycle 60. So picking a
microphone in settings worked for conversation and silently did nothing for reference-clip
recording: the studio recorded on the system default, and nothing anywhere said so. On this machine
that is the difference between an XLR interface and a virtual pass-through device.

It is fixed, and it was proven in a browser rather than reasoned about — see validation item 3.

Everything else — three new components, one new composable, a moved file, a re-chromed textarea —
should be undetectable from the outside. That is the success criterion, and it is exactly what makes
the next section the important one.

## The two interfaces my briefs invented (the process lesson)

**Twice in eight tasks, my own brief specified an interface the original code never had.** Both were
in a cycle whose binding constraint is *nothing changes*, and in both cases the brief was written
confidently enough to read as a deliberate design decision rather than a mistake.

| # | Task | What I invented | What it would have done |
|---|---|---|---|
| 1 | Task 2 | a `:disabled` prop — *"true while the preset is locked or a render is in flight"* | Nothing disabled the Instruction textarea or the starter picker before. Shipping it would have blocked editing a description while a voice was locked, while it was being locked, and during any seed audition — a real, user-visible behaviour change smuggled into a code move. |
| 2 | Task 4 | a `@changed` emit for clip operations | The reference-clip code never notified the parent by any route but mutating the shared reactive draft. The parent's `dirty`/`tabItems`/`lock` computeds read that same object, so the emit was pure ceremony — and a reviewer who accepted it would have been left wondering which of the two mechanisms was load-bearing. |

**Neither was caught by a gate, and neither could have been.** Both would have typechecked, both
would have passed 1,863 tests, and the second would have passed a browser check too, because adding
a redundant emit breaks nothing. They were caught by exactly two habits:

1. **The implementers flagged rather than built.** Task 2's implementer shipped the `disabled` prop
   but opened its report with *"this is new behavior, not a verbatim carry-over… flagging so review
   can veto if this wasn't meant to ship yet."* Task 4's implementer went further and refused to
   build the emit, reporting the discrepancy as an open question instead. After Task 2, every
   subsequent dispatch carried an explicit warning that my briefs had already been wrong once — and
   Task 3's implementer then flagged three deviations of its own, all legitimate.
2. **The reviewers adjudicated against the ORIGINAL, not against the brief.** Task 4's reviewer
   grepped every `emit(` call in `3d91a31:DesignPane.vue` — three hits, all `emit('saved')` inside
   `lockVoice`/`unlockVoice`/`save`, **none** in the reference-clip block — and ruled the emit
   invented. Task 2's re-verification was re-run against `git show 3d91a31` (the true 1,101-line
   file) rather than the already-modified working copy, which is the only reason the `disabled`
   removal could be confirmed complete.

**The lesson, stated so the next refactor inherits it:** in a behaviour-preserving refactor, the
brief is not the authority — the pre-refactor file is. A brief that describes a *nicer* interface
than the original had is the single most likely way for "nothing changes" to quietly become false,
because every gate in the repo will agree with it. Write the constraint into the dispatch ("if the
brief asks for anything the ORIGINAL does not do, flag it rather than implement it"), and make
reviewers diff against the original commit rather than the brief.

## A controller error worth recording

**I dispatched Task 4 referencing `task-4-brief.md`, a file I had never generated.** I ran the brief
generator for Tasks 1, 2 and 3 and skipped 4, then wrote a dispatch that pointed at it.

The implementer searched the whole worktree, found only unrelated `task-4-brief.md` files belonging
to older cycles in other checkouts, **reported the gap**, and proceeded from `git show
3d91a31:DesignPane.vue` plus the eight explicit context points in the dispatch — rather than
blocking, or guessing silently and calling it a brief. That was the right call, and it is worth
saying plainly because the wrong call was available and would have been invisible: a fabricated
"brief" reconstructed from context would have read exactly like a real one in the report.

The process fix, applied for the rest of the cycle: generate the brief and **confirm the file exists
on disk** before composing the dispatch. Task 5's ledger entry records that confirmation explicitly.

## The split, and the three rules that hold it together

`DesignPane.vue` was 1,101 lines carrying five unrelated jobs. It is now **470**.

| File | Lines | Owns |
|---|---|---|
| `DesignPane.vue` | **470** (was 1,101) | Tab shell, sliders and seed, load/reset on selection, `save()`, lock and unlock. |
| `DesignDescription.vue` | 88 | Instruction field, its hint popover, the eight starters. |
| `DesignSeedAudition.vue` | 301 | Audition, the four takes, star toggle, kept-seeds strip. |
| `DesignReferenceClip.vue` | 332 | Record / upload / play / clear the clip, and its transcript. |
| `useRigRender.ts` | 59 | `renderWav` + the queue clock. |
| `SpeakPane.vue` | 419 | The composer (Task 7). |
| `mic.ts` | 23 | Mic constraints + the stale-device test (Task 5). |

**Children, not composables** — deliberately. Every section carried both UI and logic; extracting
only the logic would have split by technical layer and left a 527-line template behind, which is what
makes a file unholdable to begin with.

Three invariants survive the split, and each one is a bug the studio already fixed once:

1. **`voice.vue` still owns the draft.** `SpeakPane` renders what the design form holds, so the form
   cannot be private to the component that edits it. Children receive the same `reactive()` object,
   mutate it field-by-field, and never reassign or persist it.
2. **A child's draft mutation needs no emit.** The parent's `dirty`, `tabItems` badge and `lock`
   computeds read the same object reference. **Proven live, not argued:** clicking the star inside
   `DesignSeedAudition` flipped the parent's **Save voice** button from disabled to enabled with no
   event crossing the boundary.
3. **Exactly one `createGenerationGuard()`**, created in `DesignPane.vue:47` and passed down as a
   prop — verified by grep to have a single creation site, with both children importing only the
   `GenerationGuard` *type*. `begin()` returns the current generation rather than minting a per-call
   token, so one `reset()` in the preset-switch watcher invalidates lock, upload, recording and
   audition **together**. A child holding its own instance would be invisible to that reset, and an
   abandoned audition would keep the rig's only inference slot while the newly-selected preset
   waited. Task 3's implementer worked this out from `generation.ts` and passed the instance in
   rather than accepting the brief's interface, which omitted it.

### Why `renderWav` moved but the clock is the shared part

A useful correction to my own pre-flight scan, found by Task 3's reviewer: **`lockVoice()` never
called `renderWav` or read `elapsedMs` — only `startClock`/`stopClock`.** So after the split
`renderWav` has exactly one caller (the audition child), and the genuinely shared machinery is the
clock. It exists because the rig serves one request at a time, queued behind the live agent, so after
4 s the pane says *"Waiting on the rig (Ns)"* instead of looking hung — and that behaviour must not
be duplicated into two components that wait on the same slot.

## The defect browser validation existed to catch

Task 7's composer passed typecheck and 1,863 tests, and was still broken at realistic width.
`PromptInputFooter` and `PromptInputTools` **do not wrap by default**. At a ~460px panel the
footer's content measured **652px** against a 460px client width, pushing **Speak and Stop outside
the `InputGroup`'s border** — still present in the DOM and the accessibility tree, so a snapshot
assertion would have said the buttons were there, and simply clipped out of sight.

Fixed by passing `flex-wrap` from `SpeakPane.vue` to the footer and both tool groups (both merge
`class` through `cn`/`twMerge`, so no vendored file was touched), and re-measured at
`scrollWidth === clientWidth === 460`. The final 1440px screenshots show the footer wrapping onto two
rows with Speak/Stop inside the border, in both themes.

This is the third cycle running where the defects that mattered were found in a browser, not by a
gate. It is also the reason the "no vendored file touched" constraint is load-bearing: cycle 65
established that patches to the vendored AI Elements tree are lost silently on a component re-copy.

## Rulings (from the SDD ledger, with cost-if-wrong)

Seven, in the order they were made.

- **Ruling 1 — `DesignSeedAudition` calls `useRigRender()` itself rather than sharing the parent's
  instance, so two independent clocks exist.** Correct, not a bug: the lock flow and the audition
  both need the rig's single inference slot and so can never run at once, and sharing one instance
  would couple two progress displays for no benefit. *Cost if wrong:* two timers where one would do
  — no user-visible effect, since only one can ever be running.
- **Ruling 2 — Task 5 DUPLICATES `useVoice`'s mic-acquisition logic into a helper rather than
  refactoring `useVoice` to consume it.** This is the spec's explicit scope boundary: unifying was
  offered to Tony and declined, because the two have different jobs (stream speech through a VAD
  versus record a clip). *Cost if wrong:* the constraint logic lives in two places, so a future
  change to mic handling must be made twice — mitigated by `app/lib/voice/mic.ts` carrying a comment
  pointing at `useVoice.ts:330-346` as the original.
- **Ruling 3 — `renderWav` moves without a unit test.** It is a `fetch` wrapper whose behaviour *is*
  the network call; testing it would mean asserting against a mock of the thing under test. Its real
  coverage is Task 8's browser validation of audition, lock and speak. *Cost if wrong:* a
  transcription error inside `renderWav` would not surface until browser validation — mitigated by
  requiring a verbatim move, and `diff -w` against the original came back empty. **Discharged:**
  validation items 4, 5 and 6 all exercised it against the live rig and passed.
- **Ruling 4 — Task 7 deviates from the spec's named components** (`PromptInput` +
  `PromptInputTextarea`) in favour of `InputGroup` + `InputGroupTextarea` + the two footer
  components. The spec's binding *requirements* — composer chrome, no attachments/model/action-menu,
  Enter inserts a newline, caret-relative tag insertion — are all still met; only the component
  choice differs. Reason: `PromptInputTextarea` hardcodes Enter-to-submit
  (`PromptInputTextarea.vue:20-33`: `preventDefault` then `requestSubmit`) with no prop to disable
  it, so adopting it would have required a **ninth** patch to the vendored AI Elements tree, and
  cycle 65 established those patches are lost silently on a re-copy. *Cost if wrong:* the speak
  box's chrome could look subtly different from `/agent`'s composer, being assembled from the same
  primitives rather than the same wrapper — mitigated by screenshotting it in both themes, which is
  also how the wrap bug was found.
- **Ruling 5 — REMOVE the `disabled` prop my Task 2 brief invented.** Whether a locked preset should
  disable its description is a real question, but it belongs in a spec, not in a code move, and this
  cycle's constraint is explicit. *Cost if wrong:* we forgo a possibly-desirable guard — recoverable
  at any time, and noted here as a candidate improvement rather than lost.
- **Ruling 6 — replace the implementer's `:key="preset?.id"` remount with an internal watch that
  resets `starterKey`.** The key reproduces the visible outcome but swaps a targeted reset for a full
  subtree remount: a wider blast radius that can drop focus, replay transitions, and will silently
  reset any state the child gains later. Keeping the original mechanism keeps the refactor faithful.
  *Cost if wrong:* a watch is marginally more code than a key. **Verified live** — switching between
  two non-null presets reloads the instruction and returns the starter picker to "Pick a starting
  description…".
- **Ruling 7 — batch Tasks 6 and 7 into ONE dispatch** (two commits, one review). Task 6 is a
  `git mv` plus a single reference update; a full implementer-plus-review cycle for it would cost
  more than it verifies, and both tasks needed the same closing gates (a production build for the
  auto-import rename, a browser pass for the composer). *Cost if wrong:* one review covers two
  unrelated changes, so a defect in the smaller one is easier to miss — mitigated by instructing the
  reviewer to treat them as separate diffs inside the one package.

## Live validation (playwright-cli, dev on :3219, the rig REACHABLE)

Per the project rule, `playwright-cli` — never the MCP. Run at 1440×900 in dark and light and at
375×750, logged in as `test@example.com`. **The rig's `/health` was checked before starting and
answered `{"status":"ok","busy":false}`, so nothing below is NOT VERIFIED** — items 4, 5 and 6 would
have been, had it been unreachable. Screenshots are gitignored scratchpad evidence, not committed.

| # | Item | Result |
|---|---|---|
| 1 | Select a preset; the description field and its starters work | **PASS.** Switching to `warm-woman` loaded its instruction; picking the "Deep narrator" starter replaced the text with that starter's description; switching to `bright-man` loaded *its* instruction AND returned the starter picker to "Pick a starting description…" — the Ruling-6 watch firing between two non-null presets. |
| 2 | Record a reference clip, play it back, clear it | **PASS.** A real mic recording attached at **38.8s** with the over-20s warning quoting the measured length, Whisper filled the transcript, and the Reference tab's badge became `1`. Play flipped the control to "Stop the reference clip". **Remove reference** cleared the player, the transcript and the badge, back to the empty drop zone. |
| 3 | The recording uses the microphone chosen in settings | **PASS — and this is the cycle's whole point.** The machine exposes **12** audio inputs, so this was genuinely exercisable. With "MacBook Pro Microphone (Built-in)" chosen in the settings slideover while the system default was "Default - Mic Pass Through (Virtual)", the instrumented `getUserMedia` recorded `{ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, deviceId: { exact: "a79b5b45…" } } }` and the granted track read back `label: "MacBook Pro Microphone (Built-in)"`. Pre-fix this call was `{ audio: true }`. |
| 4 | Audition seeds; keep one | **PASS.** Four takes rendered (seeds 11 / 637263 / 761078 / 755503) as **four `POST /api/voice/speak` → 200, zero PATCH** — an audition performs no write. Starring 637263 enabled the parent's Save button with no emit (invariant 3 above). Clicking **Use** persisted it: the row came back `seed: 637263`, `starredSeeds: [637263]`, Save disabled again. |
| 5 | Lock a preset, then unlock it | **PASS.** Lock produced `refSource: 'locked'` with a **14,080 ms** frozen render, and calibration narrowed `max_segment_chars` to **100** while setting `calibrated_ref_key` — the documented probe behaviour. Unlock cleared the clip and reset the cap **and** its marker together (`200` / `null`), and the panel returned to "Not locked" with the Lock button and no Reference badge. |
| 6 | Speak text in Quality mode; then in Realtime mode | **PASS, both.** Quality: `"mode":"quality"` in the body, `x-segment-reason: single-call`, first audio in **148 ms**, 1.5 s of audio, Play again + Download WAV enabled. Realtime: `"mode":"realtime"`, first audio in **140 ms**, same 1.5 s. |
| 7 | Enter inserts a newline in the speak box and does not speak | **PASS.** Typed `Hello world`, Enter, `second line` → the box held `"Hello world\nsecond line"`, the path stayed `/voice`, Stop stayed disabled (nothing speaking), and the char count tracked live at 23. |
| 8 | A tag button inserts at the caret | **PASS.** Caret driven to index 5 with real keys (Home, ArrowUp, 5× ArrowRight) and confirmed at `selectionStart: 5` before clicking; clicking `(laugh)` produced `"Hello (laugh) world\nsecond line"` with the caret at 13. Appending at `text.length` would have given `"Hello world\nsecond line(laugh)"`. |
| 9 | `/agent` loads and its settings slideover opens (the Task 6 move) | **PASS.** `/agent` rendered fully (Persona, thread rail, composer). The toolbar's cog opened the `AgentSettingsSlideover` dialog with Persona, Microphone, Speech sensitivity and the rest — so the auto-import rename resolved. The microphone picker inside it is what set up item 3. |

**Light and dark at 1440: PASS.** Both themes flip cleanly with the composer chrome, the rendered
waveform, the kept-seeds strip and the audition takes all intact; the footer wraps to two rows at
this panel width with Speak/Stop inside the group's border. **Zero console errors across the entire
session** (4 messages, 0 errors, 0 warnings at error level).

**375px: the speak panel is unreachable — and PRE-EXISTING.** See the deferred list for the
controlled probe that proves it (branch base measured at `x=375, width 32`; branch at
`x=391, width 2`). The page itself never scrolls horizontally
(`scrollWidth === clientWidth === 375`) and the design pane is fully usable at that width.

**NOT VERIFIED, stated plainly:**

- **Nothing here ran against prod.** Every measurement is dev against dev's data, and the rig is the
  homelab box.
- **Nobody listened to the audio.** Every render is proven by status code, byte flow, duration,
  TTFA and the drawn envelope. Whether the locked voice *sounds* like the design, or whether a
  chunk boundary clicks, needs ears — a standing gap in this whole subsystem, not new here.
- **The `OverconstrainedError` fallback path was not exercised in a browser.** It is unit-tested
  (including the case that matters — a `NotAllowedError` must NOT be treated as stale), and the
  reviewer broke the predicate to confirm the test reaches it, but no device was unplugged mid-run.
- **The upload-a-WAV path was not re-exercised**; item 2 used the record path, which is the one the
  mic fix touches.

**Dev data restored, checked rather than assumed:** the `neutral-lowkey` preset is back to
`seed: 11`, `starredSeeds: []`, `refSource: null`, `max_segment_chars: 200`, and the browser's
`micDeviceId` is back to the system default.

## Measured gates

```
pnpm typecheck                                    → exit 0, 0 errors
pnpm test                                          → 215 files, 1,863 tests passed
NODE_OPTIONS=--max-old-space-size=4096 pnpm build  → "Build complete!",
                                                     .output/server/index.mjs present (939 B)
                                                     267 client JS files / 2,112,164 B gzip
                                                     total output 70.9 MB (21 MB gzip)
```

(Success is `.output/server/index.mjs` existing plus "Build complete!" in the log, **not** an exit
code — `/usr/bin/time` has reported 0 on an OOM in this repo before.)

`pnpm test:db` was not run: this cycle touches no server code, no query and no migration — the whole
diff is 11 files under `app/`.

The suite grew by **+4 tests** (all `mic.test.ts`) over cycle 66's 1,855 plus the 4 `useRigRender`
tests counted in the 1,859 baseline this branch inherited. No test files were deleted.

## Bundle

| Point | Client JS files | gzip total |
|---|---|---|
| Cycle 66 (the branch's inherited baseline) | 266 | 2,108,163 B |
| Cycle 67 (this handover) | **267** | **2,112,164 B** |
| **Delta** | **+1** | **+2,152 B (+0.10%)** |

Measured with deploy.yml's exact command and `.output/` removed first. **+2 KB gzip for a refactor is
the expected shape and worth saying so**: splitting one component into four moves code between chunks
rather than adding any, the one extra file is the code-split boundary the new children create, and
the only genuinely new source is `mic.ts` (23 lines) plus `useRigRender.ts` (59). The Elements
primitives `SpeakPane` now composes — `InputGroup`, `PromptInputFooter`, `PromptInputTools` — were
already in the client graph from cycles 64 and 65's `/agent` work.

Build memory was a non-event at 4096 MB, with cycle 65's `modules/tailwind-build-context.ts` doing
its job (that module is on the *other* unmerged branch and on this one only because this branch
descends from local master — see `next_seam`).

## The two documentation fixes this cycle owed

Both were flagged honestly by earlier tasks as out of their scope and carried forward:

1. **`VoiceSettingsSlideover` no longer exists.** Task 6's `git mv` renamed the auto-import, and
   `grep` over `app/` and `server/` came back clean — but `docs/wiki/agent.md` (3 references),
   `docs/wiki/voice-agent.md` (1) and `docs/handovers/2026-08-27-agent-surface-redesign.md` (3) all
   still named it. All are corrected. **The superpowers spec and plan files were deliberately left
   alone**: those are frozen records of intent at the time they were written, and a plan that says
   "rename X to Y" must keep saying X. The cycle-60 handover, being a record of what shipped, got the
   corrected name plus a parenthetical noting what the component was called then.
2. **`DesignPane.vue`'s "Load / reset on selection" comment cited three refs that had moved out.**
   It named `refError`, `refWarning` and `takes` as the reason the watcher must be declared low in
   the file — all three now live in the children. The comment now states the rule that still applies
   (`immediate: true` runs during setup, so everything the callback touches must already be
   initialised) and names what it actually touches today (`guard`, `draft`, `saveError`,
   `saveWarning`, `stopClock`), with the moved refs recorded as history rather than as live examples.

A stale code name in a "living" wiki page is exactly the failure mode this project's own rules call
out: a page that describes a component that does not exist sends the next session looking for it.
