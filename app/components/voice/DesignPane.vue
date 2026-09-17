<!-- app/components/voice/DesignPane.vue -->
<script setup lang="ts">
import type { SavedPresetDTO, VoicePresetDTO } from '~~/shared/types/voice-presets'
import {
  CFG_LOCK_REASON,
  CFG_MAX,
  CFG_MIN,
  auditionRequests,
  blankDraft,
  draftIsDirty,
  attachedReference,
  noReference,
  referenceFieldsOf,
  draftToBody,
  draftToOverrides,
  errorMessage,
  isCfgLocked,
  presetToDraft,
  randomSeed,
  instructionHint,
  lockState,
  lockHint,
  toggleStarredSeed,
  runAuditionSequentially,
  validatePresetDraft,
  diagnoseTruncation,
  errorFromResponseBody,
  type PresetDraft,
  type SpeakRequestBody
} from '~/lib/voice/studio'
import { createGenerationGuard, isAbortError } from '~/lib/voice/generation'
import { encodeWav, mixToMono, readWavInfo } from '~/lib/voice/wav-encode'

// The draft is owned by the page, not by this pane: SpeakPane (a different panel) renders
// what is in this form, so the form cannot be private to the component that edits it. This
// pane still owns EDITING it — nothing else writes these fields.
const props = defineProps<{ preset: VoicePresetDTO | null, draft: PresetDraft }>()
const emit = defineEmits<{ saved: [VoicePresetDTO] }>()

// Same object the page holds; only ever mutated field-by-field, never reassigned.
const draft = props.draft
const saving = ref(false)
const saveError = ref<string | null>(null)
// Calibration runs on the server AFTER the row is written, and it can fail on its own
// (the rig serves one request at a time and can be down entirely) without failing the
// save. That is not an error — the voice saved — but it must not be silent either: the
// preset is live on the agent with an unmeasured ceiling until it is saved again.
const saveWarning = ref<string | null>(null)

// This pane is ONE form bound to whichever preset is selected, so every slow operation it
// starts — an upload, a recording's decode, a four-take audition — was started for one
// preset and can resolve after the user has picked another. The guard is what stops a
// result landing on the wrong draft: work captures a token at the start and checks it
// before applying anything, and cancellable work carries the signal so it stops outright.
// Without it, a reference clip uploaded under preset A is written into preset B's draft
// and the next Save persists it — silent corruption, not a cosmetic glitch.
const guard = createGenerationGuard()

// Two panels, always both present. The Reference tab carries a badge once a clip is
// attached so the pane says at a glance which of the four modes this preset is in without
// the user having to open it.
const tab = ref('voice')
const tabItems = computed(() => [
  { label: 'Voice', icon: 'i-lucide-mic-vocal', value: 'voice', slot: 'voice' },
  {
    label: 'Reference',
    icon: 'i-lucide-audio-lines',
    value: 'reference',
    slot: 'reference',
    badge: draft.refStorageKey ? '1' : undefined,
  },
])

const errors = computed(() => validatePresetDraft(draft))
const dirty = computed(() => draftIsDirty(draft, props.preset))
const cfgLocked = computed(() => isCfgLocked(draft.instruction))
// Seeds are a lottery with no ordering — measured, sweeping 3 to 999,999 showed no trend at
// all. What tightens a voice across seeds is a specific description held at cfg 4.
const hint = computed(() => instructionHint(draft.instruction, draft.cfgScale))

// ── Locking ───────────────────────────────────────────────────────────────────
// A design preset stores a recipe, not a person: the agent sends different text every
// segment, so the description is re-cast each time and a long reply can sound like several
// people. Locking renders one canonical passage and keeps the audio; from then on every
// utterance clones that render.
const locking = ref(false)
const lockError = ref<string | null>(null)
// Read entirely from the DRAFT. Mixing the two — the source off the saved row, the clip off
// the form — meant an unsaved upload read as "unlockable" while its clip was already sitting
// in the form, and offered to lock over it.
const lock = computed(() => lockState({
  refSource: draft.refSource,
  refStorageKey: draft.refStorageKey,
  instruction: draft.instruction,
}))

async function lockVoice() {
  const p = props.preset
  if (!p || locking.value || lock.value !== 'unlockable') return
  locking.value = true
  lockError.value = null
  startClock()
  const { token } = guard.begin()
  try {
    // Sends the LIVE form, so what gets frozen is the voice just auditioned — not whatever
    // was last saved.
    const saved = await $fetch<SavedPresetDTO>(`/api/voice/presets/${p.id}/lock`, {
      method: 'POST',
      body: { overrides: draftToOverrides(draft) },
    })
    if (guard.isStale(token)) return
    // Lock writes the clip SERVER-side, and the draft-resync watcher only fires on an id
    // change — so without this the form keeps its pre-lock reference fields and the next
    // Save writes them back over the row. Only the reference tuple is resynced: the voice
    // fields were just committed from this draft, and wiping in-progress edits would be a
    // surprise.
    Object.assign(draft, referenceFieldsOf(saved))
    emit('saved', saved)
  } catch (e) {
    if (!guard.isStale(token)) lockError.value = errorMessage(e)
  } finally {
    stopClock()
    if (!guard.isStale(token)) locking.value = false
  }
}

async function unlockVoice() {
  const p = props.preset
  if (!p || locking.value) return
  locking.value = true
  lockError.value = null
  try {
    const saved = await $fetch<SavedPresetDTO>(`/api/voice/presets/${p.id}/unlock`, { method: 'POST' })
    // Same reason as lockVoice: unlock clears the clip on the row, and a stale draft would
    // resurrect it on the next Save — with no source, which is exactly how a preset ended
    // up deriving as 'direction' after being unlocked.
    Object.assign(draft, referenceFieldsOf(saved))
    emit('saved', saved)
  } catch (e) {
    lockError.value = errorMessage(e)
  } finally {
    locking.value = false
  }
}

// A blank instruction means cfg MUST sit at 1: it is a DB CHECK
// (voice_presets_cfg_needs_instruction) and an opaque 500 at the rig. Clamping here as
// well as disabling the slider covers the path where the instruction is CLEARED after
// the slider was already raised.
watch(() => draft.instruction, (v) => {
  if (isCfgLocked(v) && draft.cfgScale > 1) draft.cfgScale = 1
})

// ── Starter descriptions ──────────────────────────────────────────────────────
// The eight voices the rig shipped with (migration 0039). Selecting one fills the
// instruction box; it is a starting point to edit, not a locked choice.
const STARTERS = [
  { value: 'neutral-lowkey', label: 'Neutral, low-key man', description: 'A neutral, low-key man. Understated and unobtrusive, no performance, just clear.' },
  { value: 'warm-woman', label: 'Warm, thoughtful woman', description: 'A warm, thoughtful young woman with a clear voice and a calm, reflective delivery.' },
  { value: 'bright-man', label: 'Bright, energetic man', description: 'A bright, energetic young man. Quick, friendly, upbeat conversational pace.' },
  { value: 'deep-narrator', label: 'Deep narrator', description: 'A deep, calm older man with measured authority. Documentary narrator gravitas.' },
  { value: 'crisp-anchor', label: 'Crisp anchor', description: 'A crisp, precise professional woman. Newsreader clarity, neutral and articulate.' },
  { value: 'dry-laidback', label: 'Dry, laid-back man', description: 'A laid-back American man with a dry, understated delivery and subtle humour.' },
  { value: 'latenight-radio', label: 'Late-night radio', description: 'A gravelly, warm middle-aged man. Intimate late-night radio host, relaxed and smooth.' },
  { value: 'light-assistant', label: 'Light assistant', description: 'A light, upbeat woman with an approachable helpful tone. Friendly assistant energy.' }
]

// Left undefined, never '': reka-ui's USelectMenu throws on an empty-string item value,
// and an unset model is the correct "nothing chosen" state.
const starterKey = ref<string | undefined>(undefined)
watch(starterKey, (key) => {
  const starter = STARTERS.find(s => s.value === key)
  if (starter) draft.instruction = starter.description
})

async function save() {
  const p = props.preset
  if (!p || errors.value.length) return
  saving.value = true
  saveError.value = null
  saveWarning.value = null
  try {
    const saved = await $fetch<SavedPresetDTO>(`/api/voice/presets/${p.id}`, {
      method: 'PATCH',
      body: draftToBody(draft)
    })
    saveWarning.value = saved.calibrationWarning
    emit('saved', saved)
  } catch (e) {
    saveError.value = errorMessage(e)
  } finally {
    saving.value = false
  }
}

// ── Rendering against the rig ─────────────────────────────────────────────────
//
// The rig serves ONE request at a time and studio work is queued BEHIND the live agent,
// so a render can legitimately sit waiting. The elapsed clock exists so that wait reads
// as a queue rather than as a hang.
const elapsedMs = ref(0)
let clock: ReturnType<typeof setInterval> | null = null

function startClock() {
  elapsedMs.value = 0
  clock = setInterval(() => {
    elapsedMs.value += 250
  }, 250)
}

function stopClock() {
  if (clock) clearInterval(clock)
  clock = null
}

const queued = computed(() => elapsedMs.value > 4000)

/** One complete WAV from /api/voice/speak, plus whatever its size says about it.
 *  Takes the whole request body, `overrides` included — this is the ONLY network call the
 *  audition makes, which is what makes "an audition never writes" a property of the code
 *  rather than a promise. */
async function renderWav(body: SpeakRequestBody, signal?: AbortSignal): Promise<{ blob: Blob, note: string | null }> {
  const res = await fetch('/api/voice/speak', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // `format` belongs in the BODY — it is not a query parameter on this route.
    body: JSON.stringify(body),
    // Switching preset aborts the render outright: the rig has ONE inference slot, and an
    // abandoned audition holding it is the newly selected preset waiting on nothing.
    signal
  })
  // Parsed, not raw: `fetch` returns the whole h3 JSON error envelope, and the
  // pre-flight's 400 sentence is one field inside it.
  if (!res.ok) throw new Error(errorFromResponseBody(await res.text().catch(() => ''), res.statusText))
  const blob = await res.blob()
  const info = readWavInfo(new Uint8Array(await blob.arrayBuffer()))
  return {
    blob,
    note: diagnoseTruncation({
      chars: body.text.length,
      audioBytes: info?.dataBytes ?? 0,
      sampleRate: info?.sampleRate ?? 24000
    })
  }
}

// ── Seed audition ─────────────────────────────────────────────────────────────

const AUDITION_TEXT = 'Here is how this voice sounds — the same sentence, drawn four different ways.'

interface SeedTake {
  seed: number
  status: 'pending' | 'rendering' | 'ready' | 'failed'
  url: string | null
  note: string | null
}

// Keeping a seed is the memory that casting has always lacked: the same description at a
// different seed is a different person, so without this a good take is lost to the next roll.
function isStarred(seed: number): boolean {
  return draft.starredSeeds.includes(seed)
}

function toggleStar(seed: number) {
  draft.starredSeeds = toggleStarredSeed(draft.starredSeeds, seed)
}

/** Load a kept seed back into the form so it can be heard, tweaked, or saved as the voice. */
function useStarredSeed(seed: number) {
  draft.seed = seed
}

const takes = ref<SeedTake[]>([])
const auditioning = ref(false)
const auditionError = ref<string | null>(null)

function clearTakes() {
  for (const t of takes.value) {
    if (t.url) URL.revokeObjectURL(t.url)
  }
  takes.value = []
  auditionError.value = null
}

/** The audition needs a preset row only for its ID and its reference clip — every
 *  tunable parameter rides along as an override, so UNSAVED edits are previewed as they
 *  stand. There is deliberately no "save first" gate any more. */
const auditionBlockedReason = computed(() => props.preset ? null : 'Select a voice first.')

async function runAudition() {
  const p = props.preset
  if (!p || auditioning.value || auditionBlockedReason.value) return
  clearTakes()
  // Built up front so the four seeds are visible before the first render returns, and so
  // the requests and the rows cannot drift apart.
  const requests = auditionRequests(draft, p.id, AUDITION_TEXT)
  takes.value = requests.map(r => ({
    seed: r.overrides?.seed ?? draft.seed,
    status: 'pending',
    url: null,
    note: null
  }))
  auditioning.value = true
  auditionError.value = null
  // Captured once, for the whole run: every hook below checks it before touching state
  // that may since have come to belong to a different preset.
  const { token, signal } = guard.begin()
  try {
    // Sequential, and nothing but `renderWav` reaches the network: no PATCH before a
    // take, no restore after the run. The rig serves one request at a time (four at once
    // would 409 three of them), and an audition is a preview, never a write.
    await runAuditionSequentially(requests, body => renderWav(body, signal), {
      onStart: (i) => {
        if (guard.isStale(token)) return
        const take = takes.value[i]
        if (take) take.status = 'rendering'
        startClock()
      },
      onDone: (i, result) => {
        if (guard.isStale(token)) return
        stopClock()
        const take = takes.value[i]
        if (!take) return
        take.url = URL.createObjectURL(result.blob)
        take.note = result.note
        take.status = 'ready'
      },
      onError: (i, err) => {
        // An abandoned take is not a failure to report — and its row belongs to a preset
        // that is no longer on screen anyway.
        if (guard.isStale(token) || isAbortError(err)) return
        stopClock()
        const take = takes.value[i]
        if (!take) return
        take.status = 'failed'
        take.note = errorMessage(err)
      }
    })
  } finally {
    // Guarded: a run abandoned by a preset switch must not clear the spinner that now
    // belongs to the newly selected preset's own audition.
    if (!guard.isStale(token)) {
      stopClock()
      auditioning.value = false
    }
  }
}

function playTake(take: SeedTake) {
  if (!take.url) return
  void new Audio(take.url).play()
}

async function useSeed(seed: number) {
  draft.seed = seed
  await save()
}

// ── Reference clip ────────────────────────────────────────────────────────────

const refFile = ref<File | null>(null)
const refBusy = ref(false)
const refError = ref<string | null>(null)
const refWarning = ref<string | null>(null)
const recording = ref(false)

watch(refFile, (file) => {
  if (file) void uploadReference(file, file.name)
})

async function uploadReference(file: Blob, filename: string) {
  // The clip is on the wire for as long as Whisper takes to transcribe it, which is ample
  // time to pick a different preset. Everything below the await is therefore guarded: a
  // result that arrives late belongs to a draft that no longer exists, and writing it
  // would put preset A's clip and transcript on preset B — where the next Save persists it.
  const { token, signal } = guard.begin()
  refBusy.value = true
  refError.value = null
  refWarning.value = null
  try {
    const form = new FormData()
    form.append('audio', file, filename)
    const res = await $fetch<{ storageKey: string, refText: string, durationMs: number, warning: string | null }>(
      '/api/voice/reference',
      { method: 'POST', body: form, signal }
    )
    if (guard.isStale(token)) return
    // The whole tuple at once, so the clip can never arrive without its provenance.
    Object.assign(draft, attachedReference(res))
    // Non-null past 20s. The clip shares the prompt budget with the text, so this is the
    // warning that explains a later render stopping early.
    refWarning.value = res.warning
  } catch (e) {
    if (guard.isStale(token) || isAbortError(e)) return
    // The server's own sentence carries the 60s limit and the measured length — show it
    // rather than a generic failure.
    refError.value = errorMessage(e)
  } finally {
    // Only the CURRENT generation owns this spinner.
    if (!guard.isStale(token)) refBusy.value = false
  }
}

function clearReference() {
  Object.assign(draft, noReference())
  refFile.value = null
  refWarning.value = null
  refError.value = null
}

let recorder: MediaRecorder | null = null
let micStream: MediaStream | null = null
let recordedChunks: Blob[] = []
/** The generation the recording was STARTED in. Captured at start rather than at stop
 *  because the preset switch is what stops it: by the time `onstop` fires the guard has
 *  already been reset, so a token taken in finishRecording would read as current and the
 *  clip would upload against the preset the user just moved to. */
let recordingToken: number | null = null

async function toggleRecording() {
  if (recording.value) {
    recorder?.stop()
    return
  }
  refError.value = null
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (e) {
    refError.value = `Microphone unavailable: ${errorMessage(e)}`
    return
  }
  recordedChunks = []
  recorder = new MediaRecorder(micStream)
  recorder.ondataavailable = (e) => {
    if (e.data.size) recordedChunks.push(e.data)
  }
  recorder.onstop = () => {
    void finishRecording()
  }
  recordingToken = guard.begin().token
  recorder.start()
  recording.value = true
}

async function finishRecording() {
  // The token the recording STARTED in (see recordingToken). A recording stopped BY a
  // preset switch lands here with the guard already reset, and must be discarded rather
  // than uploaded against whichever preset is now selected.
  const token = recordingToken
  recordingToken = null
  recording.value = false
  micStream?.getTracks().forEach(t => t.stop())
  micStream = null
  const recorded = new Blob(recordedChunks, { type: recorder?.mimeType || 'audio/webm' })
  recordedChunks = []
  if (token === null || guard.isStale(token)) return
  if (!recorded.size) {
    refError.value = 'Nothing was recorded.'
    return
  }
  // MediaRecorder produces webm/opus; /api/voice/reference requires RIFF/WAVE and 400s
  // on anything else. Decode and re-encode rather than sending what the browser gave us.
  const ctx = new AudioContext()
  try {
    const decoded = await ctx.decodeAudioData(await recorded.arrayBuffer())
    if (guard.isStale(token)) return
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i))
    const wav = encodeWav(mixToMono(channels), decoded.sampleRate)
    // uploadReference captures its own token; by here we know this generation is current.
    await uploadReference(new Blob([wav], { type: 'audio/wav' }), 'recording.wav')
  } catch (e) {
    if (guard.isStale(token)) return
    refError.value = `Could not convert the recording to WAV: ${errorMessage(e)}`
  } finally {
    void ctx.close()
  }
}

// ── Load / reset on selection ─────────────────────────────────────────────────
// Declared HERE, not next to the draft: `immediate: true` runs the callback during setup,
// and every ref it clears (refError, refWarning, takes) is a `const` defined below — so
// hoisting this to the top of the script throws a TDZ ReferenceError on mount, which no
// gate would catch.
//
// Keyed on the preset's ID, deliberately NOT on the object. `voicePreset` is a live
// resource: every write publishes a change, the SSE dispatch invalidates
// ['voicePreset','list'], and the refetch hands down a NEW object for the SAME row. A
// watcher on the object would therefore fire whenever anything touches this preset —
// this pane's own Save, another tab, a background writer — wiping an in-progress edit and
// the audition takes. A different ID is the only thing that actually means "a different
// voice is selected".
watch(() => props.preset?.id ?? null, () => {
  const p = props.preset
  // FIRST: invalidate everything in flight. An upload, a recording's decode and an
  // audition can all be mid-await right now, each holding a token issued for the preset
  // being navigated away from; this makes their results unapplicable and aborts the ones
  // that can be aborted (the audition's render, which is holding the rig's only slot).
  guard.reset()
  // A recording in progress is stopped rather than left running against a preset that is
  // no longer on screen — its onstop lands in finishRecording, which discards it.
  if (recording.value) {
    recorder?.stop()
    recording.value = false
  }
  Object.assign(draft, p ? presetToDraft(p) : blankDraft())
  starterKey.value = undefined
  saveError.value = null
  saveWarning.value = null
  refError.value = null
  refWarning.value = null
  // Cleared with everything else: the upload widget kept showing the PREVIOUS preset's
  // filename, which reads as "this preset has that clip" when it does not.
  refFile.value = null
  refBusy.value = false
  auditioning.value = false
  stopClock()
  clearTakes()
}, { immediate: true })

const refSeconds = computed(() => draft.refDurationMs ? (draft.refDurationMs / 1000).toFixed(1) : null)

onBeforeUnmount(() => {
  stopClock()
  clearTakes()
  micStream?.getTracks().forEach(t => t.stop())
})
</script>

<template>
  <div
    v-if="!props.preset"
    class="flex-1 flex items-center justify-center p-8"
  >
    <p class="text-sm text-muted text-center">
      Select a voice on the left, or create one, to start designing.
    </p>
  </div>

  <div
    v-else
    class="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-6"
  >
    <UTabs
      v-model="tab"
      :items="tabItems"
      variant="link"
      class="w-full"
    >
      <!-- Both tabs always exist. A pane that appears only once a preset already has a
           reference has nowhere to put the control that ADDS the first one, and a layout
           that changes shape underneath the user is worse than one empty panel. -->
      <template #voice>
        <div class="flex flex-col gap-6 pt-4">
        <UFormField
          label="Name"
          required
        >
          <UInput
            v-model="draft.name"
            placeholder="warm-narrator"
            class="w-full"
          />
        </UFormField>

        <UFormField
          label="Start from"
          help="Fills the instruction below with one of the eight voices the rig shipped with. Edit it freely afterwards."
        >
          <USelectMenu
            v-model="starterKey"
            :items="STARTERS"
            value-key="value"
            placeholder="Pick a starting description…"
            icon="i-lucide-sparkles"
            class="w-full"
          />
        </UFormField>

        <UFormField
          label="Instruction"
          help="How the voice should sound. Leave it empty for a plain or cloned voice."
        >
          <!-- The specificity nudge is an ICON, not a banner: it is guidance, and a block of
               warning-coloured text every time a description is short reads as an error the
               user has to clear. Hover mode because it is optional reading. -->
          <template #hint>
            <UPopover
              v-if="hint"
              mode="hover"
              enable-touch
            >
              <UIcon
                name="i-lucide-lightbulb"
                class="size-4 text-muted hover:text-primary cursor-help"
                aria-label="Tip about writing this description"
              />
              <template #content>
                <p class="max-w-xs p-3 text-xs text-muted">{{ hint }}</p>
              </template>
            </UPopover>
          </template>

          <UTextarea
            v-model="draft.instruction"
            :rows="3"
            autoresize
            placeholder="A warm, thoughtful young woman with a calm, reflective delivery."
            class="w-full"
          />
        </UFormField>

        <UFormField
          label="Guidance (cfg)"
          :help="cfgLocked ? CFG_LOCK_REASON : `${draft.cfgScale.toFixed(1)} — how hard the model is pushed toward the instruction.`"
        >
          <!-- The bounds come from studio.ts, which is also what clampCfgScale() enforces on
               the way out. Restating 1/8 here let the slider and the clamp drift apart. -->
          <USlider
            v-model="draft.cfgScale"
            :min="CFG_MIN"
            :max="CFG_MAX"
            :step="0.5"
            :disabled="cfgLocked"
          />
        </UFormField>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <UFormField
            label="Temperature"
            :help="draft.temperature.toFixed(2)"
          >
            <USlider
              v-model="draft.temperature"
              :min="0.1"
              :max="1.5"
              :step="0.05"
            />
          </UFormField>

          <UFormField
            label="Top-p"
            :help="draft.topP.toFixed(2)"
          >
            <USlider
              v-model="draft.topP"
              :min="0.1"
              :max="1"
              :step="0.05"
            />
          </UFormField>

          <UFormField
            label="Top-k"
            :help="String(draft.topK)"
          >
            <USlider
              v-model="draft.topK"
              :min="0"
              :max="100"
              :step="5"
            />
          </UFormField>
        </div>

        <UFormField
          label="Seed"
          help="The same seed plus the same instruction gives the same voice every time."
        >
          <div class="flex gap-2">
            <UInput
              v-model.number="draft.seed"
              type="number"
              :min="1"
              :max="999999"
              class="grow"
            />
            <UButton
              icon="i-lucide-dices"
              color="neutral"
              variant="subtle"
              aria-label="Random seed"
              @click="draft.seed = randomSeed()"
            />
          </div>
        </UFormField>

        <UAlert
          v-for="e in errors"
          :key="e"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :description="e"
        />

        <UAlert
          v-if="saveError"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          title="Could not save"
          :description="saveError"
        />

        <UAlert
          v-if="saveWarning"
          color="warning"
          variant="subtle"
          icon="i-lucide-ruler"
          title="Saved, but not calibrated"
          :description="saveWarning"
        />

        <div class="flex items-center gap-2">
          <UButton
            icon="i-lucide-save"
            label="Save voice"
            :loading="saving"
            :disabled="!!errors.length || !dirty"
            @click="save"
          />
          <span
            v-if="!dirty && !errors.length"
            class="text-xs text-muted"
          >No unsaved changes.</span>
        </div>

        <USeparator />

        <!-- ── Lock this voice ────────────────────────────────────────────────── -->
    <div class="flex flex-col gap-2 rounded-lg border border-default p-3">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <UIcon
            :name="lock === 'locked' ? 'i-lucide-lock' : 'i-lucide-lock-open'"
            :class="lock === 'locked' ? 'size-4 text-primary' : 'size-4 text-muted'"
          />
          <span class="text-sm font-medium text-highlighted">
            {{ lock === 'locked' ? 'Locked to a recording' : 'Not locked' }}
          </span>
        </div>

        <UButton
          v-if="lock !== 'locked'"
          size="xs"
          icon="i-lucide-lock"
          label="Lock this voice"
          :loading="locking"
          :disabled="lock !== 'unlockable' || locking || auditioning"
          @click="lockVoice"
        />
        <UButton
          v-else
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-lock-open"
          label="Unlock"
          :loading="locking"
          :disabled="locking"
          @click="unlockVoice"
        />
      </div>

      <p class="text-xs text-muted">{{ lockHint(lock) }}</p>

      <p
        v-if="locking"
        class="text-xs text-dimmed"
      >
        <UIcon
          name="i-lucide-loader-2"
          class="inline size-3 animate-spin"
        />
        {{ queued ? 'Waiting for the rig — studio work queues behind live conversation.' : 'Recording this voice…' }}
      </p>

      <UAlert
        v-if="lockError"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="Could not lock this voice"
        :description="lockError"
      />
    </div>

    <!-- ── Kept seeds ─────────────────────────────────────────────────────── -->
    <div
      v-if="draft.starredSeeds.length"
      class="flex flex-col gap-2"
    >
      <span class="text-sm font-medium text-highlighted">Kept seeds</span>
      <div class="flex flex-wrap gap-2">
        <UButton
          v-for="seed in draft.starredSeeds"
          :key="seed"
          size="xs"
          :color="draft.seed === seed ? 'primary' : 'neutral'"
          :variant="draft.seed === seed ? 'solid' : 'outline'"
          :label="`seed ${seed}`"
          trailing-icon="i-lucide-x"
          @click="draft.seed === seed ? toggleStar(seed) : useStarredSeed(seed)"
        />
      </div>
      <span class="text-xs text-muted">
        Click to load one back into the form; click the one already in use to stop keeping it.
      </span>
    </div>

    <!-- ── Seed audition ──────────────────────────────────────────────────── -->
        <div class="flex flex-col gap-3">
          <div class="flex items-center justify-between gap-2">
            <div class="flex flex-col">
              <span class="text-sm font-medium text-highlighted">Seed audition</span>
              <span class="text-xs text-muted">Four draws of the settings above, rendered one at a time. Nothing is saved.</span>
            </div>
            <UButton
              icon="i-lucide-shuffle"
              label="Try 4 seeds"
              color="neutral"
              variant="subtle"
              :loading="auditioning"
              :disabled="!!auditionBlockedReason || auditioning"
              @click="runAudition"
            />
          </div>

          <p
            v-if="auditionBlockedReason"
            class="text-xs text-dimmed"
          >
            {{ auditionBlockedReason }}
          </p>

          <!-- The rig takes one request at a time and studio work queues behind the live
               agent, so a wait here is normal — say so instead of looking hung. -->
          <p
            v-if="auditioning && queued"
            class="text-xs text-muted"
          >
            <UIcon
              name="i-lucide-loader-2"
              class="inline size-3 animate-spin"
            />
            Waiting on the rig ({{ Math.round(elapsedMs / 1000) }}s) — it renders one request at a time,
            and studio work queues behind live conversation.
          </p>

          <UAlert
            v-if="auditionError"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :description="auditionError"
          />

          <div
            v-for="take in takes"
            :key="take.seed"
            class="flex items-center gap-2 rounded-md border border-default px-3 py-2"
          >
            <span class="text-xs tabular-nums text-muted w-20 shrink-0">seed {{ take.seed }}</span>

            <UBadge
              v-if="take.status === 'rendering'"
              size="sm"
              color="neutral"
              variant="subtle"
              label="rendering…"
            />
            <UBadge
              v-else-if="take.status === 'pending'"
              size="sm"
              color="neutral"
              variant="subtle"
              label="queued"
            />
            <UBadge
              v-else-if="take.status === 'failed'"
              size="sm"
              color="error"
              variant="subtle"
              label="failed"
            />

            <span
              v-if="take.note"
              class="text-xs text-muted grow min-w-0 truncate"
              :title="take.note"
            >{{ take.note }}</span>
            <span
              v-else
              class="grow"
            />

            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-play"
              aria-label="Play this seed"
              :disabled="take.status !== 'ready'"
              @click="playTake(take)"
            />
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              label="Use"
              :disabled="take.status !== 'ready' || auditioning"
              @click="useSeed(take.seed)"
            />
            <!-- The memory casting never had: the same description at another seed is
                 another person, so a take worth keeping must survive the next roll. -->
            <UButton
              size="xs"
              :color="isStarred(take.seed) ? 'primary' : 'neutral'"
              variant="ghost"
              :icon="isStarred(take.seed) ? 'i-lucide-star' : 'i-lucide-star-off'"
              :aria-label="isStarred(take.seed) ? `Stop keeping seed ${take.seed}` : `Keep seed ${take.seed}`"
              @click="toggleStar(take.seed)"
            />
          </div>
        </div>

        </div>
      </template>

      <template #reference>
        <div class="flex flex-col gap-6 pt-4">

        <!-- ── Reference clip ─────────────────────────────────────────────────── -->
        <div class="flex flex-col gap-3">
          <div class="flex flex-col">
            <span class="text-sm font-medium text-highlighted">Reference clip</span>
            <span class="text-xs text-muted">
              About ten seconds of clean speech clones the voice. Longer clips eat the prompt budget the
              text needs — over 20s is warned, over 60s is refused.
            </span>
          </div>

          <UFileUpload
            v-model="refFile"
            accept="audio/wav,.wav"
            icon="i-lucide-file-audio"
            label="Drop a WAV here"
            description="Mono or stereo WAV, about 10 seconds."
            :disabled="refBusy"
            class="min-h-32"
          />

          <div class="flex items-center gap-2">
            <UButton
              :icon="recording ? 'i-lucide-square' : 'i-lucide-mic'"
              :label="recording ? 'Stop recording' : 'Record from mic'"
              :color="recording ? 'error' : 'neutral'"
              variant="subtle"
              size="sm"
              :disabled="refBusy"
              @click="toggleRecording"
            />
            <UButton
              v-if="draft.refStorageKey"
              icon="i-lucide-x"
              label="Remove reference"
              color="neutral"
              variant="ghost"
              size="sm"
              :disabled="refBusy"
              @click="clearReference"
            />
            <span
              v-if="refBusy"
              class="text-xs text-muted"
            >
              <UIcon
                name="i-lucide-loader-2"
                class="inline size-3 animate-spin"
              /> Transcribing…
            </span>
            <span
              v-else-if="refSeconds"
              class="text-xs text-muted tabular-nums"
            >{{ refSeconds }}s clip attached</span>
          </div>

          <UAlert
            v-if="refWarning"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="Long reference"
            :description="refWarning"
          />

          <UAlert
            v-if="refError"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            title="Reference rejected"
            :description="refError"
          />

          <UFormField
            v-if="draft.refStorageKey"
            label="Transcript"
            help="Transcribed automatically. It must match the audio exactly — correct it if Whisper misheard."
          >
            <UTextarea
              v-model="draft.refText"
              :rows="2"
              autoresize
              class="w-full"
            />
          </UFormField>

          <p
            v-if="draft.refStorageKey"
            class="text-xs text-dimmed"
          >
            Saving a new reference re-calibrates this voice's character ceiling against the rig, so the
            save can take a moment.
          </p>
        </div>
        </div>
      </template>
    </UTabs>
  </div>
</template>
