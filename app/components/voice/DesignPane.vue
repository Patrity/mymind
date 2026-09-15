<!-- app/components/voice/DesignPane.vue -->
<script setup lang="ts">
import type { VoicePresetDTO } from '~~/shared/types/voice-presets'
import {
  CFG_LOCK_REASON,
  auditionSeeds,
  blankDraft,
  draftIsDirty,
  draftToBody,
  errorMessage,
  isCfgLocked,
  presetToDraft,
  randomSeed,
  validatePresetDraft,
  diagnoseTruncation,
  type PresetDraft
} from '~/lib/voice/studio'
import { encodeWav, mixToMono, readWavInfo } from '~/lib/voice/wav-encode'

const props = defineProps<{ preset: VoicePresetDTO | null }>()
const emit = defineEmits<{ saved: [VoicePresetDTO] }>()

const draft = reactive<PresetDraft>(blankDraft())
const saving = ref(false)
const saveError = ref<string | null>(null)

const errors = computed(() => validatePresetDraft(draft))
const dirty = computed(() => draftIsDirty(draft, props.preset))
const cfgLocked = computed(() => isCfgLocked(draft.instruction))

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
  try {
    const saved = await $fetch<VoicePresetDTO>(`/api/voice/presets/${p.id}`, {
      method: 'PATCH',
      body: draftToBody(draft)
    })
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

/** One complete WAV from /api/voice/speak, plus whatever its size says about it. */
async function renderWav(text: string, presetId: string): Promise<{ blob: Blob, note: string | null }> {
  const res = await fetch('/api/voice/speak', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // `format` belongs in the BODY — it is not a query parameter on this route.
    body: JSON.stringify({ text, presetId, format: 'wav' })
  })
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || res.statusText)
  const blob = await res.blob()
  const info = readWavInfo(new Uint8Array(await blob.arrayBuffer()))
  return {
    blob,
    note: diagnoseTruncation({
      chars: text.length,
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

/** The audition needs a SAVED row: /api/voice/speak resolves the preset from the
 *  database and takes no inline overrides, so the only way to hear a different seed is
 *  to PATCH the row, render, and put the seed back. */
const auditionBlockedReason = computed(() => {
  // While the audition runs it is PATCHing the seed itself, so the row legitimately
  // differs from the draft — don't tell the user to save because of our own writes.
  if (auditioning.value) return null
  if (!props.preset) return 'Select a voice first.'
  if (dirty.value) return 'Save your changes first — an audition renders the saved voice.'
  return null
})

async function runAudition() {
  const p = props.preset
  if (!p || auditioning.value || auditionBlockedReason.value) return
  clearTakes()
  takes.value = auditionSeeds(draft.seed).map(seed => ({ seed, status: 'pending', url: null, note: null }))
  auditioning.value = true
  auditionError.value = null
  const restoreTo = draft.seed
  try {
    // STRICTLY sequential. The rig serves one request at a time — firing four at once
    // 409s three of them. Awaiting each take in turn is the whole design here.
    for (const take of takes.value) {
      take.status = 'rendering'
      startClock()
      try {
        await $fetch(`/api/voice/presets/${p.id}`, { method: 'PATCH', body: { seed: take.seed } })
        const { blob, note } = await renderWav(AUDITION_TEXT, p.id)
        take.url = URL.createObjectURL(blob)
        take.note = note
        take.status = 'ready'
      } catch (e) {
        take.status = 'failed'
        take.note = errorMessage(e)
      } finally {
        stopClock()
      }
    }
  } finally {
    // Put the row back the way the user left it — an audition is a listening exercise,
    // not an edit.
    await $fetch(`/api/voice/presets/${p.id}`, { method: 'PATCH', body: { seed: restoreTo } })
      .catch((e) => {
        auditionError.value = `The seed could not be restored: ${errorMessage(e)}`
      })
    auditioning.value = false
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
  refBusy.value = true
  refError.value = null
  refWarning.value = null
  try {
    const form = new FormData()
    form.append('audio', file, filename)
    const res = await $fetch<{ storageKey: string, refText: string, durationMs: number, warning: string | null }>(
      '/api/voice/reference',
      { method: 'POST', body: form }
    )
    draft.refStorageKey = res.storageKey
    draft.refText = res.refText
    draft.refDurationMs = res.durationMs
    // Non-null past 20s. The clip shares the prompt budget with the text, so this is the
    // warning that explains a later render stopping early.
    refWarning.value = res.warning
  } catch (e) {
    // The server's own sentence carries the 60s limit and the measured length — show it
    // rather than a generic failure.
    refError.value = errorMessage(e)
  } finally {
    refBusy.value = false
  }
}

function clearReference() {
  draft.refStorageKey = null
  draft.refText = ''
  draft.refDurationMs = null
  refFile.value = null
  refWarning.value = null
  refError.value = null
}

let recorder: MediaRecorder | null = null
let micStream: MediaStream | null = null
let recordedChunks: Blob[] = []

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
  recorder.start()
  recording.value = true
}

async function finishRecording() {
  recording.value = false
  micStream?.getTracks().forEach(t => t.stop())
  micStream = null
  const recorded = new Blob(recordedChunks, { type: recorder?.mimeType || 'audio/webm' })
  recordedChunks = []
  if (!recorded.size) {
    refError.value = 'Nothing was recorded.'
    return
  }
  // MediaRecorder produces webm/opus; /api/voice/reference requires RIFF/WAVE and 400s
  // on anything else. Decode and re-encode rather than sending what the browser gave us.
  const ctx = new AudioContext()
  try {
    const decoded = await ctx.decodeAudioData(await recorded.arrayBuffer())
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i))
    const wav = encodeWav(mixToMono(channels), decoded.sampleRate)
    await uploadReference(new Blob([wav], { type: 'audio/wav' }), 'recording.wav')
  } catch (e) {
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
// resource: every PATCH publishes a change, the SSE dispatch invalidates
// ['voicePreset','list'], and the refetch hands down a NEW object for the SAME row. A
// watcher on the object would therefore fire mid-audition (which PATCHes the seed four
// times) and mid-edit (any other tab touching the row), wiping the form and the takes.
// A different ID is the only thing that actually means "a different voice is selected".
watch(() => props.preset?.id ?? null, () => {
  const p = props.preset
  Object.assign(draft, p ? presetToDraft(p) : blankDraft())
  starterKey.value = undefined
  saveError.value = null
  refError.value = null
  refWarning.value = null
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
      <USlider
        v-model="draft.cfgScale"
        :min="1"
        :max="8"
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

    <!-- ── Seed audition ──────────────────────────────────────────────────── -->
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-2">
        <div class="flex flex-col">
          <span class="text-sm font-medium text-highlighted">Seed audition</span>
          <span class="text-xs text-muted">Four draws of the same voice, rendered one at a time.</span>
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
      </div>
    </div>

    <USeparator />

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
