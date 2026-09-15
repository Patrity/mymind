<!-- app/components/voice/SpeakPane.vue -->
<script setup lang="ts">
import type { VoicePresetDTO } from '~~/shared/types/voice-presets'
import type { ConversationDTO, ConversationMessageDTO } from '~~/shared/types/conversation'
import {
  EVENT_TAGS,
  diagnoseStreamRender,
  diagnoseTruncation,
  errorFromResponseBody,
  errorMessage,
  insertAtCursor,
  messagesToScript,
  overCapWarning
} from '~/lib/voice/studio'
import { readWavInfo } from '~/lib/voice/wav-encode'

const props = defineProps<{ preset: VoicePresetDTO | null }>()

const text = ref('')
const { speak, stop, speaking, ttfaMs, audioBytes, sampleRate, cancelled, error } = useBreezeSpeech()

// Anything the render itself has to say that is not an error: a truncation diagnosis,
// mostly. Cleared at the start of every attempt.
const note = ref<string | null>(null)

const capWarning = computed(() =>
  props.preset ? overCapWarning(text.value.trim().length, props.preset.maxSegmentChars) : null
)

// ── Pull something in from MyMind ─────────────────────────────────────────────
// The three lists come from the existing composables so they stay live (vue-query keys
// the live bus already invalidates) rather than being fetched by hand here.
const { useDocList } = useDocuments()
const { useMemoryList } = useMemories()
const { useConversationList, getConversation } = useConversations()

const { data: docs } = useDocList(() => undefined)
const { data: memories } = useMemoryList(() => ({ limit: 50 }))
const { data: conversations } = useConversationList()

function trim(s: string, n = 70): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n)}…` : flat
}

// Array-of-arrays renders three separated groups. Every value is a non-empty string:
// reka-ui's ComboboxItem throws on an empty-string item value.
const sourceItems = computed(() => [
  (docs.value ?? []).slice(0, 50).map(d => ({
    label: trim(d.title || d.path),
    value: `doc:${d.id}`,
    icon: 'i-lucide-file-text'
  })),
  (memories.value ?? []).slice(0, 50).map(m => ({
    label: trim(m.content),
    value: `mem:${m.id}`,
    icon: 'i-lucide-brain'
  })),
  (conversations.value ?? []).slice(0, 50).map(c => ({
    label: trim(c.title || 'Untitled conversation'),
    value: `conv:${c.id}`,
    icon: 'i-lucide-messages-square'
  }))
])

const sourceKey = ref<string | undefined>(undefined)
const loadingSource = ref(false)
const sourceError = ref<string | null>(null)

watch(sourceKey, (key) => {
  if (key) void loadSource(key)
})

async function loadSource(key: string) {
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
  loadingSource.value = true
  sourceError.value = null
  try {
    if (kind === 'doc') {
      text.value = (docs.value ?? []).find(d => d.id === id)?.content ?? ''
    } else if (kind === 'mem') {
      text.value = (memories.value ?? []).find(m => m.id === id)?.content ?? ''
    } else if (kind === 'conv') {
      // The list carries only a snippet; the messages live on the detail route.
      const full = await getConversation(id) as { conversation: ConversationDTO, messages: ConversationMessageDTO[] }
      text.value = messagesToScript(full.messages.map(m => ({ role: m.role, content: m.content })))
    }
  } catch (e) {
    sourceError.value = errorMessage(e)
  } finally {
    loadingSource.value = false
  }
}

// ── Event tags ────────────────────────────────────────────────────────────────
// UTextarea exposes its inner <textarea> as `textareaRef`, which is where the caret is.
const textareaRef = useTemplateRef<{ textareaRef?: HTMLTextAreaElement | null }>('speakBox')

function insertTag(tag: string) {
  const el = textareaRef.value?.textareaRef
  const start = el?.selectionStart ?? text.value.length
  const end = el?.selectionEnd ?? start
  const next = insertAtCursor(text.value, tag, start, end)
  text.value = next.value
  void nextTick(() => {
    el?.focus()
    el?.setSelectionRange(next.cursor, next.cursor)
  })
}

// ── Speak ─────────────────────────────────────────────────────────────────────

async function onSpeak() {
  const p = props.preset
  const body = text.value.trim()
  if (!p || !body || speaking.value) return
  note.value = null
  await speak(body, p.id)
  // A `truncated` failure NEVER arrives as a message: the rig answers 200 OK and then
  // dies mid-stream, so the only evidence is how much audio actually showed up. Counting
  // BYTES, not just "did anything arrive": a stream that delivers one frame and then dies
  // is the commoner overrun shape, and it sets ttfaMs like a healthy one.
  //
  // `cancelled` is checked because stop() produces exactly the same shape as a truncation
  // — no error, little or no audio — and telling a user their own cancel was a prompt
  // overrun is worse than saying nothing.
  note.value = diagnoseStreamRender({
    chars: body.length,
    audioBytes: audioBytes.value,
    sampleRate: sampleRate.value,
    error: error.value,
    cancelled: cancelled.value
  })
}

const downloading = ref(false)

async function onDownload() {
  const p = props.preset
  const body = text.value.trim()
  if (!p || !body || downloading.value) return
  downloading.value = true
  note.value = null
  // `error` belongs to useBreezeSpeech's speak lifecycle, which clears it at the start of
  // every speak(). Clearing it here too keeps the two entry points symmetrical, so a stale
  // failure from one button cannot hang over the other.
  error.value = null
  try {
    const res = await fetch('/api/voice/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `format` goes in the BODY on this route — it is not a query parameter.
      body: JSON.stringify({ text: body, presetId: p.id, format: 'wav' })
    })
    // Parsed, not raw: `fetch` hands back the whole h3 JSON error envelope, and the
    // pre-flight's 400 sentence is one field inside it.
    if (!res.ok) throw new Error(errorFromResponseBody(await res.text().catch(() => ''), res.statusText))
    const blob = await res.blob()
    // Here the whole file is in hand, so the truncation check can use real byte counts
    // rather than the stream path's "did anything arrive at all".
    const info = readWavInfo(new Uint8Array(await blob.arrayBuffer()))
    note.value = diagnoseTruncation({
      chars: body.length,
      audioBytes: info?.dataBytes ?? 0,
      sampleRate: info?.sampleRate ?? 24000
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${p.name}.wav`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    // A thrown download is a HARD failure — a 400 from the pre-flight, a 502 from an
    // unreachable rig, a dropped connection. It is NOT a truncation, and it must not be
    // dressed as one: `note` renders under "Nothing came back", which in this cycle means
    // specifically "the rig accepted the text and then died on a prompt-ceiling overrun".
    // Labelling a rejected request that way destroys the one diagnostic distinction the
    // whole truncation path exists to draw. Errors belong in the error channel.
    error.value = errorMessage(e)
  } finally {
    downloading.value = false
  }
}
</script>

<template>
  <div class="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4">
    <UFormField
      label="Read from MyMind"
      help="Loads a document, a memory, or a conversation's replies into the box below."
    >
      <USelectMenu
        v-model="sourceKey"
        :items="sourceItems"
        value-key="value"
        placeholder="Pick something to read…"
        icon="i-lucide-library"
        :loading="loadingSource"
        class="w-full"
      />
    </UFormField>

    <UAlert
      v-if="sourceError"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="Could not load that"
      :description="sourceError"
    />

    <UFormField label="Text">
      <UTextarea
        ref="speakBox"
        v-model="text"
        :rows="10"
        placeholder="Type or paste what the voice should read."
        class="w-full"
      />
    </UFormField>

    <div class="flex flex-wrap items-center gap-1">
      <span class="text-xs text-muted mr-1">Insert:</span>
      <UButton
        v-for="tag in EVENT_TAGS"
        :key="tag"
        size="xs"
        color="neutral"
        variant="subtle"
        :label="tag"
        @click="insertTag(tag)"
      />
      <span class="grow" />
      <span class="text-xs tabular-nums text-dimmed">{{ text.trim().length }} chars</span>
    </div>

    <!-- /api/voice/speak hands the text to Breeze in ONE piece — it does not segment the
         way the agent pipeline does — so the calibrated ceiling is a hard limit here. -->
    <UAlert
      v-if="capWarning"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="Longer than this voice is calibrated for"
      :description="capWarning"
    />

    <div class="flex flex-wrap items-center gap-2">
      <UButton
        icon="i-lucide-volume-2"
        label="Speak"
        :loading="speaking"
        :disabled="!props.preset || !text.trim() || speaking"
        @click="onSpeak"
      />
      <UButton
        icon="i-lucide-square"
        label="Stop"
        color="neutral"
        variant="subtle"
        :disabled="!speaking"
        @click="stop"
      />
      <UButton
        icon="i-lucide-download"
        label="Download WAV"
        color="neutral"
        variant="subtle"
        :loading="downloading"
        :disabled="!props.preset || !text.trim() || downloading"
        @click="onDownload"
      />
      <span
        v-if="ttfaMs !== null"
        class="text-xs text-muted tabular-nums"
      >first audio in {{ ttfaMs }} ms</span>
    </div>

    <!-- Studio renders queue behind the live agent on a rig that serves one request at a
         time, so "nothing yet" is a queue, not a hang. -->
    <p
      v-if="speaking && ttfaMs === null"
      class="text-xs text-muted"
    >
      <UIcon
        name="i-lucide-loader-2"
        class="inline size-3 animate-spin"
      />
      Waiting on the rig — it renders one request at a time, and studio work queues behind live
      conversation.
    </p>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="Synthesis failed"
      :description="error"
    />

    <UAlert
      v-if="note"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="Nothing came back"
      :description="note"
    />

    <p
      v-if="!props.preset"
      class="text-xs text-muted"
    >
      Select a voice on the left to speak with it.
    </p>
  </div>
</template>
