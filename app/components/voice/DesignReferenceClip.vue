<!-- app/components/voice/DesignReferenceClip.vue -->
<script setup lang="ts">
import type { VoicePresetDTO } from '~~/shared/types/voice-presets'
import {
  attachedReference,
  noReference,
  errorMessage,
  type PresetDraft
} from '~/lib/voice/studio'
import { isAbortError, type GenerationGuard } from '~/lib/voice/generation'
import { encodeWav, mixToMono } from '~/lib/voice/wav-encode'
import { BASE_AUDIO, micConstraints, isStaleDeviceError } from '~/lib/voice/mic'

// draft: the SAME reactive object DesignPane holds (itself the same object voice.vue
// holds) — mutated field-by-field here exactly as DesignPane mutates it elsewhere, never
// reassigned. guard: DesignPane's own generation guard, passed in rather than duplicated —
// see the note above the preset-switch watcher below for why.
const props = defineProps<{ preset: VoicePresetDTO | null, draft: PresetDraft, guard: GenerationGuard }>()

const draft = props.draft
const guard = props.guard
const settings = useVoiceSettings().settings

// ── Reference clip ────────────────────────────────────────────────────────────

const refFile = ref<File | null>(null)
const refBusy = ref(false)

// ── Hearing the clip ──────────────────────────────────────────────────────────
// Until this, an attached clip could only be READ about ("11.9s clip attached"). That gap
// mattered most for a locked voice, where the clip is the only record of the person the
// preset now speaks as.
const clip = useClipPlayer()
/** Which storage key the player currently holds. Stops a Save — which turns a draft-only key
 *  into a row key — from re-downloading audio that is already decoded, and stops a stale
 *  waveform sitting under a preset it does not belong to. */
const loadedClipKey = ref<string | null>(null)

watch(
  () => [props.preset?.id ?? null, draft.refStorageKey, props.preset?.refStorageKey ?? null] as const,
  ([id, draftKey, savedKey]) => {
    if (!draftKey) {
      clip.clear()
      loadedClipKey.value = null
      return
    }
    if (draftKey === loadedClipKey.value) return
    // Only a clip that is actually ON THE ROW can be fetched. One that exists only in the
    // draft was just uploaded, and uploadReference already decoded it from the local file.
    if (id && draftKey === savedKey) {
      loadedClipKey.value = draftKey
      void clip.load(`/api/voice/presets/${id}/reference`)
    }
  },
  { immediate: true }
)
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
    // Decoded from the bytes already in the browser — the clip is audible before Save, for
    // the same reason Speak renders the live form rather than the last saved row.
    loadedClipKey.value = res.storageKey
    void clip.load(file)
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
  clip.clear()
  loadedClipKey.value = null
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
    micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(settings.value.micDeviceId) })
      .catch(async (err: unknown) => {
        if (!isStaleDeviceError(err)) throw err
        // Clear the dead selection so the next recording — and the live agent — stop retrying it.
        settings.value = { ...settings.value, micDeviceId: '' }
        refError.value = 'That microphone is no longer available — switched to the system default.'
        return navigator.mediaDevices.getUserMedia({ audio: { ...BASE_AUDIO } })
      })
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

// DesignPane's own preset-switch watcher calls `guard.reset()` first, which — because
// `guard` here is that SAME instance, not a copy — stales any in-flight upload's token
// exactly as it would have before the split. What that reset does NOT do is touch this
// component's local UI state, so the recording-stop and error/warning clearing that used
// to happen inline in that watcher happens here instead, keyed the same way: by preset id,
// not by the preset object (see DesignPane for why).
watch(() => props.preset?.id ?? null, () => {
  // A recording in progress is stopped rather than left running against a preset that is
  // no longer on screen — its onstop lands in finishRecording, which discards it.
  if (recording.value) {
    recorder?.stop()
    recording.value = false
  }
  refError.value = null
  refWarning.value = null
  // Cleared with everything else: the upload widget kept showing the PREVIOUS preset's
  // filename, which reads as "this preset has that clip" when it does not.
  refFile.value = null
  refBusy.value = false
})

onBeforeUnmount(() => {
  micStream?.getTracks().forEach(t => t.stop())
})
</script>

<template>
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
    </div>

    <!-- The clip itself: levels over time, its length, and a way to actually hear it. -->
    <div
      v-if="draft.refStorageKey"
      class="flex items-center gap-2"
    >
      <UButton
        :icon="clip.playing.value ? 'i-lucide-square' : 'i-lucide-play'"
        :aria-label="clip.playing.value ? 'Stop the reference clip' : 'Play the reference clip'"
        color="neutral"
        variant="subtle"
        size="sm"
        :loading="clip.loading.value"
        :disabled="!clip.durationMs.value"
        @click="clip.toggle"
      />
      <VoiceWaveformTrack
        class="min-w-0 flex-1"
        :peaks="clip.peaks.value"
        :duration-ms="clip.durationMs.value"
        :progress="clip.progress.value"
        :pending="clip.loading.value"
      />
    </div>

    <p
      v-if="clip.error.value"
      class="text-xs text-error"
    >{{ clip.error.value }}</p>

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
</template>
