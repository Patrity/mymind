<!-- app/components/agent/PromptInput.vue -->
<!-- The Elements composer — replaces voice/Composer.vue (wired in Task 7). Provider mode: this
     component owns the PromptInput context (usePromptInputProvider) so it can read files,
     openFileDialog, setTextInput and submitForm directly; <PromptInput> below inherits that
     SAME context instead of creating its own (dual-mode — see prompt-input/context.ts). -->
<script setup lang="ts">
import type { AttachmentRef } from '~~/shared/types/conversation'
import type { VoiceState } from '~/composables/useVoice'
import type { ContextMeterData } from '~/lib/agent/context-meter'
import type { PromptInputMessage } from '@/components/ai-elements/prompt-input'
import {
  EllipsisIcon,
  MicIcon,
  MicOffIcon,
  PaperclipIcon,
  SquareIcon,
  Volume2Icon,
  VolumeXIcon
} from '@lucide/vue'
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments
} from '@/components/ai-elements/attachments'
import {
  PromptInput,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputProvider
} from '@/components/ai-elements/prompt-input'
import { ATTACHMENT_ACCEPT, attachmentErrorToast, filesForSubmit, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, uploadAttachment } from '~/lib/agent/attachments'

const props = defineProps<{
  sendText: (t: string, speak?: boolean, attachments?: AttachmentRef[]) => boolean | Promise<boolean>
  busy: boolean
  micOn: boolean
  state: VoiceState
  connected: boolean
  /** Inline Persona in the footer — false in the empty state / voice mode (they mount their own). */
  showPersona: boolean
  contextMeter: ContextMeterData | null
  /** `?q=` hand-off from Home. */
  initialText?: string
  autoSend?: boolean
  /** Starter click — fills the box, never sends. */
  prefill?: string
}>()
const speak = defineModel<boolean>('speak', { required: true })
const model = defineModel<string>('model', { required: true })
const emit = defineEmits<{ stop: []; toggleMic: [] }>()

const toast = useToast()

// Mirrors the page's sentinel and the old AgentToolbar.modelItems build exactly — reka-ui's
// Select rejects an empty-string item value, so "no override" travels as a non-empty sentinel
// the page maps back to an empty cookie / null model.
const DEFAULT_MODEL = '__default__'
const { draft: aiDraft } = useAiConfig()
const modelItems = computed(() => {
  const models = aiDraft.value.models
  const chain = (aiDraft.value.assignments.reasoning ?? [])
    .map(id => models.find(m => m.id === id))
    .filter((m): m is NonNullable<typeof m> => !!m)
  return [{ label: 'Default (chain order)', value: DEFAULT_MODEL }, ...chain.map(m => ({ label: m.label, value: m.id }))]
})

// submitForm() (context.ts) has NO re-entrancy guard of its own — it just sets isLoading
// and awaits. A second submitForm() call (e.g. a click racing the disabled-attribute's
// render flush, or any programmatic re-trigger) would run this onSubmit a second time with
// the SAME tray, duplicating the upload + send. `sending` is a plain synchronous flag — it
// doesn't depend on Vue having flushed `isLoading` to the DOM yet, so it closes that window
// even when the reactive disabled state hasn't re-rendered.
let sending = false
async function onSubmit(msg: PromptInputMessage) {
  if (sending) return
  sending = true
  try {
    const text = msg.text.trim()
    // msg.files is typed FileUIPart[] (no `id`), but submitForm's processedFiles mapping
    // (context.ts) spreads the original AttachmentFile, so `.id` survives on the actual
    // runtime objects — this IS the submitted snapshot's ids. Resolve those ids back
    // against files.value (the live tray) rather than reading files.value directly: addFiles
    // is never gated on isLoading, so a drop/paste/attach landing during submitForm's async
    // blob->dataURL conversion would otherwise get swept into THIS turn's upload — and then
    // sit in the tray looking unsent (clearSubmittedFiles only clears the pre-conversion ids).
    const submittedIds = msg.files as unknown as { id: string }[]
    const pendingFiles = filesForSubmit(submittedIds, files.value)
    if (!text && pendingFiles.length === 0) return

    let refs: AttachmentRef[] = []
    if (pendingFiles.length) {
      // A rejection here propagates out of onSubmit — submitForm's catch restores the text,
      // keeps the files, and reports onError({ code: 'submit_error' }).
      refs = await Promise.all(
        pendingFiles.map(file => uploadAttachment(file, (url, body) => $fetch(url, { method: 'POST', body })))
      )
    }

    await props.sendText(text, speak.value, refs)
  }
  finally {
    sending = false
  }
}

function onError(err: { code: string, message: string }) {
  toast.add({ ...attachmentErrorToast(err.code), color: 'error' })
}

const { textInput, files, isLoading, removeFile, openFileDialog, setTextInput, submitForm } = usePromptInputProvider({
  accept: ATTACHMENT_ACCEPT,
  maxFiles: MAX_ATTACHMENTS,
  maxFileSize: MAX_ATTACHMENT_BYTES,
  onSubmit,
  onError
})

const canSubmit = computed(() => !isLoading.value && (textInput.value.trim().length > 0 || files.value.length > 0))

// `?q=` hand-off: fires at most once per distinct value (same guard as the old
// voice/Composer.vue maybeAutoSend). Vue Router reuses this component instance across a
// query-only navigation on the same route, so both the first mount AND later prop changes
// need to run through the same watcher — hence `immediate`.
let autoSentText: string | undefined
async function maybeAutoSend(value: string | undefined) {
  if (!props.autoSend || !value || autoSentText === value) return
  autoSentText = value
  await nextTick()
  await submitForm()
}
watch(() => props.initialText, (v) => {
  if (!v) return
  setTextInput(v)
  void maybeAutoSend(v)
}, { immediate: true })

// Starter-click prefill: only ever fills the box, never sends — deliberately a separate prop
// (see voice/Composer.vue's comment) so it can't be swept up by the autoSend once-per-value guard.
watch(() => props.prefill, (v) => {
  if (!v) return
  setTextInput(v)
})
</script>

<template>
  <PromptInput multiple global-drop :accept="ATTACHMENT_ACCEPT">
    <PromptInputHeader v-if="files.length">
      <Attachments variant="inline">
        <Attachment
          v-for="file in files"
          :key="file.id"
          :data="file"
          @remove="removeFile(file.id)"
        >
          <AttachmentPreview />
          <AttachmentInfo />
          <AttachmentRemove />
        </Attachment>
      </Attachments>
    </PromptInputHeader>

    <PromptInputBody>
      <PromptInputTextarea placeholder="Ask Bridget…" />
    </PromptInputBody>

    <PromptInputFooter>
      <PromptInputTools>
        <AgentPersona v-if="showPersona" size="inline" :state="state" :connected="connected" />

        <PromptInputButton aria-label="Attach files" @click="openFileDialog">
          <PaperclipIcon class="size-4" />
        </PromptInputButton>

        <!-- sm and up: model select + context meter sit inline in the toolbar. -->
        <PromptInputSelect v-model="model">
          <PromptInputSelectTrigger size="sm" aria-label="Agent model" class="hidden sm:flex">
            <PromptInputSelectValue placeholder="Model" />
          </PromptInputSelectTrigger>
          <PromptInputSelectContent>
            <PromptInputSelectItem v-for="item in modelItems" :key="item.value" :value="item.value">
              {{ item.label }}
            </PromptInputSelectItem>
          </PromptInputSelectContent>
        </PromptInputSelect>

        <PromptInputButton
          :variant="speak ? 'secondary' : 'ghost'"
          :aria-pressed="speak"
          aria-label="Toggle voice replies"
          @click="speak = !speak"
        >
          <Volume2Icon v-if="speak" class="size-4" />
          <VolumeXIcon v-else class="size-4" />
        </PromptInputButton>

        <div class="hidden sm:block">
          <AgentContextMeter :data="contextMeter" />
        </div>

        <!-- below sm: model select + context meter fold into a "…" action menu. -->
        <div class="sm:hidden">
          <PromptInputActionMenu>
            <PromptInputActionMenuTrigger aria-label="More">
              <EllipsisIcon class="size-4" />
            </PromptInputActionMenuTrigger>
            <PromptInputActionMenuContent class="w-56 space-y-3 p-3">
              <PromptInputSelect v-model="model">
                <PromptInputSelectTrigger size="sm" aria-label="Agent model" class="w-full">
                  <PromptInputSelectValue placeholder="Model" />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
                  <PromptInputSelectItem v-for="item in modelItems" :key="item.value" :value="item.value">
                    {{ item.label }}
                  </PromptInputSelectItem>
                </PromptInputSelectContent>
              </PromptInputSelect>
              <AgentContextMeter :data="contextMeter" />
            </PromptInputActionMenuContent>
          </PromptInputActionMenu>
        </div>
      </PromptInputTools>

      <PromptInputTools>
        <PromptInputButton
          :variant="micOn ? 'secondary' : 'ghost'"
          :aria-pressed="micOn"
          :aria-label="micOn ? 'Disable microphone' : 'Enable microphone'"
          @click="emit('toggleMic')"
        >
          <MicIcon v-if="micOn" class="size-4" />
          <MicOffIcon v-else class="size-4" />
        </PromptInputButton>

        <PromptInputButton
          v-if="busy"
          type="button"
          aria-label="Stop generating"
          @click="emit('stop')"
        >
          <SquareIcon class="size-4" />
        </PromptInputButton>
        <PromptInputSubmit v-else :disabled="!canSubmit" />
      </PromptInputTools>
    </PromptInputFooter>
  </PromptInput>
</template>
