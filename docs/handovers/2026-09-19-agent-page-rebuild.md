---
title: /agent rebuilt on AI Elements — a Rive Persona, the PromptInput composer, inline approvals and a context meter (cycle 65)
cycle: 65
date: 2026-09-19
status: >
  BUILT, NOT MERGED, NOT DEPLOYED. All 10 tasks (0-9) complete on `feat/agent-page-rebuild`,
  branched from LOCAL master `bc7c57b` — and local master is itself **30 commits ahead of
  origin/master and unpushed** (cycle 64 was merged locally and never pushed), so nothing in
  either cycle has reached prod. No migration to run (`contextWindow`, `contextTokens` and
  `modelDefId` are all additive jsonb/registry fields). Live-validated in a real browser
  against the real app with a live model (Haiku 4.5, picked in the composer's model select —
  the dev default reasoning chain's head, qwen @ `192.168.2.25:8004`, is down): **11 of 12
  items PASS, 1 PASS-with-defects** (item 10, `?q=` auto-send — the auto-send itself is
  correct, but validation found two real bugs on that path). Two defects were found and fixed,
  one commit each (`a4c5738`, `7674f45`); both proven in the browser against the pre-fix
  behaviour measured in the same session. Gates at the end of this cycle: `pnpm typecheck`
  exit 0 / `pnpm test` 209 files, 1837 tests / production build at 4096 MB passes
  (264 client JS files, 2,159,791 B gzip). **Carries a build fix master does not have** — see
  "The Tailwind build fix" below; without it a 4096 MB deploy build OOMs, and cycle 64 on
  local master is already at zero headroom.
branch: feat/agent-page-rebuild
spec: ../superpowers/specs/2026-09-19-agent-page-rebuild-design.md
plan: ../superpowers/plans/2026-09-19-agent-page-rebuild.md
docs:
  - ../wiki/agent.md (UPDATED — cycle bumped to 65; the cycle-60 "three-column surface" section
    replaced by the two-panel surface: Persona placements, the Elements composer, inline
    approvals, the context meter; the approval protocol (`tool-approval-request`,
    deny-on-interrupt/new/load) added to the WS section; usage `contextTokens`/`modelDefId` and
    `ModelDef.contextWindow` documented; the retired particle-head avatar recorded as deleted)
  - ../wiki/voice-agent.md (UPDATED — cycle bumped to 65; the "Bridget's avatar (cycle 60)"
    section and its head-mesh/bake/choreography/quality-tier subsections deleted and replaced
    by a short state-driven-Persona section incl. Rive's wasm path; the "Frontend files" list
    corrected for the files cycle 65 deleted)
  - ../BACKLOG.md (UPDATED — reconciliation preamble bumped to cycle 65; the cycle-60 "The 3D
    should be a face, not a sphere" complaint CLOSED by deletion rather than by shipping the
    head; the cycle-65 deferral block flipped to built; MyMind task `26fc248c` closed)
  - ../superpowers/plans/00-roadmap.md (UPDATED — cycle 65 row added)
  - ../../.claude/rules/web-nuxt.md (UPDATED during Task 7 — a Nitro-phase OOM is usually
    memory pinned from the Vite builds; keep `modules/tailwind-build-context.ts`)
tasks:
  - 3ddae408 (MyMind, cycle 65) — update to reflect BUILT/NOT MERGED (controller does this
    after mirroring)
  - 26fc248c (MyMind) — "approval banner outlives Stop; server `new` doesn't abort the running
    turn": CLOSED by Task 3 + Task 7 fix round 1 (`{type:'interrupt'}`, `{type:'new'}` and
    `{type:'load'}` all abort the turn AND deny pending approvals; the confirmation is part of
    the tool card, so it dies with the turn it belongs to)
shipped:
  - "Task 0 spike (the cycle's go/no-go) — AI Elements `persona`, `prompt-input`, `confirmation`,
    `context`, `suggestion`, `attachments` installed through cycle 64's token bridge (137 new
    files). `@rive-app/webgl2` added; `tokenlens` was pulled in by the CLI and removed again (net
    zero — the Context component's cost rows are patched out instead). Rive's wasm is served from
    OUR origin via a Nitro `publicAssets` entry (`/rive/rive.wasm`, 2,200,568 B raw / 708 KB
    brotli) with `RuntimeLoader.setWasmUrl` called before the first `new Rive`. Build at 4096 MB
    passed; client JS 264 files / 2,099,032 B gz — unchanged, because at that point only the
    prod-excluded `/dev/elements` fixture imported the new components (which is why the real
    bundle gate had to be re-run in Task 7)."
  - "`ModelDef.contextWindow: number | null` (Task 1) — registry `types.ts`/`schema.ts`/`resolve.ts`,
    the client `DraftModel`, and a \"Context window (tokens)\" field in `ModelForm.vue`. The
    implementer also caught that `server/api/settings/ai-config.put.ts` has its OWN zod body
    schema which would have silently stripped the new field — not in the brief, found by reading."
  - "Context accounting (Task 2) — `reasoningChain(modelDefId?)` now returns `{model, modelDefId}[]`
    so the id of the model that actually answered is known; `runAgent` tracks the LAST `finish-step`
    part's usage (the forced-final follow-up tracks its own and supersedes) and stamps
    `contextTokens` + `modelDefId` onto the `usage` event; `MessageUsage` gains both (additive jsonb,
    no migration); orchestrator/ui-stream/ws pass them through to `message-metadata` and persistence."
  - "Exec approvals ride the message stream (Task 3) — `ApprovalRequest` gains `callId`;
    `VoiceEvent` gains `approval-request`; the encoder maps it to the SDK's `tool-approval-request`
    chunk (opening an unstarted call first); `server/lib/voice/pending-approvals.ts` is a pure
    `denyPendingApprovals(state)`; `ws.ts` gained `ConnState.activeTurn` so `requestApproval` —
    fired from inside `exec` — can emit into the turn's own stream. `interrupt`, `new` and (after
    Task 7's fix round) `load` all abort the turn AND deny every pending approval, so a stopped
    approval can no longer block the next turn for up to the server's 120 s timeout."
  - "Pure client helpers (Task 4) — `app/lib/agent/persona.ts` (`personaState`, `personaVariant`,
    `warnPersonaFallbackOnce`), `context-meter.ts` (`contextMeterData`), `attachments.ts`
    (validation + upload mapping + `filesForSubmit`); `turn-stream.ts`'s `finalizeMessage` now
    finalizes an `approval-requested` part as `output-error` with `errorText: 'Stopped'`;
    `useVoiceSettings` gains `personaVariant` with migration/normalization."
  - "The Persona, the meter and the inline approval (Task 5) — `Persona.client.vue` (`.client` so
    exactly one Rive canvas ever mounts per placement; `loadError` → a CSS disc + ONE warn per page
    load via a module-scoped latch), `ContextMeter.vue` (Elements `Context`, cost rows removed;
    null usage → nothing, unknown window → the token count with no fake percentage),
    `ApprovalConfirmation.vue` (Elements `Confirmation` on the tool part: \"Run this?\" + the
    command, a remember checkbox and an EDITABLE always-allow pattern seeded from
    `proposedPattern`)."
  - "The Elements composer (Task 6) — `app/components/agent/PromptInput.vue` replaces
    `voice/Composer.vue`: attachments by picker/paste/drop with the same MIME + 4-file + 20 MB
    rules, the model select (with the `__default__` sentinel), the speak toggle, the context meter,
    the mic toggle and send/stop; below `sm` the model select + meter fold into a `…` action menu.
    Two fix rounds hardened submission: `filesForSubmit` sends exactly the snapshot that was
    submitted (a file dropped during the blob→dataURL window no longer gets swept into the
    in-flight turn), and the vendored `prompt-input/context.ts` `submitForm` gained a re-entrancy
    guard at the source (`if (isLoading.value) return`) so one Enter can never send twice."
  - "The page itself (Task 7) — `app/pages/agent/index.vue` is two panels (threads + conversation);
    the `agent-bridget` column, `showBridgetAvatar`, both `AgentAvatar` mounts and the detached
    `AgentApprovalPrompt` are gone. Full-bleed voice mode renders `AgentPersona size=\"full\"` with
    the caption and the mic band. `AgentToolbar` lost the speak switch and the model select (both
    live in the composer now). `SettingsSlideover` gained the Persona variant picker."
  - "The Tailwind build fix (Task 7 part B) — `modules/tailwind-build-context.ts`. See its own
    section below; this is the single most load-bearing thing on the branch."
  - "Deletion of the avatar subsystem (Task 8) — `agent/Avatar.client.vue`, `agent/ApprovalPrompt.vue`,
    `voice/Composer.vue`, `app/lib/avatar/**`, `app/lib/viz/**`, `scripts/bake-head.ts`,
    `scripts/blender-export-head.py`, `app/assets/head-points.bin`, the `bake:head` package script,
    `docs/DEPLOYMENT.md` §12's head-bake gotcha, and the viz event channel in `useVoice`/
    `lib/voice/messages.ts` (`events`, `onVizEvent`, `VizEvent`). 31 files, +32/-3945. `three`
    stays — Galaxy still uses it."
  - "Self-hosted `.riv` files (controller add-on, `9a42a88`) — the four shippable Persona variants
    are served from `public/persona-riv/` instead of Vercel's blob host. See \"The .riv files moved
    to our origin\" below, including the directory-naming trap."
deferred:
  - "**The protocol fix behind `restAfterAbort()` — MyMind task `9e5b44da-1003-4d58-9c1c-2af4a2250cb8`.**
    An aborted turn emits no terminal state (`server/lib/voice/orchestrator.ts:202` returns before
    the idle emit), so every client path that aborts has to put the UI back to rest itself. That is
    UI compensation over a protocol gap, and it races a late frame from the turn being torn down.
    The race-free fix is to emit a terminal state at the abort exit and delete `restAfterAbort()`.
    Deferred deliberately (see the ruling below): `stop()` has carried the identical race since
    cycle 60, so this is not a regression, and reopening the frame contract at the end of the cycle
    was judged the larger risk. `server/lib/voice/orchestrator-abort-exit.test.ts` pins the current
    server behaviour, so it goes red the moment someone does it properly."
  - "**An approval with no `toolCallId` would block invisibly for 120 s — unproven, not fixed.**
    `server/api/voice/ws.ts:110` only emits the `approval-request` event (and therefore the inline
    Confirmation) when `req.callId` is truthy, while `server/lib/agent/ai-tools.ts:30` coerces a
    missing `opts.toolCallId` to `''`. Cycle 65 deleted `ApprovalPrompt.vue`, so there is no longer
    a detached banner to catch that case: such an approval would render NO UI at all and sit until
    the server's 120 s timeout denies it, with the composer stuck on Stop meanwhile. The final
    reviewer could not demonstrate a path where the AI SDK omits `toolCallId` — in every observed
    call it is present — so this is a latent hazard, not a known break. Deliberately not touched:
    re-opening approval gating at the end of the cycle on an unproven path is the worse trade. Next
    session: either prove it unreachable and delete the `callId` guard's else-branch worry, or make
    `requestApproval` synthesise a callId so the UI always renders."
  - "**A send with the socket down loses the typed text — PRE-EXISTING, not a regression.**
    `app/components/agent/PromptInput.vue:108` awaits `props.sendText(...)` and discards its
    boolean; `useVoice.sendText` returns `false` (it does not throw) when the WS will not open, so
    the vendored `submitForm` treats it as success and clears the composer. Verified by the final
    reviewer against `bc7c57b:app/components/voice/Composer.vue:210`, which discarded the same
    boolean — cycle 65 carried the behaviour across verbatim rather than introducing it. Fix when
    touched: have `onSubmit` throw when `sendText` resolves false, which the provider's existing
    catch already turns into text-restored + files-kept + an error toast."
  - "**Not fixed, found in live validation (item 10 follow-on):** subagents still never inherit the
    composer's model override — `research_web`/`search_brain` always resolve the default reasoning
    chain. Pre-existing cycle-45 scope boundary, MyMind task `6c72627d`, explicitly out-of-scope in
    the spec."
  - "**Not fixed, observed in live validation:** after a Stop that had a pending approval, Haiku
    re-proposed the SAME command on the very next turn (twice, reproducibly: `uname -a` then
    `ls /opt`), so that turn also gated on an approval. That is the model resuming interrupted work
    from history — the assistant text on one of those turns reasoned about both the stopped command
    AND the new message — not a server replay of a stale approval. Recorded because it looks exactly
    like a replay bug and cost real time to rule out."
  - "**Not fixed, cosmetic:** the context-meter hovercard renders an empty bordered box under the
    ring/figures. `ContextMeterData` carries no input/output breakdown, so Elements'
    `ContextContentBody` rows render nothing but the container still paints. Noted in Task 5's
    report; visible in `task-9/02c-context-meter-hover.png`."
  - "**Not fixed, cosmetic:** `obsidian` (the DEFAULT variant) renders as a very pale, low-contrast
    orb in light mode — measured mean luminance 0.911 against an off-white page, the palest of the
    four. It is genuinely visible (unlike `halo`/`command`, which were pure white and were removed
    in Task 7), but it is the weakest default of the set. `mana` (0.786) and `opal` (0.889) read
    much better in light mode. Worth a look with Tony before merge; a one-line default change."
  - "Deferred minors carried from the SDD ledger, none blocking: the model zod shape is duplicated
    between registry `schema.ts` and `ai-config.put.ts` (derive the PUT body from `modelSchema`);
    no test that `resolveChainFrom` propagates a NON-null `contextWindow`; `ws.ts`'s
    `activeTurn`/`denyAll` wiring has no automated test (no crossws harness exists for any part of
    `ws.ts`); `ws.ts` mixes the `TurnStream` and `ReturnType<typeof createTurnStream>` aliases;
    `attachmentErrorToast`'s default duplicates the `submit_error` literal; no test for
    `uploadAttachment`'s `r.name ?? file.name` fallback; `useVoiceSettings` imports
    `personaVariant` + `PersonaVariant` in two statements; `ContextMeter` uses
    `text-muted-foreground` instead of Nuxt UI's `text-muted`; the unknown-window meter trigger uses
    `aria-label` (which replaces the count) where `aria-describedby` would be better; the model
    select + context meter markup is duplicated inline and in the mobile action menu;
    `ApprovalConfirmation.vue:3` still mentions the deleted `ApprovalPrompt.vue` in prose."
  - "From Task 7's build investigation, tested but NOT applied (each would cut prod-build memory
    further): server sourcemaps off (−153 MB); limiting the Nuxt Icon server bundle to `lucide`
    (−105 MB — `simple-icons`' 4.6 MB JSON is bundled and unused, worth its own follow-up);
    `.client.vue` for the agent components; per-icon `@lucide/vue` imports."
  - "Peak RSS for the production build is still ~3.8-4.5 GB after the Tailwind fix. The 4096 MB
    heap is no longer the binding constraint, but headroom on LXC 114 is not generous."
next_seam: >
  Cycle 66 — `/sessions/[id]` rendered on the same AI Elements components (MyMind task
  `14d0074b`). Nothing in that scope should need to touch `ui-stream.ts`, either `turn-stream.ts`,
  `to-ui-messages.ts`, or the Persona/composer work this cycle shipped: `/sessions/[id]` reads
  persisted rows, so the seam it needs is `toUIMessages` (already the single resume path) plus
  whatever of `Conversation.vue`/`ToolPart.vue` can be lifted out of the agent-specific props
  (`approval`, `state`, `connected`). Before starting it, decide whether to merge + PUSH this
  branch AND cycle 64: local master is 30 commits ahead of origin and the Tailwind build fix lives
  only here.
---

# /agent rebuilt on AI Elements (cycle 65)

## What shipped

`/agent` is now built from AI Elements end to end. Cycle 64 moved the *conversation* onto AI SDK
`UIMessage`s; this cycle rebuilt the page around it:

- **Two panels, not three.** The `agent-bridget` column is gone. A **Rive Persona** takes its place
  in three positions — a hero in the empty thread, a 28 px live one in the composer footer once the
  thread has messages, and a large one in full-bleed voice mode. Exactly one Rive canvas is mounted
  at any time.
- **The particle head is deleted**, along with the whole `lib/avatar` + `lib/viz` stack, the Blender
  export + bake pipeline, and the committed `head-points.bin`. This closes the cycle-60 complaint
  "the 3D should be a face, not a sphere" **by removing the feature**, not by shipping the head —
  which is the honest outcome, because the head was blocked on a human MakeHuman export that never
  happened and Tony had already said he never liked the result.
- **`AgentPromptInput` replaces `voice/Composer.vue`** — attachments (picker, paste, drop), the model
  select, the speak toggle, the context meter, the mic toggle and send/stop, all in one Elements
  composer. Below `sm` the model select and meter fold into a `…` action menu.
- **Exec approvals are inline on the tool part.** The detached yellow banner is deleted. The approval
  now rides the message stream as the SDK's own `tool-approval-request` chunk, so the Confirmation
  renders inside the `Exec` tool card it belongs to — and dies with the turn it belongs to.
- **A context meter** in the composer shows how full the answering model's context window is.

## The Tailwind build fix — read this before merging anything

`modules/tailwind-build-context.ts` (`734fc7e`, hardened in `921df6b`) is the most load-bearing
file on this branch, and it is the one that has nothing to do with `/agent`.

Task 7's implementer was BLOCKED: the production build OOM'd in the **Nitro** phase at deploy.yml's
4096 MB heap, 3 runs out of 3. The investigation found it was **not the page** — the branch's base
commit `d486eca` OOM'd too, and so, by implication, does **cycle 64 on local master**. The page work
added ~37 MB of live heap on top of a build that already had roughly zero headroom.

Root cause, from a heap snapshot rather than a guess: Nuxt's `vite:serverCreated` hook →
`ctx.config.plugins` → `@tailwindcss/vite`'s roots cache → its cached compiler → an `onDependency`
closure → the `transform` hook's `this` (the Rollup plugin context) → **the entire Rollup module
graph**. Both the client and SSR graphs (~2.1 GB) stayed pinned all the way through the Nitro build.
The exit heap profile put ~3.5 of 3.7 GB in Rollup internals.

The module gives Tailwind's build transform a **call-scoped `Proxy` stand-in** for `this` that
exposes only `environment` and `addWatchFile`, forwards to the real context during its own call, and
throws afterwards — so the graph is released the moment the transform returns. Production builds
only. If `@tailwindcss/vite` is ever reshaped, the module warns and no-ops rather than breaking the
build (and the warning says, in as many words, that a 4096 MB deploy build will likely OOM again).

| Build | 4096 MB | 3584 MB | Live heap before Nitro | Peak RSS |
|---|---|---|---|---|
| base `d486eca` (no page work, no fix) | **OOM** | — | 2,802 MB | 5.12 GB at crash |
| Task 7 HEAD (page work, no fix) | **OOM** | — | 2,839 MB | 4.93 GB at crash |
| with `modules/tailwind-build-context.ts` | **pass** | **pass** | **719 MB** | 4.51 GB |

Client output was verified byte-identical with and without the fix (the Vue SSR output differs only
in key order inside `styles.mjs`), so this is purely a memory fix.

**Consequence for whoever merges:** master likely OOMs intermittently on a prod deploy *today*, and
the fix exists only on this branch. Ship it with or before cycle 64. The diagnostic recipe — measure
**live** heap with `node --trace-gc` (NODE_OPTIONS rejects `--trace-gc`), not RSS or chunk counts;
the prod buildDir is `node_modules/.cache/nuxt/.nuxt`, not `.nuxt` — is now in
`.claude/rules/web-nuxt.md`.

## The `.riv` files moved to our origin

The spec locked D6 as "`.riv` files load from Vercel's URL, as upstream does" because their licence
is unstated. After Task 8 the controller re-read the vendored `Persona.vue` and made a different
call: `/agent`'s core visual on an internet-exposed homelab box was depending on
`ejiidnob33g9ap1r.public.blob.vercel-storage.com`, a bucket we do not own, and if it 404s the page
silently degrades to the CSS disc everywhere. The four variants we ship are now committed under
`public/persona-riv/` (obsidian 7,959 B + mana 8,082 B + orb-1.2/opal 10,178 B + glint 4,630 B ≈
30.8 KB) with the vendored sources map patched to local paths (`9a42a88`).

**Trap, found the hard way:** the directory **cannot be named `rive-*`**. Nitro's `publicAssets`
entry for Rive's wasm has `baseURL: 'rive'`, and that **prefix-matches** — `public/rive-personas/*.riv`
404'd because Nitro routed those requests into the wasm asset dir. Renaming to `persona-riv` fixed
it. If you ever move these files, keep them off the `rive` prefix.

Task 7 also removed two variants from the picker entirely: **`halo` and `command` render pure white
regardless of theme** (the `dynamicColor` view model doesn't respond), which means invisible in light
mode. `PERSONA_VARIANTS` is now `obsidian | mana | opal | glint`, and a stored `'halo'`/`'command'`
normalizes to `obsidian`. Those two are still pointed at the CDN in the vendored sources map, since
nothing can reach them.

## Rulings (from the SDD ledger, with cost-if-wrong)

- **The worktree branched from LOCAL master `bc7c57b`, not `origin/master`** — cycle 64 and this
  cycle's spec/plan are unpushed. *Cost if wrong:* none.
- **Commit messages carry no `Co-Authored-By` trailer and no model names** (Tony's global CLAUDE.md
  overrides the harness reminder) — stated in every dispatch. *Cost if wrong:* a rewrite of history.
- **Subagents cannot write report files in this harness** (carried from cycle 64) — every dispatch
  asked for the full report in the final message and the controller transcribed `task-N-report.md`.
  *Cost if wrong:* none.
- **MyMind mirroring and task updates are done by the CONTROLLER, not a subagent** (it mints a
  temporary prod token per the `wiki-mirror` skill). *Cost if wrong:* a leftover token (mitigated:
  delete + verify).
- **Re-run the 4096 MB build gate in Task 7, not only in Task 8** — Task 0's spike numbers didn't
  include the real wiring, because only the prod-excluded `/dev/elements` fixture imported the new
  components. *Cost if wrong:* an extra ~5 min build. **This ruling is what caught the OOM**; without
  it the branch would have reached Task 8 with a build that could not deploy.
- **Keep `Persona.vue`'s added `srcOverride` prop** — the fixture's proof of the `loadError` path and
  the seam a self-hosted `.riv` would need. *Cost if wrong:* a small divergence from upstream to
  re-apply on CLI updates. (It later became exactly that seam.)
- **Task 1 leaves the LOCAL DEV Haiku model's `contextWindow` at 200000** (every other model
  restored) so later validation has a real ring to look at. *Cost if wrong:* one dev-only config
  value.
- **Accept file-name-less attachment toast copy** — the plan mandated `'<name>: Only images…'`, but
  `PromptInput` validates per batch and its `onError` carries only `{code, message}`, so the file
  name is not available. The rules and limits themselves are unchanged. *Cost if wrong:* a less
  specific toast when one of several files is rejected.
- **The unknown-context-window meter showing "0%" / "1.8K / 0" is Important, not cosmetic** (the spec
  says an unknown window shows the count with no ring or percentage) — folded into Task 5's fix
  round. *Cost if wrong:* a slightly larger fix round.
- **The missing re-entrancy guard during an upload is Important** — the old composer's `uploading`
  flag prevented a second Enter re-sending the same attachments, and the new one lost it. Folded into
  Task 6's fix round. *Cost if wrong:* a slightly larger fix round.
- **Guard re-entrancy in the vendored `prompt-input/context.ts` `submitForm` itself**
  (`if (isLoading.value) return`), not in `AgentPromptInput`'s `onSubmit` — a guard in the caller
  still let the raced `submitForm` clear in-flight files and flip `isLoading`. Recorded in-file as a
  MyMind patch. *Cost if wrong:* one more divergence from upstream to re-apply on CLI updates.
- **Commit Task 7's page work as-is, then investigate the Nitro memory with a more capable model,
  cutting SSR weight first; raising the prod/CI heap stays Tony's decision** (LXC 114 memory).
  *Cost if wrong:* an investigation that ends in a heap-bump recommendation anyway. (It did not — see
  above.)
- **Fold seven review findings into one Task 7 fix round** — the Proxy stand-in + its unit tests (a
  future Tailwind update would otherwise silently break or re-OOM the build), the duplicate MicBand
  in voice mode, the voice-mode Persona overflow on short viewports, a stale comment, and `ws.ts`'s
  `load` aborting the running turn + denying pending approvals. *Cost if wrong:* a larger fix round.
- **Task 8's delete list also takes the tests for the deleted modules** (`test/viz-emitter.test.ts`,
  `test/viz-choreographer.test.ts`, `test/bake-head.test.ts`) — a test for deleted code is dead
  weight, and the task's own grep gate cannot pass while they exist. The two surviving mentions are
  comments (`app/lib/galaxy/scene.ts:14,628`, `app/components/agent/MicBand.vue:22`) and were
  reworded, not deleted. `three` is imported only by `app/lib/galaxy/scene.ts` outside the deleted
  tree, so the dependency stays. *Cost if wrong:* three test files to restore from git.
- **Keep `restAfterAbort()`'s UI compensation; do not reopen the voice protocol this late in the
  cycle** (Task 9 review, I2). The race-free fix is server-side — emit a terminal state at the abort
  exit (`server/lib/voice/orchestrator.ts:202`) so the client is *told* it is done instead of
  assuming it; setting state locally races a late frame from the turn being torn down. It was kept
  because `stop()` has carried the identical race since cycle 60, so this is not a new hazard, and
  because changing the frame contract at the end of the cycle is the larger risk. *Cost if wrong:*
  the composer can still wedge in a much narrower window — bounded by behaviour that already shipped
  for `stop()`. Mitigated by `server/lib/voice/orchestrator-abort-exit.test.ts`, which pins the
  server half so the compensation can be deleted the moment that test goes red. Deferred as MyMind
  task `9e5b44da-1003-4d58-9c1c-2af4a2250cb8`.
- **Self-host the four shipped `.riv` files and point the vendored sources map at local paths**,
  against the spec's D6. *Cost if wrong:* ~31 KB committed and one more vendored file to re-patch on
  upgrade — weighed against an unowned runtime dependency for the main agent surface's core visual.
  Also checked before committing to it: `hasModel`/`dynamicColor` gate only COLOUR theming; the
  `listening`/`thinking`/`speaking`/`asleep` inputs are driven through `stateMachineInputs` for every
  variant, so `opal` and `mana` still animate per state.

## Planning note the plan got wrong

**Task 8's deletions barely moved the bundle: −7,303 B gzip (−0.34%), 264 client JS files before and
after.** The plan expected "the agent route should shrink". It was wrong, and the reason is worth
recording: Task 7 had already rewritten the page to mount `Persona` instead of `AgentAvatar`, so
`Avatar.client.vue` and everything under `lib/avatar` / `lib/viz` was *already unreferenced* and
Vite had *already* tree-shaken it out of the build. Task 8 is a source-tree and dependency-graph
cleanup — it removes 3,945 lines, the bake pipeline, the `three`-adjacent duplicate code and the
grep noise — not a weight win. Judging it by the bundle number would have read as "the gate
under-delivered" when nothing was wrong.

For the cycle as a whole, measured with deploy.yml's exact command:

| Point | Client JS files | gzip total |
|---|---|---|
| Task 0 (spike, before real wiring) | 264 | 2,099,032 B |
| Task 7 (page wired to Elements) | 264 | 2,167,471 B |
| Task 8 (avatar stack deleted) | 264 | 2,160,168 B |
| Task 9 (this handover: `9a42a88` + the two fixes) | 264 | **2,159,791 B** |

Net cost of putting `/agent` on Persona + PromptInput + Confirmation + Context is **+60,759 B gzip**
(+2.9%) over the spike baseline, plus two static assets that are not in the JS graph at all: Rive's
wasm (2.2 MB raw / 708 KB brotli) and the four `.riv` files (~31 KB). Task 9's build is the first one
that covers `9a42a88`; the −377 B against Task 8 comes from this task's two fix commits, not from the
`.riv` files — those are `public/` assets, not modules, and never enter the JS graph.

## Live validation (playwright-cli, dev on :3219, Haiku 4.5 selected in the composer)

Screenshots under `.superpowers/sdd/2026-09-19-agent-page-rebuild/task-9/` (gitignored workspace
evidence, not committed). Dev server started as
`PORT=3219 BETTER_AUTH_URL=http://localhost:3219 pnpm dev` — `PORT` alone makes every sign-in fail
with better-auth's "Invalid origin".

| # | Item | Result |
|---|---|---|
| 1 | Empty state: hero Persona animates; a suggestion prefills the composer | **PASS.** The hero Rive canvas is genuinely animating, not a static frame: two screenshots 600 ms apart differ in 13,809 of 25,600 pixels (`magick compare -metric AE`). Clicking "What are my open tasks?" put exactly that text in the textarea and sent nothing (`textarea.value` set, zero message nodes). `01-empty-state-1440-light.png`, `01b-suggestion-prefilled.png`. |
| 2 | A typed turn: inline Persona thinking → idle; reply renders; the context meter shows a % | **PASS.** Haiku's `contextWindow` was already 200000 from Task 1, so the ring had a real denominator. The reply rendered as markdown (numbered list, bold lead-ins); the meter read 6.4% and its hovercard "6.4% · 13K / 200K" with a filled bar. Persona state was read straight off the live component (`__vueParentComponent` → `AgentPersona.props.state`) rather than inferred: mid-turn samples with the composer busy measured mean canvas luminance 0.810 / 0.785 / 0.797, settled samples 0.859-0.872 — a clean separation, and a control (two IDLE frames 600 ms apart) confirmed the raw pixel-diff count does NOT discriminate state, so the luminance separation is the real signal. `02a-midturn.png`, `02b-settled.png`, `02c-context-meter-hover.png`. |
| 3 | Inline exec approval: Deny → Denied; ask again, Approve with remember + edited pattern | **PASS.** "Check disk usage on the app box" rendered the Confirmation **inside** the `Exec` tool card: "Run this?", `df -h`, a remember checkbox and a disabled pattern field pre-filled `df *`. Deny → the card flipped to **Exec / Denied** and the confirmation vanished. Asked again, checked remember (which enabled the pattern field), edited the pattern to `df -h*`, Approve → the gate released and the tool RAN. `GET /api/settings/exec-approvals` went from `[]` to one row with `pattern: "df -h*"` — the EDITED pattern, persisted. *Environment caveat, not a UI defect:* the command itself returned `exec is disabled: native exec requires running as root in the LXC`, so the card settled on **Error**, not Completed — dev is macOS. What was under test (the gate, the inline UI, the remember/pattern write) all worked. `03a`-`03d`. |
| 4 | Stop while an approval is pending → tool "Stopped", confirmation gone, next message runs immediately | **PASS.** The tool card finalized to `Exec / Error` with `ERROR: Stopped` in its body and "stopped" under the message (`finalizeMessage` maps `approval-requested` → `output-error` + `errorText: 'Stopped'`; "Error" is the badge, "Stopped" is the text). The Confirmation disappeared. The next message's server echo arrived **4 s** after Enter — against the 120 s pending-approval timeout this was blocking before Task 3. `04a`, `04b`, `04c`. |
| 5 | New conversation while a turn runs → the old turn doesn't appear in the new thread | **PASS**, asserted with the turn provably in flight: immediately before the click, `busy: true`, the marker string visible, 540 characters already streamed. After the click: empty state, marker absent, and still absent across ~8 s of polling. `05a-turn-in-flight.png`, `05b-new-thread-clean.png`. **This item is also where defect 1 below was found** — the assertion under test passed, but the composer stayed stuck. |
| 6 | Speak mode: Persona speaking during playback | **PASS.** With "Voice replies" on, the Persona's mapped Rive state read `speaking` on 25 consecutive samples through the whole TTS playback, then returned to `idle` once playback drained. Read off the component, not guessed from pixels. `06-speak-mode.png`. |
| 7 | Voice mode: full Persona + caption + mic band; Escape exits | **PASS.** One `AgentPersona` at `size: "full"` (plus the MicBand's separate 2D canvas — exactly what Task 7's fix round was supposed to produce; no second Rive canvas), the reply rendered as a caption, `MIC OFF` + the waveform band at the bottom. Escape returned to the two-panel layout with the Persona back at `size: "inline"`. `07a-voice-mode-1440-light.png`. |
| 8 | Mic on: band above the composer | **PASS.** The sandbox denies the mic by default, so permission was granted through Playwright (`context.grantPermissions(['microphone'])`) rather than skipped. The band then rendered as a 1064×55 canvas at y=725, directly above the composer at y=790, showing `LISTENING`. `08-mic-band-above-composer.png`. |
| 9 | Attachments: image + PDF via button, paste, drop → render in the user message; the agent can read the image | **PASS.** Picker: a generated PNG (a magenta disc captioned ZEBRA) + a PDF both landed in the tray. Sent with "What single word is written on the attached image?" — the agent answered **ZEBRA**, so the image genuinely reached the model. In the user message the image rendered as a real thumbnail (`/api/images/…/raw`, `naturalWidth` 640) and the PDF as a download chip (`/api/agent/files/…`). Drop: `playwright-cli drop` put a file in the tray. Paste: playwright-cli has no clipboard primitive, so a real `ClipboardEvent` carrying a real `File` was dispatched on the textarea, exercising `PromptInputTextarea.handlePaste` — it appeared in the tray alongside the dropped one. Remove cleared both. `09a-attachment-tray.png`, `09b-drop-and-paste.png`. |
| 10 | `?q=` from Home's "Ask the brain" auto-sends once | **PASS on the assertion, but the path had two real defects** (both now fixed — see below). The auto-send fires exactly once and the `q` param is stripped from the URL: across three separate runs and ~15 s of polling each, the marker appeared exactly once and `location.search` was empty. What was broken: the composer was left holding the sent text, and the turn ran on the wrong model. After the fix (`7674f45`): the textarea is empty and the auto-sent turn answers on the picked model. `10-qparam-autosend.png`, `10b-qparam-second-run.png`, `15-qparam-fixed.png`. |
| 11 | Resume an older thread (meter hidden until the next turn) and a cycle-65 thread (meter shown) | **PASS.** A 2026-08-28 thread resumed with **no meter** in the composer. Sending one turn in it made the meter appear at 5.9%. Resuming a thread created during this cycle showed the meter (6.6%) immediately on load, with no turn needed. `11a-legacy-resume-no-meter.png`, `11b-legacy-meter-after-turn.png`, `11c-cycle65-resume-meter.png`. |
| 12 | Variant picker switches the Persona; Persona fallback | **PASS.** The picker offers exactly the four surviving variants. Each selection changed the vendored `Persona`'s `variant` prop and fetched its file **from our own origin** — `/persona-riv/obsidian-2.0.riv`, `mana-2.0.riv`, `orb-1.2.riv`, `glint-2.0.riv`, all 200, zero requests to the Vercel blob host. All four render distinct, non-blank artwork at hero size (`12-variants-montage.png`; means 0.911 / 0.786 / 0.889 / 0.941, stddevs 0.066-0.139). Fallback: `playwright-cli route "**/persona-riv/*.riv" --status 404` then reload → zero canvases, the CSS disc (`size-40 shrink-0 rounded-full bg-primary/20`, `role="img"` `aria-label="Bridget"`), and **exactly one** `[persona] falling back:` warning, proving Task 5's module-scoped once-per-page latch. `12-fallback-disc.png`. |

**Also swept (not numbered items):** dark mode at 1440 with a live turn (`13a-turn-1440-dark.png`),
375 px in dark and light (`14a`, `14b`) — `scrollWidth === clientWidth === 375`, composer 373×64, the
model select and meter folded into the `…` menu — and full-bleed voice mode at 375 px
(`14c-375-voicemode.png`), which fits without overflow.

## Defects found in live validation, and fixed

Two, both committed separately, both proven in the browser. Neither was unit-testable in this
harness: `useVoice()` needs Nuxt auto-imports and a WebSocket, and the second bug lives in the
interaction between a `.vue` SFC tree and a DOM textarea — no test in this repo imports a `.vue`
file, and neither `@vitejs/plugin-vue` nor `@vue/test-utils` is installed. Both were instead proven
by the `browser-testing` skill's controlled-probe rule: the pre-fix behaviour was measured first, in
the same session, on the same code path.

### 1. `a4c5738` — a new or resumed thread left the composer stuck on "Stop generating"

Found while validating item 5. Clicking **New conversation** while a turn was running cleared the
thread correctly (item 5 passed) but left the composer showing **Stop generating** — measured still
busy **two minutes later**, across 15 consecutive polls. In that state the new thread cannot be typed
into at all; the only escape is pressing Stop.

Root cause: an aborted turn **produces no `state:'idle'` frame**. `orchestrator.ts` returns early the
moment its signal is aborted (`if (deps.signal.aborted) return messages`), before the line that emits
idle. `stop()` had always compensated client-side with `state.value = 'idle'`;
`newConversation()` and `loadConversation()` abort the turn exactly the same way (`ws.ts` calls
`s.ac?.abort()` for both `{type:'new'}` and `{type:'load'}`) and never did. Pre-existing — it traces
back to cycle 60's `c8caadc`, not to this cycle — but it lands squarely on the new composer, whose
Submit button is replaced by Stop while busy.

Both paths now share a `restAfterAbort()` helper with `stop()`, which also calls `stopPlayback()` —
so starting a new thread mid-reply no longer leaves the old thread's TTS talking into it.

Verified: turn in flight (`busy: true`) → New conversation → `busy: false, submit: true` on the very
first poll and every one after; same for resuming another thread from the rail, with no leakage from
the aborted turn. `16-new-conversation-recovers.png`.

### 2. `7674f45` — `?q=` auto-sent before the page was ready

Found while validating item 10. `AgentPromptInput` auto-submits the instant it sees `initialText`,
and its watcher is `{immediate: true}` — so a value present at **setup** submitted before anything
else on the page had run. Two consequences:

1. **The turn went out before `voice.setModel()`.** The page's `onMounted` does
   `connect()` → `loadAiConfig()` → `setModel()`, all async; the auto-send beat it. So `?q=` always
   ran on the **default chain**, never the model the picker was showing. In dev that is fatal rather
   than cosmetic: the default chain head is down, so the turn produced no reply at all and persisted
   only the user message. Confirmed in the dev server log —
   `Failed after 3 attempts. Last error: Cannot connect to API: connect ECONNREFUSED 192.168.2.25:8004` —
   while the picker on screen read "Haiku 4.5".
2. **The composer kept the sent question.** `submitForm()` clears `textInput`, but a clear that lands
   before the textarea subtree has mounted never reaches the DOM: `ui/textarea`'s
   `useVModel(..., { passive: true })` proxy is seeded from the pre-clear value. Instrumented from
   page load (a `page.addInitScript` sampler reading both the provider ref and the DOM every 40 ms):
   the provider's `textInput` was `""` while the DOM textarea still showed
   `"Reply with exactly: QMARKFOUR"` — it never passed through empty once. One stray Enter away from
   sending the same question twice.

Fix: the page holds the question in a `handoffText` ref and hands it to the composer at the **end** of
its own `onMounted`, after connect + config load + `setModel`. That fixes both at once — the model is
applied first, and the clear becomes an ordinary post-mount transition like every manual send (which
always cleared correctly, which is what pointed at mount order in the first place). A comment on
`PromptInput.vue`'s watcher records the constraint for future callers.

Verified after the fix: `textarea.value === ""` on every poll, and the auto-sent turn produced a real
reply with usage — 2 marker hits (user + assistant) where the pre-fix runs had 1 and no reply.
`15-qparam-fixed.png`.

## Operational notes (pre-existing, not introduced this cycle)

- **The dev reasoning chain's head is down** (`qwen3.6-35b-a3b` @ `192.168.2.25:8004`), and `runAgent`
  does not fail over on a connect error that surfaces after the stream is constructed. Pick a
  reachable model in the composer's model select for any live turn. Carried from cycle 64.
- **Subagents never inherit the model picker** — `research_web`/`search_brain` always call `runAgent`
  with no `modelDefId`, so they always resolve the default chain. Deliberate cycle-45 scope boundary,
  MyMind task `6c72627d`, explicitly out-of-scope in this cycle's spec.
- **`exec` is disabled on a macOS dev box** ("native exec requires running as root in the LXC"). The
  approval gate, the allow-list and the inline UI are all exercisable; the command's own output is
  not.

## Measured gates

```
pnpm typecheck                                    → exit 0, 0 errors
pnpm test                                          → 209 files, 1837 tests passed
NODE_OPTIONS=--max-old-space-size=4096 pnpm build  → exit 0, "Build complete!",
                                                     .output/server/index.mjs present (939 B)
                                                     264 client JS files / 2,159,791 B gzip
                                                     total output 70.9 MB (20.9 MB gzip)
```

(Success is `.output/server/index.mjs` existing plus "Build complete!", not an exit code —
`/usr/bin/time` has reported 0 on an OOM here before. The build figures are from the Task 9 gate run;
Task 9's review fix round changed only `.vue`/`.ts` source and one new test file, so the build was not
re-run for it.)

Baseline at cycle start: 205 files / 1882 tests. The suite is **smaller** than it started, by design:
Task 8 deleted five test files (95 tests) belonging to the deleted viz/avatar/bake modules, against
new tests added across Tasks 1-7. The reviewer independently counted the 95 deleted tests against the
1921 → 1826 delta rather than taking the number on trust. The final 208/1830 adds the review fix
round's `server/lib/voice/orchestrator-abort-exit.test.ts` (4 cases) on top of that 207/1826.

## Deleted this cycle

`app/components/agent/Avatar.client.vue`, `app/components/agent/ApprovalPrompt.vue`,
`app/components/voice/Composer.vue`, `app/lib/avatar/**` (particle-head, head-buffer, choreography,
types + 2 tests), `app/lib/viz/**` (emitter, tuning, lightning, types, scene, core, effects,
choreographer), `scripts/bake-head.ts`, `scripts/blender-export-head.py`,
`app/assets/head-points.bin`, `test/viz-emitter.test.ts`, `test/viz-choreographer.test.ts`,
`test/bake-head.test.ts`, the `bake:head` package script, `docs/DEPLOYMENT.md` §12's head-bake
gotcha, and the viz event channel (`events`/`onVizEvent`/`VizEvent`) from `app/composables/useVoice.ts`
and `app/lib/voice/messages.ts`. `three` stays — `app/lib/galaxy/scene.ts` still uses it.
