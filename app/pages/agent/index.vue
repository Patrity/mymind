<script setup lang="ts">
import type { TranscriptEntry } from '~/composables/useVoice'
import { buildResumeTranscript } from '~/lib/agent/transcript'

definePageMeta({ title: 'Agent' })

const voice = useVoice()
const route = useRoute()

// Home's "Ask the brain" box hands the question over via ?q=, and the composer submits it
// automatically on arrival — you land in a running answer, not a filled-in box.
// Read ONCE at setup, deliberately not a computed: the composer must receive it on its
// first mount, and it must NOT go undefined when the URL is stripped below.
const handoffQuery = route.query.q
const initialComposerText = typeof handoffQuery === 'string' && handoffQuery.trim() ? handoffQuery : undefined

// Strip `q` from the URL as soon as we've captured it. The question is auto-submitted, so
// leaving it in the address bar would mean a refresh, a bookmark, or a back-button
// navigation silently fires the same model call again.
const router = useRouter()
onMounted(() => {
  if (!initialComposerText) return
  void router.replace({ path: route.path, query: { ...route.query, q: undefined } })
})

// Persistent preference (cookie-backed so it survives page reloads)
const speakReply = useCookie<boolean>('agent-speak', { default: () => false })

// Reasoning-model override (ephemeral, cookie-backed). Empty cookie = default chain order.
// reka-ui's USelectMenu rejects an empty-string item value, so the "Default" option uses a
// non-empty sentinel that maps back to "no override" (empty cookie / null to setModel).
// AgentToolbar builds the item list around the same sentinel.
const DEFAULT_MODEL = '__default__'
const { load: loadAiConfig, draft: aiDraft } = useAiConfig()
const agentModel = useCookie<string>('agent-model', { default: () => '' })
const selectedModel = computed({
  get: () => agentModel.value || DEFAULT_MODEL,
  set: (val: string) => {
    const id = val === DEFAULT_MODEL ? '' : val
    agentModel.value = id
    voice.setModel(id || null)
  }
})

// Mic-on state is local — it reflects whether the VAD is actually running
const micOn = ref(false)

// Which thread the conversation column is showing. Drives the rail's active row and
// the toolbar title; null means an unsaved/new conversation.
const activeConversationId = ref<string | null>(null)
const activeTitle = ref<string | null>(null)

// Thread rail as a slideover — the only way to reach threads under lg, where the rail
// column is hidden.
const threadsOpen = ref(false)

// Full-bleed voice mode (the overlay itself lands with the avatar work).
const fullBleed = ref(false)

// Caption over the avatar: the message currently being spoken/typed. Tool chips are not
// captions — show the latest user/assistant text instead. Consumed by full-bleed mode.
const caption = computed(() => {
  const t = voice.transcript.value
  for (let i = t.length - 1; i >= 0; i--) if (t[i]!.role !== 'tool') return t[i]!
  return null
})

// Undo a tool call from its inline transcript chip.
const toast = useToast()
const redeem = useUndo()
async function undoTool(entry: TranscriptEntry) {
  if (!entry.undoToken) return
  try {
    // A refusal comes back as { ok: false, reason } with a 200 and useUndo() has already
    // toasted it. Only a genuine transport/server error lands here — without this catch it
    // became an unhandled rejection and the chip just did nothing, which is the silent no-op
    // this whole flow exists to remove. Same handling as galaxy.vue's onUndo.
    const { ok } = await redeem(entry.undoToken)
    if (ok) entry.undone = true
  } catch (e) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Undo failed', description: err?.data?.statusMessage ?? err?.message })
  }
}

async function toggleMic() {
  if (micOn.value) {
    await voice.disableMic()
    micOn.value = false
  } else {
    await voice.connect() // ensure the WS is up before requesting the mic
    await voice.enableMic()
    micOn.value = true
  }
}

// Transcript rebuild (chip placement, legacy fallback, trailing-bubble rule) lives in
// ~/lib/agent/transcript so it can be unit-tested — it used to be inline here, untested.
async function resume(id: string) {
  try {
    const { conversation, messages } = await useConversations().getConversation(id)
    voice.transcript.value = buildResumeTranscript(messages)
    await voice.loadConversation(id)
    activeConversationId.value = conversation.id
    activeTitle.value = conversation.title
  } catch (e) {
    // The rail is now the primary way into a thread, so a failed load must say so rather
    // than leaving the previous transcript on screen with a new row highlighted.
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Could not open conversation', description: err?.data?.statusMessage ?? err?.message })
  } finally {
    threadsOpen.value = false
  }
}

function startNewConversation() {
  voice.newConversation()
  activeConversationId.value = null
  activeTitle.value = null
  threadsOpen.value = false
}

// Auto-connect the WS on mount so the chat is usable immediately — typing and
// sending "just work" without an explicit Connect step. Resume a thread if ?c= is set.
onMounted(async () => {
  await voice.connect()
  await loadAiConfig()
  // Drop a stale override: if the cookie names a model no longer assigned to
  // reasoning, clear it so the dropdown doesn't show a blank label and no dead
  // id is sent. (Server reorderChain already no-ops an unknown id, so this is
  // cosmetic — but keeps the picker honest.)
  if (agentModel.value && !(aiDraft.value.assignments.reasoning ?? []).includes(agentModel.value)) {
    agentModel.value = ''
  }
  if (agentModel.value) voice.setModel(agentModel.value)
  const c = route.query.c
  if (typeof c === 'string' && c) await resume(c)
})
</script>

<template>
  <!-- Three columns: threads / conversation / Bridget. Resizable panels don't have a
       single root element — wrap them in a flex container.

       Sizing constraint: Nuxt UI's resize handle only ever sizes the panel to its LEFT,
       so `agent-threads` and `agent-conversation` carry the sizes and Bridget is the
       fluid remainder, clamped in CSS. Double-clicking a handle resets that split.

       Under lg both side columns collapse and the conversation takes the full width —
       that is the fix for the page having had no usable composer below 1024px. -->
  <div class="flex flex-1 min-w-0 h-full">
    <UDashboardPanel
      id="agent-threads"
      resizable
      :default-size="14"
      :min-size="10"
      :max-size="24"
      class="hidden lg:flex"
      :ui="{ body: '!p-0 !gap-0' }"
    >
      <template #body>
        <AgentThreadRail
          :active-id="activeConversationId"
          @select="resume"
          @new="startNewConversation"
        />
      </template>
    </UDashboardPanel>

    <UDashboardPanel
      id="agent-conversation"
      resizable
      :default-size="58"
      :min-size="35"
      :max-size="80"
      :ui="{ body: '!p-0 !gap-0' }"
    >
      <template #header>
        <AgentToolbar
          v-model:speak="speakReply"
          v-model:model="selectedModel"
          :title="activeTitle"
          :mic-on="micOn"
          @toggle-mic="toggleMic"
          @threads="threadsOpen = true"
          @full-bleed="fullBleed = true"
        >
          <template #actions>
            <VoiceSettingsSlideover :voice="voice" />
          </template>
        </AgentToolbar>
      </template>

      <template #body>
        <VoiceTranscript
          class="flex-1 min-h-0"
          :entries="voice.transcript.value"
          @undo="undoTool"
        />
        <div
          v-if="voice.pendingApproval.value"
          class="px-4 pb-2"
        >
          <AgentApprovalPrompt
            :approval="voice.pendingApproval.value"
            @approve="(d) => voice.sendApproval(voice.pendingApproval.value!.requestId, true, d)"
            @deny="() => voice.sendApproval(voice.pendingApproval.value!.requestId, false)"
          />
        </div>
        <VoiceComposer
          :entries="voice.transcript.value"
          :send-text="voice.sendText"
          :speak="speakReply"
          :initial-text="initialComposerText"
          :auto-send="!!initialComposerText"
        />
      </template>
    </UDashboardPanel>

    <!-- Bridget: the fluid remainder. Clamped in CSS because Nuxt UI cannot size a panel
         to the RIGHT of a handle. -->
    <UDashboardPanel
      id="agent-bridget"
      class="hidden lg:flex min-w-[240px] max-w-[420px]"
      :ui="{ body: '!p-0 !gap-0 overflow-hidden' }"
    >
      <template #body>
        <div class="relative flex flex-col flex-1 min-h-0 bg-elevated/20">
          <VoiceReactor
            :state="voice.state.value"
            :connected="voice.connected.value"
            :mic-analyser="voice.micAnalyser"
            :out-analyser="voice.outAnalyser"
            :on-viz-event="voice.onVizEvent"
          />
          <UAlert
            v-if="voice.error.value"
            color="error"
            class="absolute top-3 mx-3"
            :title="voice.error.value"
          />
        </div>
      </template>
    </UDashboardPanel>

    <!-- Threads under lg, where the rail column is hidden. -->
    <USlideover
      v-model:open="threadsOpen"
      side="left"
      title="Conversations"
      description="Pick a thread to resume it."
      :ui="{ body: '!p-0' }"
    >
      <template #body>
        <AgentThreadRail
          :active-id="activeConversationId"
          @select="resume"
          @new="startNewConversation"
        />
      </template>
    </USlideover>
  </div>
</template>
