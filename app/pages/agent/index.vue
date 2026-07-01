<script setup lang="ts">
import type { TranscriptEntry } from '~/composables/useVoice'

definePageMeta({ title: 'Agent' })

const voice = useVoice()
const route = useRoute()

// Persistent preferences (cookie-backed so they survive page reloads)
const showCanvas = useCookie<boolean>('agent-canvas', { default: () => true })
const speakReply = useCookie<boolean>('agent-speak', { default: () => false })
// Exec master switch: cookie-backed so the choice persists across page reloads,
// but defaults false so unattended/cron runs carry no cookie → exec stays off.
const execEnabled = useCookie<boolean>('agent-exec-enabled', { default: () => false })

// Powerful-tools toggle: per-session (NOT cookie-persisted) so it defaults safe on every load
const powerful = ref(false)
watch(powerful, (v) => voice.setProfile(v ? 'powerful' : 'bridget'))
watch(execEnabled, (v) => voice.setExecEnabled(!!v))

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
async function undoTool(entry: TranscriptEntry) {
  if (!entry.undoToken) return
  const { ok } = await $fetch<{ ok: boolean }>('/api/agent/undo', { method: 'POST', body: { token: entry.undoToken } })
  if (ok) entry.undone = true
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

async function resume(id: string) {
  const { messages } = await useConversations().getConversation(id)
  // Rebuild inline tool chips from the persisted toolCalls. Exact stream position
  // isn't stored (one assistant row per turn), so chips render before the reply
  // they belong to — tools run before the final answer.
  voice.transcript.value = messages.flatMap<TranscriptEntry>(m => [
    ...(m.role === 'assistant' && m.toolCalls?.length
      ? m.toolCalls.map((t, i) => ({ id: `${m.id}-tool-${i}`, role: 'tool' as const, text: '', name: t.name, summary: t.summary, undoToken: t.undoToken }))
      : []),
    { id: m.id, role: m.role, text: m.content, attachments: m.attachments ?? undefined }
  ])
  await voice.loadConversation(id)
  historyOpen.value = false
}

// Auto-connect the WS on mount so the chat is usable immediately — typing and
// sending "just work" without an explicit Connect step. Resume a thread if ?c= is set.
onMounted(async () => {
  await voice.connect()
  voice.setProfile(powerful.value ? 'powerful' : 'bridget')
  voice.setExecEnabled(!!execEnabled.value)
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
            <!-- Powerful tools toggle (per-session, defaults safe) -->
            <USwitch
              v-model="powerful"
              label="Powerful tools"
              size="sm"
            />
            <!-- Exec master switch: arms exec tool for this session; cookie-persisted, default off -->
            <USwitch
              v-model="execEnabled"
              label="Exec enabled"
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
            />            <VoiceSettingsSlideover :voice="voice" />
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
            <!-- Powerful tools toggle (per-session, defaults safe) -->
            <USwitch
              v-model="powerful"
              label="Powerful tools"
              size="sm"
            />
            <!-- Exec master switch: arms exec tool for this session; cookie-persisted, default off -->
            <USwitch
              v-model="execEnabled"
              label="Exec enabled"
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
            />            <VoiceSettingsSlideover :voice="voice" />
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
