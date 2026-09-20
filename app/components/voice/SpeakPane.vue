<!-- app/components/voice/SpeakPane.vue -->
<script setup lang="ts">
import type { VoicePresetDTO } from '~~/shared/types/voice-presets'
import type { ConversationDTO, ConversationMessageDTO } from '~~/shared/types/conversation'
import { InputGroup, InputGroupTextarea } from '@/components/ui/input-group'
import { PromptInputFooter, PromptInputTools } from '@/components/ai-elements/prompt-input'
import {
  EVENT_TAGS,
  diagnoseStreamRender,
  describeRenderPlan,
  diagnoseTruncation,
  draftToOverrides,
  errorFromResponseBody,
  errorMessage,
  insertAtCursor,
  messagesToScript,
  type PresetDraft
} from '~/lib/voice/studio'
import { readWavInfo } from '~/lib/voice/wav-encode'

// `draft` is the LIVE form state from the Voice tab, not the saved row. Speak has to render
// what the user is currently looking at — making them save before they can hear a change is
// what turns designing a voice into a chore, and it also means a bad experiment is persisted
// just to audition it. The server merges these as in-memory overrides and never writes them.
const props = defineProps<{ preset: VoicePresetDTO | null, draft: PresetDraft | null }>()

/** Realtime reproduces the live agent's segmentation so the two can be compared by ear;
 *  quality (the default) keeps the text in one call wherever it fits. */
const mode = ref<'quality' | 'realtime'>('quality')
const modeItems = [
  { label: 'Quality', value: 'quality' as const },
  { label: 'Realtime', value: 'realtime' as const },
]

const text = ref('')
const {
  speak, stop, replay, speaking, ttfaMs, audioBytes, sampleRate, cancelled, error,
  peaks, progress, replayable
} = useBreezeSpeech()

/** Length of the audio that actually arrived, from the byte count — the same number the
 *  truncation diagnosis is derived from, so the track and the warning always agree. */
const renderedMs = computed(() =>
  audioBytes.value ? Math.round((audioBytes.value / 2 / sampleRate.value) * 1000) : null)

/** The track appears as soon as audio starts arriving and stays afterwards, so a render can
 *  be looked at as well as listened to — a truncated one is visibly short. */
const showTrack = computed(() => peaks.value.length > 0 || speaking.value)

// Anything the render itself has to say that is not an error: a truncation diagnosis,
// mostly. Cleared at the start of every attempt.
const note = ref<string | null>(null)

// What will actually happen to this text, stated before the user presses Speak.
// This replaces a warning that said the render "will very likely stop early" — which was
// true when the route always sent one call, and fired on every ordinary read-aloud because
// all eight seeded design presets carry the unmeasured default of 200. The route now splits
// at the real ceiling instead of overrunning it, so the honest thing to report is the split.
const renderPlan = computed(() => {
  const p = props.preset
  const chars = text.value.trim().length
  if (!p || !chars) return null
  const draft = props.draft
  return describeRenderPlan(chars, {
    instruction: draft ? draft.instruction : p.instruction,
    refStorageKey: p.refStorageKey,
    maxSegmentChars: p.maxSegmentChars,
  }, mode.value)
})

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
// InputGroupTextarea exposes nothing of its own (no defineExpose in InputGroupTextarea.vue
// or the Textarea.vue it wraps) — but `$el` is part of every component's public instance
// and resolves through the InputGroupTextarea -> Textarea -> <textarea> chain to the real
// DOM node, which is where the caret actually is. Falling back silently here
// (selectionStart undefined -> text.length) is exactly the bug this ref exists to avoid.
const textareaRef = useTemplateRef<{ $el?: HTMLTextAreaElement | null }>('speakBox')

function insertTag(tag: string) {
  const el = textareaRef.value?.$el
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
  // draftToOverrides sends whatever is in the form right now. Falls back to the saved row
  // when there is no draft (nothing selected yet), which is the pre-existing behaviour.
  await speak(body, p.id, {
    overrides: props.draft ? draftToOverrides(props.draft) : undefined,
    mode: mode.value,
  })
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
      body: JSON.stringify({
        text: body,
        presetId: p.id,
        format: 'wav',
        // Same live form state and mode as Speak — downloading something that differs from
        // what you just heard would be its own small betrayal.
        overrides: props.draft ? draftToOverrides(props.draft) : undefined,
        mode: mode.value,
      })
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

    <InputGroup>
      <InputGroupTextarea
        ref="speakBox"
        v-model="text"
        :rows="10"
        placeholder="Type or paste what the voice should read."
      />
      <PromptInputFooter class="flex-wrap gap-y-2">
        <PromptInputTools class="flex-wrap gap-y-1">
          <!-- Quality keeps the text in one call wherever it fits; Realtime reproduces the
               live agent's segmentation. Measured, the split costs 10.3% more audio and
               audible seams to buy 22ms — so Quality is the default and Realtime is for
               comparing by ear. -->
          <UFieldGroup size="xs">
            <UButton
              v-for="m in modeItems"
              :key="m.value"
              :label="m.label"
              :color="mode === m.value ? 'primary' : 'neutral'"
              :variant="mode === m.value ? 'solid' : 'outline'"
              @click="mode = m.value"
            />
          </UFieldGroup>
          <span class="text-xs text-muted">Insert:</span>
          <UButton
            v-for="tag in EVENT_TAGS"
            :key="tag"
            size="xs"
            color="neutral"
            variant="subtle"
            :label="tag"
            @click="insertTag(tag)"
          />
        </PromptInputTools>
        <PromptInputTools class="flex-wrap gap-y-1">
          <span class="text-xs tabular-nums text-dimmed">{{ text.trim().length }} chars</span>
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
        </PromptInputTools>
      </PromptInputFooter>
    </InputGroup>

    <!-- Not a warning: a statement of what the route will do with this text. Only the
         multi-call case is worth surfacing, because that is the one with audible seams. -->
    <UAlert
      v-if="renderPlan"
      color="info"
      variant="subtle"
      icon="i-lucide-scissors"
      title="This will be split"
      :description="renderPlan"
    />

    <div class="flex flex-wrap items-center gap-2">
      <!-- The rig serves one request at a time and a read-aloud can take ten seconds, so
           re-rendering to hear the same words again is the most expensive way to answer the
           cheapest question. The samples are already decoded. -->
      <UButton
        icon="i-lucide-rotate-ccw"
        label="Play again"
        color="neutral"
        variant="subtle"
        :disabled="!replayable || speaking"
        @click="replay"
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

    <VoiceWaveformTrack
      v-if="showTrack"
      :peaks="peaks"
      :duration-ms="renderedMs"
      :progress="progress"
      :pending="speaking && !peaks.length"
    />

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
