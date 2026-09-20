---
title: "Voice studio — split DesignPane, SpeakPane on PromptInput, two real fixes (cycle 67)"
cycle: 67
date: 2026-09-20
status: spec
supersedes: null
mymind_task: d321c732
---

# Voice studio refactor (cycle 67)

Cycle 4 and last of the "agent surfaces on AI Elements" program. Cycle 64 moved `/agent`'s
conversation onto AI SDK `UIMessage`s rendered with AI Elements Vue; cycle 65 rebuilt the `/agent`
page; cycle 66 brought `/sessions/[id]` onto the same row components with pagination and filters.

This cycle finishes the program in the voice studio — and is deliberately **smaller** than the
three before it, because measuring the original intent found most of it empty.

## What the program said, and what is actually true

The deferred line read: *"Cycle 67 — voice studio + Home on shared AI Elements voice pieces and
`PromptInput`."* Two thirds of that did not survive contact with the code.

**Home is out of scope.** `app/components/home/AskBrain.vue` is 23 lines: a `UInput` that navigates
to `/agent?q=` and never sends. Turning it into a full composer was offered and declined — it would
add attachments and a model picker to a box whose whole job is to hand a question to the page that
already has both.

**"Shared voice pieces" had nothing to share.** Measured in every direction:

- `AgentMicBand` is imported only by `/agent`; `WaveformTrack` only by the studio
  (`DesignPane`, `SpeakPane`). They visualise different things — a live level band against
  levels-over-time with a duration — so merging them would force two shapes into one.
- No component is duplicated between the two surfaces. They are genuinely disjoint.

What the search **did** surface were two real defects, and they replace that goal:

1. **`app/components/voice/SettingsSlideover.vue` is misfiled.** Its only consumer is
   `app/pages/agent/index.vue:338`. It is an agent component living in the voice folder, and
   cycle 65 added the Persona picker to it there.
2. **The studio ignores the user's chosen microphone.** `useVoice.ts:331-346` honours the saved
   `micDeviceId` and falls back — clearing the stale setting — when the exact device is gone.
   `DesignPane.vue:473` calls bare `getUserMedia({ audio: true })`. Picking a microphone in
   settings therefore does nothing for reference-clip recording.

## Scope

| In | Out |
| --- | --- |
| Split `DesignPane.vue` (1,101 lines) into three children plus one composable | Home / `AskBrain.vue` |
| `SpeakPane`'s textarea onto `PromptInput` — chrome only | Extracting shared components between `/agent` and `/voice` |
| Move `SettingsSlideover.vue` to `components/agent/` | Unifying mic acquisition across `useVoice` and `DesignPane` |
| Make the reference-clip recorder honour `micDeviceId` | `voice.vue`'s ownership of the draft form state |

## Architecture

### 1. Splitting `DesignPane.vue`

1,101 lines — 572 of script, 527 of template — with one pair of props (`preset`, `draft`) and one
emit (`saved`).

**Children, not composables.** Every section carries both UI and logic. Extracting the logic into
composables while leaving a 527-line template behind would split by technical layer, which is what
makes a file unholdable in the first place. Each child owns its section end to end:

| New component | Owns |
| --- | --- |
| `app/components/voice/DesignDescription.vue` | the description field and the starter descriptions |
| `app/components/voice/DesignSeedAudition.vue` | seed audition and the kept-seeds strip |
| `app/components/voice/DesignReferenceClip.vue` | recording, uploading, playing and locking the clip |

`DesignPane.vue` keeps the tab shell, the preset lifecycle (load/reset on selection), save, and the
lock flow — what is genuinely about the pane as a whole.

**One composable, because it is genuinely shared.** `app/composables/useRigRender.ts` exposes
`renderWav(body, signal)`, `elapsedMs` and `queued`. Two consumers call it: the lock flow (staying
in the parent, `DesignPane.vue:109-129`) and seed audition (moving to a child, `:320-354`). The
elapsed clock exists so that a render queued behind the live agent reads as a queue rather than a
hang; that behaviour must not be duplicated into two components.

**Unchanged on purpose:** `voice.vue` continues to own the draft form state. Speak reads the same
live draft that Design edits, which is why it sits in the page. Children receive the draft; they do
not own it.

### 2. `SpeakPane` on `PromptInput`

`PromptInput` + `PromptInputBody` + `PromptInputTextarea` replace the `UFormField`-wrapped
`UTextarea`. `PromptInputFooter` / `PromptInputTools` carry the controls that already exist: the
Quality/Realtime mode toggle, the event-tag insert buttons, and the character count.
`PromptInputSubmit` becomes Speak, swapping to a Stop button while speaking — the pattern
`AgentPromptInput` already uses.

**Not adopted:** the attach button, the model select, and the action menu. On a text-to-speech box
they are dead affordances.

**Two behaviours that must be preserved deliberately, because the component's defaults break them:**

1. **Enter must insert a newline, not submit.** `PromptInput` sends on Enter with Shift+Enter for a
   newline. This box holds pasted multi-line scripts — it is a 10-row textarea today — so
   Enter-to-speak would break its primary use. Speak stays an explicit button press.
2. **Tag insertion is caret-relative.** `insertTag` reaches `UTextarea`'s inner element
   (`SpeakPane.vue:135-139`) to insert at the cursor. `PromptInputTextarea` is a different
   component; that ref must be re-pointed, or the tag buttons will silently append at the end
   instead of at the caret.

The "Read from MyMind" source select stays above the composer — it loads text *into* the box rather
than being part of it.

### 3. The two fixes

**Move the slideover.** `app/components/voice/SettingsSlideover.vue` →
`app/components/agent/SettingsSlideover.vue`. The Nuxt auto-import name changes with the directory
(`VoiceSettingsSlideover` → `AgentSettingsSlideover`), so `app/pages/agent/index.vue:338` updates in
the same commit.

**Honour the mic setting.** `DesignPane`'s recorder (moving to `DesignReferenceClip.vue`) requests
the saved `micDeviceId` with `deviceId: { exact: … }`, and on failure retries with the base
constraints and clears the stale setting — the same sequence as `useVoice.ts:331-346`. The
constraint-building and fallback decision are extracted as a pure helper so they can be tested
without a browser; the `getUserMedia` call itself stays in the component.

## Testing

**This cycle is mostly refactor, and a refactor of working code earns nothing if it breaks it.** The
success criterion for §1 is that nothing changes, so the proof is behavioural.

**Unit:**
- the mic constraint helper: device requested when set; fallback on an `OverconstrainedError`; the
  stale device cleared; no device set → base constraints, no fallback path.
- `useRigRender`: the clock starts and stops around a render, and `queued` flips after 4s.

**Browser (`playwright-cli`, per the project rule — never the MCP):**
- record a reference clip, upload it, play it back, lock a preset
- audition seeds and keep one
- speak text in both Quality and Realtime modes
- Enter inserts a newline in the Speak box and does **not** speak
- a tag button inserts at the caret, not at the end
- `/agent` still loads and its settings slideover still opens after the move
- light and dark

**A named risk:** the rig serves one request at a time, queued behind the live agent. If it is
unreachable, the audition, lock and speak flows cannot be proven — those items are then reported
**NOT VERIFIED**, never assumed to pass.

## Out of scope

- Home / `AskBrain.vue` — declined above.
- Unifying mic acquisition between `useVoice` and `DesignPane` — offered and declined; the two have
  different jobs (stream speech with a VAD versus record a clip), and this cycle fixes the defect
  rather than merging the paths.
- `voice.vue`'s draft-state ownership.
- Any change to the rig, the TTS pipeline, or preset persistence.

## Risks

1. **A refactor with no behaviour change is invisible when wrong.** The flows being restructured —
   recording, audition, locking — have no unit coverage today, so browser proof is the only net.
   Mitigated by proving each flow before and after where practical.
2. **`PromptInput`'s Enter-to-submit default.** If the override is missed, the regression is silent
   until someone pastes a script and presses Enter mid-edit. Explicitly tested.
3. **The caret ref.** Losing it degrades quietly — tags still insert, just in the wrong place.
   Explicitly tested.
4. **Auto-import rename.** Moving the slideover changes its global component name; a missed
   reference is a runtime blank, not a typecheck error. `pnpm build` plus a page load covers it.
