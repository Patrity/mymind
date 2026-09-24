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
  PromptInputCommand,
  PromptInputCommandItem,
  PromptInputCommandList,
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
import { useFilter } from 'reka-ui'
import { ATTACHMENT_ACCEPT, attachmentErrorToast, filesForSubmit, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, uploadAttachment } from '~/lib/agent/attachments'
import { applySelection, menuQuery, nextHighlight, parseCommand, shouldInterceptEnter, shouldOpenMenu } from '~/lib/agent/slash'

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
const emit = defineEmits<{
  stop: []
  toggleMic: []
  /** A submitted `client`-kind command (currently `/clear` / `/new`) — the page owns the WS
   *  and maps `name` to the right control frame. Never fired for `prompt`/`skill` kinds, which
   *  become an ordinary turn instead (see onSubmit). */
  command: [cmd: { name: string; args: string }]
}>()

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

// Re-entrancy (a second submitForm() call racing in while this one is still uploading) is
// guarded at the source — usePromptInputProvider's submitForm() (context.ts, MyMind patch)
// returns immediately while isLoading is true, so onSubmit itself never runs twice for an
// overlapping submit. Guarding it again here would be a second, redundant mechanism.
async function onSubmit(msg: PromptInputMessage) {
  const text = msg.text.trim()

  // `client`-kind commands (/clear, /new) never become a turn — they dispatch a WS control
  // frame instead, straight from here rather than through sendText. Checked against the LIVE
  // command list (commands.value), not the hardcoded CLIENT_COMMANDS fallback, so kind is what
  // decides dispatch even if a future server-defined entry ever shadows one of these names.
  // Any attachments already in the tray are deliberately left untouched — a stray file dropped
  // alongside a command is not part of it.
  const cmd = parseCommand(text)
  if (cmd) {
    const entry = commands.value.find(c => c.name === cmd.name)
    if (entry?.kind === 'client') {
      emit('command', { name: entry.name, args: cmd.args })
      setTextInput('')
      return
    }
  }

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

// The `/` command menu. Selection FILLS the input via setTextInput and never calls
// submitForm() — /clear is destructive enough that a menu click must never fire it;
// the user still has to press Enter.
const { commands } = useCommands()
// Filtering is local (reka-ui's own useFilter, the same primitive Command.vue itself
// uses internally) — no per-keystroke fetch. We filter here rather than mounting the
// vendored CommandInput, because ListboxFilter hardcodes auto-focus and would steal
// keyboard focus from the composer textarea, where the user is actually typing.
const { contains } = useFilter({ sensitivity: 'base' })

// Escape closes the menu without touching the input text — but menuOpen is derived
// from that text, so a plain "closed" flag would reopen on the very next keystroke.
// menuDismissed survives until the text no longer starts a command (spec §4 also
// says "so does deleting the /", which shouldOpenMenu already gives us for free —
// once the leading `/` is gone, menuOpen is false regardless of this flag). Typing
// further into the SAME command (still `/something`) intentionally does not
// resurrect a menu the user just escaped from; only starting over does.
const menuDismissed = ref(false)
const menuOpen = computed(() => shouldOpenMenu(textInput.value) && !menuDismissed.value)
watch(() => textInput.value, (v) => {
  if (!v.startsWith('/')) menuDismissed.value = false
})

const filteredCommands = computed(() => {
  const q = menuQuery(textInput.value)
  return q ? commands.value.filter(c => contains(c.name, q)) : commands.value
})

// Keyboard highlight is ours to track (not reka's) since we never focus the listbox
// subtree — see the useFilter comment above. Reset whenever the candidate list
// changes shape or the menu (re)opens, so a stale index never points past the end.
const highlightedIndex = ref(0)
watch(filteredCommands, () => {
  highlightedIndex.value = 0
})
watch(menuOpen, (open) => {
  if (open) highlightedIndex.value = 0
})

function onPickCommand(name: string) {
  setTextInput(applySelection(name))
}

// Bridges keyboard control into the menu. PromptInputTextarea emits `keydown`
// (rather than exposing it as a plain fallthrough attr) specifically so this runs
// BEFORE its own Enter-submits-the-form logic — see that component's comment.
function onComposerKeydown(e: KeyboardEvent) {
  if (!menuOpen.value) return

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    highlightedIndex.value = nextHighlight(highlightedIndex.value, filteredCommands.value.length, 1)
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    highlightedIndex.value = nextHighlight(highlightedIndex.value, filteredCommands.value.length, -1)
    return
  }
  if (e.key === 'Enter') {
    // Shift+Enter is always a newline (PromptInputTextarea's own path), and with
    // nothing matched there is nothing to select — let "/foo" submit as plain
    // text instead of eating Enter. shouldInterceptEnter is the single source of
    // truth for this decision; do not re-derive it inline here.
    if (!shouldInterceptEnter(e, filteredCommands.value.length)) return
    e.preventDefault()
    e.stopPropagation()
    const chosen = filteredCommands.value[highlightedIndex.value]
    if (chosen) onPickCommand(chosen.name)
    return
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    menuDismissed.value = true
  }
  // Tab: intentionally left alone — no focus trap.
}

// `?q=` hand-off: fires at most once per distinct value (same guard as the old
// voice/Composer.vue maybeAutoSend). Vue Router reuses this component instance across a
// query-only navigation on the same route, so both the first mount AND later prop changes
// need to run through the same watcher — hence `immediate`.
//
// Callers must hand `initialText` over AFTER this component is mounted (the /agent page
// does it at the end of its own onMounted). A value present during SETUP auto-submits
// before the textarea subtree exists, and submitForm()'s clear then never reaches the DOM
// — ui/textarea's useVModel(passive) proxy is seeded from the pre-clear value, so the
// provider's textInput reads '' while the box still shows the sent question.
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

    <PromptInputCommand v-if="menuOpen" class="mb-2 rounded-md border border-default bg-elevated">
      <PromptInputCommandList>
        <PromptInputCommandItem
          v-for="(c, i) in filteredCommands"
          :key="c.name"
          :value="c.name"
          :class="i === highlightedIndex ? 'bg-accented text-highlighted' : ''"
          @select="onPickCommand(c.name)"
          @mouseenter="highlightedIndex = i"
        >
          <span class="font-mono">/{{ c.name }}</span>
          <span class="ml-2 text-xs text-muted">{{ c.description }}</span>
          <span v-if="c.hint" class="ml-2 text-xs text-dimmed">{{ c.hint }}</span>
        </PromptInputCommandItem>
      </PromptInputCommandList>
    </PromptInputCommand>

    <PromptInputBody>
      <PromptInputTextarea placeholder="Ask Bridget…" @keydown="onComposerKeydown" />
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
