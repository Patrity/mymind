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

// Persistent preferences (cookie-backed so they survive page reloads)
const showCanvas = useCookie<boolean>('agent-canvas', { default: () => true })
const speakReply = useCookie<boolean>('agent-speak', { default: () => false })

// Reasoning-model override (ephemeral, cookie-backed). Empty cookie = default chain order.
// reka-ui's USelectMenu rejects an empty-string item value, so the "Default" option uses a
// non-empty sentinel that maps back to "no override" (empty cookie / null to setModel).
const DEFAULT_MODEL = '__default__'
const { load: loadAiConfig, draft: aiDraft } = useAiConfig()
const agentModel = useCookie<string>('agent-model', { default: () => '' })
const modelItems = computed(() => {
  const models = aiDraft.value.models
  const chain = (aiDraft.value.assignments.reasoning ?? [])
    .map(id => models.find(m => m.id === id))
    .filter((m): m is NonNullable<typeof m> => !!m)
  return [{ label: 'Default (chain order)', value: DEFAULT_MODEL }, ...chain.map(m => ({ label: m.label, value: m.id }))]
})
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

// History slideover open state
const historyOpen = ref(false)

// Caption over the canvas: the message currently being spoken/typed. On small
// screens (transcript hidden) this is the only live text. Tool chips are not
// captions — show the latest user/assistant text instead.
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
  const { messages } = await useConversations().getConversation(id)
  voice.transcript.value = buildResumeTranscript(messages)
  await voice.loadConversation(id)
  historyOpen.value = false
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
  <!-- Resizable panels don't have a single root element — wrap in a flex container.
       When showCanvas is false the canvas panel is hidden and the transcript takes full
       width. The canvas is the sized/resizable panel (left), the transcript is fluid
       (right). Double-clicking the resize handle resets the split. -->
  <div class="flex flex-1 min-w-0 h-full">
    <UDashboardPanel
      v-if="showCanvas"
      id="agent-canvas"
      resizable
      :default-size="75"
      :min-size="50"
      :max-size="90"
      :ui="{ body: '!p-0 !gap-0 overflow-hidden' }"
    >
      <template #header>
        <UDashboardNavbar title="Agent">
          <template #leading>
            <UDashboardSidebarCollapse />
          </template>
          <template #right>
            <!-- Visualizer toggle -->
            <USwitch
              v-model="showCanvas"
              label="Visualizer"
              size="sm"
            />
            <!-- Respond-in-voice toggle -->
            <USwitch
              v-model="speakReply"
              label="Voice replies"
              size="sm"
            />
            <!-- History button -->
            <UButton
              icon="i-lucide-history"
              label="History"
              variant="ghost"
              color="neutral"
              @click="historyOpen = true"
            />
            <!-- New conversation -->
            <UButton
              icon="i-lucide-plus"
              label="New"
              variant="ghost"
              color="neutral"
              @click="voice.newConversation()"
            />
            <!-- Mic toggle (auto-connects if needed) -->
            <UButton
              :icon="micOn ? 'i-lucide-mic' : 'i-lucide-mic-off'"
              :color="micOn ? 'primary' : 'neutral'"
              :variant="micOn ? 'soft' : 'ghost'"
              :aria-label="micOn ? 'Disable microphone' : 'Enable microphone'"
              @click="toggleMic"
            />
            <!-- Reasoning-model override (ephemeral, cookie-persisted) -->
            <USelectMenu
              v-model="selectedModel"
              :items="modelItems"
              value-key="value"
              icon="i-lucide-cpu"
              size="sm"
              class="w-44"
              aria-label="Agent model"
            />
            <VoiceSettingsSlideover :voice="voice" />
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <div class="relative flex-1 min-h-0 bg-elevated/20">
          <VoiceReactor
            :state="voice.state.value"
            :connected="voice.connected.value"
            :mic-analyser="voice.micAnalyser"
            :out-analyser="voice.outAnalyser"
            :on-viz-event="voice.onVizEvent"
          />
          <div
            v-if="caption"
            class="absolute inset-x-4 bottom-12 z-10 mx-auto w-fit max-w-2xl rounded-lg bg-elevated/50 px-4 py-2.5 shadow-lg"
          >
            <span class="text-xs font-semibold uppercase tracking-wider text-muted">
              {{ caption.role === 'user' ? 'You' : 'Bridget' }}
            </span>
            <p class="mt-0.5 line-clamp-3 text-sm text-highlighted">{{ caption.text }}</p>
          </div>
          <span class="absolute bottom-4 inset-x-0 text-center text-xs uppercase tracking-widest text-muted">
            {{ voice.state.value }}
          </span>
          <UAlert
            v-if="voice.error.value"
            color="error"
            class="absolute top-4 mx-4"
            :title="voice.error.value"
          />
        </div>
      </template>
    </UDashboardPanel>

    <!-- Transcript panel — always visible; takes full width when canvas is hidden -->
    <UDashboardPanel
      id="agent-transcript"
      class="hidden lg:flex"
      :ui="{ body: '!p-0 !gap-0' }"
    >
      <template #header>
        <UDashboardNavbar :title="showCanvas ? 'Transcript' : 'Agent'">
          <!-- Show the control bar in the transcript header when canvas is hidden -->
          <template
            v-if="!showCanvas"
            #leading
          >
            <UDashboardSidebarCollapse />
          </template>
          <template
            v-if="!showCanvas"
            #right
          >
            <!-- Visualizer toggle (restore canvas) -->
            <USwitch
              v-model="showCanvas"
              label="Visualizer"
              size="sm"
            />
            <!-- Respond-in-voice toggle -->
            <USwitch
              v-model="speakReply"
              label="Voice replies"
              size="sm"
            />
            <!-- History button -->
            <UButton
              icon="i-lucide-history"
              label="History"
              variant="ghost"
              color="neutral"
              @click="historyOpen = true"
            />
            <!-- New conversation -->
            <UButton
              icon="i-lucide-plus"
              label="New"
              variant="ghost"
              color="neutral"
              @click="voice.newConversation()"
            />
            <!-- Mic toggle (auto-connects if needed) -->
            <UButton
              :icon="micOn ? 'i-lucide-mic' : 'i-lucide-mic-off'"
              :color="micOn ? 'primary' : 'neutral'"
              :variant="micOn ? 'soft' : 'ghost'"
              :aria-label="micOn ? 'Disable microphone' : 'Enable microphone'"
              @click="toggleMic"
            />
            <!-- Reasoning-model override (ephemeral, cookie-persisted) -->
            <USelectMenu
              v-model="selectedModel"
              :items="modelItems"
              value-key="value"
              icon="i-lucide-cpu"
              size="sm"
              class="w-44"
              aria-label="Agent model"
            />
            <VoiceSettingsSlideover :voice="voice" />
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <VoiceTranscript
          class="flex-1 min-h-0"
          :entries="voice.transcript.value"
          @undo="undoTool"
        />
        <div v-if="voice.pendingApproval.value" class="px-4 pb-2">
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

    <!-- History slideover -->
    <AgentHistorySlideover
      v-model:open="historyOpen"
      @select="resume"
    />
  </div>
</template>
