# Voice Studio Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 1,101-line `DesignPane.vue` into three focused children plus one shared composable, put `SpeakPane`'s text box in composer chrome without breaking Enter, and fix two real defects found while measuring.

**Architecture:** Each section of `DesignPane` becomes a child component owning its own UI *and* logic; the one genuinely shared seam (`renderWav` plus its elapsed clock, called by both the lock flow and seed audition) becomes `useRigRender()`. `SpeakPane` adopts the AI Elements footer chrome around a plain `InputGroupTextarea` rather than `PromptInputTextarea`, because that component hardcodes Enter-to-submit.

**Tech Stack:** Nuxt 4 (SPA, `ssr: false`), Vue 3 `<script setup>`, Nuxt UI v4, vendored AI Elements under `app/components/ai-elements/`, Vitest, `playwright-cli`.

**Spec:** [`docs/superpowers/specs/2026-09-20-voice-studio-refactor-design.md`](../specs/2026-09-20-voice-studio-refactor-design.md)

## Global Constraints

- **pnpm only** — never npm or yarn. `pnpm typecheck`, `pnpm test`, `pnpm build`.
- **No co-author trailer and no model names in any commit message.** Hard user rule; violated twice in cycle 66 and caught both times. Check the message *before* committing.
- **Validate UI work with `playwright-cli`, never the Playwright MCP.** Invoke the project's `browser-testing` skill for credentials and the snapshot→ref→click workflow.
- **Nuxt UI v4 components + semantic design tokens** (`text-muted`, `text-dimmed`, `bg-elevated`, `border-default`, `color="primary"`). Never raw Tailwind palette classes. Invoke `nuxt-ui-docs` before using a `U*` component.
- **This cycle is mostly refactor: success means nothing changes.** Never "improve" behaviour while moving code. If a section looks wrong, move it as-is and report it — a silent behaviour change inside a refactor is the hardest kind of bug to find later.
- **Comments move with their code.** `DesignPane.vue` carries long explanatory comments about *why* (the rig's single inference slot, the stale-token guard, the lock/save ordering). They are the most valuable thing in the file. Move them verbatim with the code they explain; never drop or summarise them.
- Dev server needs both vars or login fails with "Invalid origin": `PORT=3219 BETTER_AUTH_URL=http://localhost:3219 pnpm dev`. Account `test@example.com` / `testpassword123`. Kill it by a PID whose command line you have verified names this repo.
- Run every command in the **foreground**.
- Production builds at a 4096 MB heap: `NODE_OPTIONS=--max-old-space-size=4096 pnpm build`. Success is `.output/server/index.mjs` existing plus "Build complete!" — **not** an exit code.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `app/composables/useRigRender.ts` (new) | `renderWav` + the elapsed/queued clock. Two callers: the lock flow and seed audition. |
| `app/composables/useRigRender.test.ts` (new) | Clock start/stop and the `queued` threshold. |
| `app/lib/voice/mic.ts` (new) | Pure: build `getUserMedia` constraints for a saved device id, and decide the fallback. |
| `app/lib/voice/mic.test.ts` (new) | Its four cases. |
| `app/components/voice/DesignDescription.vue` (new) | Description field + starter descriptions. |
| `app/components/voice/DesignSeedAudition.vue` (new) | Seed audition + kept seeds. Consumes `useRigRender`. |
| `app/components/voice/DesignReferenceClip.vue` (new) | Record / upload / play / clear the reference clip. |
| `app/components/voice/DesignPane.vue` (shrinks) | Tab shell, preset lifecycle, save, lock/unlock. |
| `app/components/agent/SettingsSlideover.vue` (moved) | Was `components/voice/`; only consumer is `/agent`. |
| `app/components/voice/SpeakPane.vue` (modified) | Composer chrome around the speak box. |
| `docs/wiki/voice-studio.md`, `docs/handovers/2026-09-20-voice-studio-refactor.md` | Docs. |

---

### Task 1: `useRigRender` — the one genuinely shared seam

**Files:**
- Create: `app/composables/useRigRender.ts`
- Create: `app/composables/useRigRender.test.ts`
- Modify: `app/components/voice/DesignPane.vue` (remove lines 212-256's clock + `renderWav`, call the composable instead)

**Interfaces:**
- Produces:
  ```ts
  export function useRigRender(): {
    elapsedMs: Ref<number>
    queued: ComputedRef<boolean>          // elapsedMs > 4000
    startClock: () => void
    stopClock: () => void
    renderWav: (body: SpeakRequestBody, signal?: AbortSignal) => Promise<{ blob: Blob, note: string | null }>
  }
  ```
  Task 3 consumes it; `DesignPane` keeps using it for the lock flow.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useRigRender } from './useRigRender'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useRigRender clock', () => {
  it('counts up in 250ms steps while running', () => {
    const { elapsedMs, startClock } = useRigRender()
    startClock()
    vi.advanceTimersByTime(1000)
    expect(elapsedMs.value).toBe(1000)
  })

  it('reports queued only after 4s — the rig serves one request at a time', () => {
    const { queued, startClock } = useRigRender()
    startClock()
    vi.advanceTimersByTime(4000)
    expect(queued.value).toBe(false)
    vi.advanceTimersByTime(250)
    expect(queued.value).toBe(true)
  })

  it('stops counting after stopClock', () => {
    const { elapsedMs, startClock, stopClock } = useRigRender()
    startClock()
    vi.advanceTimersByTime(500)
    stopClock()
    vi.advanceTimersByTime(5000)
    expect(elapsedMs.value).toBe(500)
  })

  it('restarts from zero — a second render must not inherit the first one s clock', () => {
    const { elapsedMs, startClock, stopClock } = useRigRender()
    startClock()
    vi.advanceTimersByTime(1000)
    stopClock()
    startClock()
    expect(elapsedMs.value).toBe(0)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run app/composables/useRigRender.test.ts`
Expected: FAIL — "Failed to resolve import ./useRigRender".

- [ ] **Step 3: Create the composable**

Move `DesignPane.vue:212-256` into `app/composables/useRigRender.ts` **verbatim** — `elapsedMs`, `clock`, `startClock`, `stopClock`, `queued`, and `renderWav` with its full doc comment ("One complete WAV from /api/voice/speak…"), plus the inline comments inside `renderWav` about `format` belonging in the body and about aborting on preset switch. Wrap them in `export function useRigRender() { … return { elapsedMs, queued, startClock, stopClock, renderWav } }`. Keep the imports it needs (`SpeakRequestBody`, `errorFromResponseBody`, `readWavInfo`, `diagnoseTruncation`).

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run app/composables/useRigRender.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Use it from DesignPane**

In `DesignPane.vue`, replace the removed block with `const { elapsedMs, queued, startClock, stopClock, renderWav } = useRigRender()`. Nothing else in the file changes — the lock flow at `:109`/`:129` and the audition at `:320-354` keep calling the same names.

- [ ] **Step 6: Gates**

Run: `pnpm typecheck` (exit 0) and `pnpm test`.

- [ ] **Step 7: Commit**

```bash
git add app/composables/useRigRender.ts app/composables/useRigRender.test.ts app/components/voice/DesignPane.vue
git commit -m "refactor(voice): extract the rig render and its queue clock"
```

---

### Task 2: `DesignDescription.vue`

**Files:**
- Create: `app/components/voice/DesignDescription.vue`
- Modify: `app/components/voice/DesignPane.vue`

**Interfaces:**
- Produces: `<VoiceDesignDescription v-model:description="…" :disabled="boolean" />` — `description` is the draft's description string; `disabled` is true while the preset is locked or a render is in flight.

- [ ] **Step 1: Move the section**

Move the starter-descriptions logic (`DesignPane.vue:161-206`) and the description field's markup out of `DesignPane.vue` into the new component, comments verbatim. The child owns the starter list and the click-to-apply behaviour; it does **not** own saving.

- [ ] **Step 2: Wire it**

In `DesignPane.vue`, render `<VoiceDesignDescription v-model:description="draft.description" :disabled="locked || rendering" />` in the place the markup came from, using whatever the existing local names for locked/rendering are.

- [ ] **Step 3: Verify nothing else references the moved names**

```bash
grep -n "STARTER\|starter" app/components/voice/DesignPane.vue
```
Expected: no matches left in the parent.

- [ ] **Step 4: Gates**

Run: `pnpm typecheck` (exit 0) and `pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add app/components/voice/DesignDescription.vue app/components/voice/DesignPane.vue
git commit -m "refactor(voice): move the description field and its starters into their own pane"
```

---

### Task 3: `DesignSeedAudition.vue`

**Files:**
- Create: `app/components/voice/DesignSeedAudition.vue`
- Modify: `app/components/voice/DesignPane.vue`

**Interfaces:**
- Consumes: `useRigRender()` from Task 1.
- Produces: `<VoiceDesignSeedAudition :preset="VoicePresetDTO | null" :draft="PresetDraft" @kept="(seed: number) => void" />` — emits when the user keeps a seed so the parent can mark the draft dirty.

- [ ] **Step 1: Move the section**

Move the seed-audition block (`DesignPane.vue:258-369`) and the kept-seeds strip plus their markup into the child, comments verbatim — including the comment explaining that `renderWav` is the only network call the audition makes, which is what makes "an audition never writes" a property of the code.

- [ ] **Step 2: Call the composable from the child**

The child calls `useRigRender()` itself for `renderWav`, `elapsedMs` and `queued`. The parent keeps its own call for the lock flow. Two independent clocks are correct here: the two operations never run at once (both take the rig's single inference slot), and sharing one instance across components would couple their progress display for no benefit.

- [ ] **Step 3: Preserve the stale-token guard**

The audition aborts on preset switch. Keep the existing guard and abort wiring exactly as it is — do not simplify it. If the guard's helper lives in the parent, pass it in or move it with the audition, whichever keeps the behaviour identical, and say which you did in your report.

- [ ] **Step 4: Gates**

Run: `pnpm typecheck` (exit 0) and `pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add app/components/voice/DesignSeedAudition.vue app/components/voice/DesignPane.vue
git commit -m "refactor(voice): move seed audition into its own pane"
```

---

### Task 4: `DesignReferenceClip.vue`

**Files:**
- Create: `app/components/voice/DesignReferenceClip.vue`
- Modify: `app/components/voice/DesignPane.vue`

**Interfaces:**
- Produces: `<VoiceDesignReferenceClip :preset="VoicePresetDTO | null" :draft="PresetDraft" @changed="() => void" />` — emits after the reference tuple changes so the parent can resync.

- [ ] **Step 1: Move the section**

Move the reference-clip block (`DesignPane.vue:370-524`) — recording (`toggleRecording`, `finishRecording`, the `MediaRecorder` wiring, the webm→WAV conversion), upload, playback, and clearing — plus its markup, comments verbatim. The comment explaining why `recordingToken` is captured at *start* rather than at stop is load-bearing; keep it exactly.

- [ ] **Step 2: Leave lock/unlock in the parent**

Locking is a write to the row and is entangled with save ordering (`DesignPane.vue:100-131`). It stays in `DesignPane.vue`. The child only manages the clip itself.

- [ ] **Step 3: Verify the parent no longer recorders**

```bash
grep -n "MediaRecorder\|getUserMedia\|recordedChunks" app/components/voice/DesignPane.vue
```
Expected: no matches.

- [ ] **Step 4: Gates**

Run: `pnpm typecheck` (exit 0) and `pnpm test`. Record `wc -l app/components/voice/DesignPane.vue` for the report — it started at 1,101.

- [ ] **Step 5: Commit**

```bash
git add app/components/voice/DesignReferenceClip.vue app/components/voice/DesignPane.vue
git commit -m "refactor(voice): move the reference clip into its own pane"
```

---

### Task 5: The studio honours the chosen microphone

**Files:**
- Create: `app/lib/voice/mic.ts`
- Create: `app/lib/voice/mic.test.ts`
- Modify: `app/components/voice/DesignReferenceClip.vue`

**Interfaces:**
- Produces:
  ```ts
  export const BASE_AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: false }
  export function micConstraints(deviceId: string): MediaTrackConstraints
  export function isStaleDeviceError(err: unknown): boolean
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { BASE_AUDIO, micConstraints, isStaleDeviceError } from './mic'

describe('micConstraints', () => {
  it('asks for the exact device when one is chosen, so a stale pick fails loudly', () => {
    expect(micConstraints('abc123')).toEqual({ ...BASE_AUDIO, deviceId: { exact: 'abc123' } })
  })

  it('omits deviceId entirely when none is chosen — "" means let the OS decide', () => {
    expect(micConstraints('')).toEqual({ ...BASE_AUDIO })
    expect('deviceId' in micConstraints('')).toBe(false)
  })
})

describe('isStaleDeviceError', () => {
  it('recognises the unplugged-device error', () => {
    expect(isStaleDeviceError({ name: 'OverconstrainedError' })).toBe(true)
  })

  it('does not swallow a permission denial — that must surface, not silently fall back', () => {
    expect(isStaleDeviceError({ name: 'NotAllowedError' })).toBe(false)
    expect(isStaleDeviceError(new Error('boom'))).toBe(false)
    expect(isStaleDeviceError(null)).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run app/lib/voice/mic.test.ts`
Expected: FAIL — "Failed to resolve import ./mic".

- [ ] **Step 3: Implement**

```ts
/** Mirrors the live agent's mic acquisition (app/composables/useVoice.ts:330-346) so the
 *  studio records through the microphone the user actually chose. Before this, the
 *  reference-clip recorder called getUserMedia({ audio: true }) and the setting did nothing. */
export const BASE_AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: false }

/** '' means "let the OS choose". An explicit id is `exact` so a stale selection fails
 *  loudly rather than silently recording from the wrong microphone. */
export function micConstraints(deviceId: string): MediaTrackConstraints {
  return deviceId ? { ...BASE_AUDIO, deviceId: { exact: deviceId } } : { ...BASE_AUDIO }
}

/** A device unplugged since it was chosen throws OverconstrainedError. Anything else —
 *  a permission denial above all — must reach the user rather than being retried away. */
export function isStaleDeviceError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'OverconstrainedError'
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run app/lib/voice/mic.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Use it in the recorder**

In `DesignReferenceClip.vue`, replace `navigator.mediaDevices.getUserMedia({ audio: true })` with the saved-device request plus fallback, using `useVoiceSettings()`'s `micDeviceId`:

```ts
const settings = useVoiceSettings().settings
micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(settings.value.micDeviceId) })
  .catch(async (err: unknown) => {
    if (!isStaleDeviceError(err)) throw err
    // Clear the dead selection so the next recording — and the live agent — stop retrying it.
    settings.value = { ...settings.value, micDeviceId: '' }
    refError.value = 'That microphone is no longer available — switched to the system default.'
    return navigator.mediaDevices.getUserMedia({ audio: { ...BASE_AUDIO } })
  })
```

Check `app/composables/useVoiceSettings.ts` for the exact shape of the returned settings ref before writing this, and match it.

- [ ] **Step 6: Gates**

Run: `pnpm typecheck` (exit 0) and `pnpm test`.

- [ ] **Step 7: Commit**

```bash
git add app/lib/voice/mic.ts app/lib/voice/mic.test.ts app/components/voice/DesignReferenceClip.vue
git commit -m "fix(voice): record reference clips through the chosen microphone"
```

---

### Task 6: Move the misfiled settings slideover

**Files:**
- Move: `app/components/voice/SettingsSlideover.vue` → `app/components/agent/SettingsSlideover.vue`
- Modify: `app/pages/agent/index.vue:338`

- [ ] **Step 1: Move it with git so history follows**

```bash
git mv app/components/voice/SettingsSlideover.vue app/components/agent/SettingsSlideover.vue
```

- [ ] **Step 2: Update the only consumer**

Nuxt derives the auto-import name from the directory, so `<VoiceSettingsSlideover>` becomes `<AgentSettingsSlideover>`. Update `app/pages/agent/index.vue:338` (and its closing tag).

- [ ] **Step 3: Prove nothing else refers to the old name**

```bash
grep -rn "VoiceSettingsSlideover" app server docs
```
Expected: no matches.

- [ ] **Step 4: Gates**

Run `pnpm typecheck` and `pnpm test`. **A missing auto-import is a runtime blank, not a type error**, so also run `NODE_OPTIONS=--max-old-space-size=4096 pnpm build` and confirm "Build complete!" plus `.output/server/index.mjs`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(agent): move the settings slideover to the surface that uses it"
```

---

### Task 7: The speak box in composer chrome

**Files:**
- Modify: `app/components/voice/SpeakPane.vue`

**Deviation from the spec, decided here.** The spec said `PromptInput` + `PromptInputBody` + `PromptInputTextarea`. Reading the code: `PromptInputTextarea` **hardcodes** Enter-to-submit (`app/components/ai-elements/prompt-input/PromptInputTextarea.vue:20-33` — `e.preventDefault()` then `form.requestSubmit()`) with no prop to disable it, and `PromptInput` itself is a `<form>` that installs the prompt-input provider. Using either would mean a ninth MyMind patch to the vendored tree — and cycle 65's review established those patches are lost silently on a component re-copy.

`PromptInputFooter` and `PromptInputTools` need **no** context (verified: neither imports `usePromptInput`), and `PromptInputFooter` is an `InputGroupAddon align="block-end"`. So the chrome is reachable without the form or the textarea: wrap an `InputGroupTextarea` in an `InputGroup`, and use the two footer components for the control row. Same look, no vendor patch, Enter fully under our control.

- [ ] **Step 1: Replace the box with the group**

Replace the `UFormField label="Text"` + `UTextarea` block (`SpeakPane.vue:265-272`) with:

```vue
<InputGroup>
  <InputGroupTextarea
    ref="speakBox"
    v-model="text"
    :rows="10"
    placeholder="Type or paste what the voice should read."
  />
  <PromptInputFooter>
    <PromptInputTools>
      <!-- mode toggle, then the event-tag buttons -->
    </PromptInputTools>
    <!-- char count, then Speak / Stop -->
  </PromptInputFooter>
</InputGroup>
```

Import `InputGroup` and `InputGroupTextarea` from `@/components/ui/input-group`, and `PromptInputFooter`/`PromptInputTools` from `@/components/ai-elements/prompt-input`. Move the existing mode `UFieldGroup`, the `EVENT_TAGS` buttons, the char count and the Speak/Stop buttons into the footer, keeping their handlers unchanged. The "Read from MyMind" select and the render-plan alert stay where they are, outside the group.

- [ ] **Step 2: Re-point the caret ref**

`insertTag` currently reaches `UTextarea`'s inner element via `speakBox.textareaRef` (`SpeakPane.vue:135-139`). `InputGroupTextarea` is a different component. Inspect `app/components/ui/input-group/InputGroupTextarea.vue` to see what it exposes, and point the ref at the real `<textarea>` element. If it exposes nothing usable, bind a plain `ref` to the underlying element instead. **Do not** let `insertTag` fall back to appending at the end — that is the silent failure this step exists to prevent.

- [ ] **Step 3: Confirm Enter still inserts a newline**

There is no form and no submit button in the group, so Enter has no submit path — but prove it rather than assuming. With the dev server running, focus the box, type two lines with Enter between them, and confirm the text contains `\n` and that no render was triggered.

- [ ] **Step 4: Browser-verify the pane**

Start dev (`PORT=3219 BETTER_AUTH_URL=http://localhost:3219 pnpm dev`), open `/voice`, and check, screenshotting each: the box renders with the footer chrome; a tag button inserts **at the caret** (place the cursor mid-text, click a tag, read back `selectionStart` and the string); the char count updates; Speak and Stop enable/disable as before; light and dark. Kill the dev server by verified PID.

- [ ] **Step 5: Gates**

Run: `pnpm typecheck` (exit 0) and `pnpm test`.

- [ ] **Step 6: Commit**

```bash
git add app/components/voice/SpeakPane.vue
git commit -m "feat(voice): put the speak box in composer chrome"
```

---

### Task 8: Live validation, wiki, handover

**Files:**
- Create: `docs/wiki/voice-studio.md` if absent, else modify
- Create: `docs/handovers/2026-09-20-voice-studio-refactor.md`
- Modify: `docs/superpowers/plans/00-roadmap.md`, `docs/BACKLOG.md`

- [ ] **Step 1: Live validation on `/voice`**

Dev server as above, light and dark, 1440 and 375 px. Each item: drive it, screenshot, Read the screenshot, record PASS / FAIL / **NOT VERIFIED**:
1. Select a preset; the description field and its starters work.
2. Record a reference clip, play it back, clear it.
3. The recording uses the microphone chosen in settings (set a non-default device first; if the machine has only one input, record that fact as NOT VERIFIED rather than claiming a pass).
4. Audition seeds; keep one.
5. Lock a preset, then unlock it.
6. Speak text in Quality mode; then in Realtime mode.
7. Enter inserts a newline in the speak box and does not speak.
8. A tag button inserts at the caret.
9. `/agent` loads and its settings slideover opens (the Task 6 move).

**The rig serves one request at a time, queued behind the live agent.** If it is unreachable, items 4, 5 and 6 are **NOT VERIFIED** — never assumed. Say so plainly.

- [ ] **Step 2: Wiki**

`docs/wiki/voice-studio.md`: the component layout after the split (which pane owns what), `useRigRender` and why the clock exists, the mic fix, and the speak box's chrome. If the page does not exist, create it with frontmatter matching `docs/wiki/sessions.md`'s shape (`title`, `status`, `cycle`, `updated`) — the controller mirrors it to MyMind afterwards, so leave `mymind_id`/`mymind_hash` out.

- [ ] **Step 3: Handover**

`docs/handovers/2026-09-20-voice-studio-refactor.md`, matching the frontmatter shape and depth of `docs/handovers/2026-09-20-sessions-elements.md`. Record: status (built / merged / deployed, honestly); that this cycle is deliberately smaller because measuring found Home and "shared pieces" empty; `DesignPane.vue`'s line count before and after; the mic fix as the only user-visible change; every ruling from the SDD ledger with its cost-if-wrong; the deviation in Task 7 and why; and each validation item with PASS / FAIL / NOT VERIFIED.

- [ ] **Step 4: Roadmap and backlog**

Add the cycle-67 row to `docs/superpowers/plans/00-roadmap.md` in the existing row format. In `docs/BACKLOG.md`, update the cycle-67 line (currently at `:201`) from deferred to built, note that Home was descoped, and refresh the "Last reconciled" preamble.

- [ ] **Step 5: Gates**

`pnpm typecheck`, `pnpm test`, and `NODE_OPTIONS=--max-old-space-size=4096 pnpm build`. Record the client JS file count and gzip total; cycle 66 finished at 266 files / 2,108,163 B.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: cycle 67 handover, wiki, roadmap and backlog"
```

---

## Self-Review

**Spec coverage.** Split into three children + one composable → Tasks 1-4. `useRigRender` as the shared seam → Task 1. `voice.vue` keeps draft ownership → untouched by every task (stated in Tasks 2-4 interfaces). SpeakPane chrome without attachments/model/action-menu → Task 7. Enter-as-newline → Task 7 Steps 1 and 3. Caret-relative tag insertion → Task 7 Step 2. Slideover move including the auto-import rename → Task 6. Mic fix with the exact-then-fallback sequence and stale-device clearing → Task 5. Unit tests for the mic helper and `useRigRender` → Tasks 5 and 1. Browser proof of record/audition/lock/speak/Enter/caret/agent → Task 8. The rig-unreachable risk → Task 8 Step 1.

**Deliberate spec deviation:** the spec named `PromptInput` + `PromptInputTextarea`; Task 7 uses `InputGroup` + `InputGroupTextarea` + the two footer components instead, because `PromptInputTextarea` hardcodes Enter-to-submit and adopting it would require a ninth vendored patch. The spec's *requirements* (chrome yes, attachments no, Enter as newline) are all met; only the component choice differs, and Task 7 states the reasoning inline.

**Placeholder scan:** no "TBD"/"TODO"/"handle edge cases". Tasks 2-4 specify line ranges to move plus the exact child interface rather than reproducing hundreds of lines verbatim — a precise instruction, since the requirement is that the code move unchanged.

**Type consistency.** `useRigRender()`'s five returned names are defined in Task 1 and consumed in Tasks 1 and 3 under the same names. `micConstraints`/`isStaleDeviceError`/`BASE_AUDIO` are defined in Task 5 Step 3 and used in Step 5. Component tags follow Nuxt's directory-derived auto-import naming (`VoiceDesignDescription`, `VoiceDesignSeedAudition`, `VoiceDesignReferenceClip`, `AgentSettingsSlideover`).
