<script setup lang="ts">
definePageMeta({ title: 'Agent' })

const voice = useVoice()
const activity = useAgentActivity()
const route = useRoute()

// Persistent preferences (cookie-backed so they survive page reloads)
const showCanvas = useCookie<boolean>('agent-canvas', { default: () => true })
const speakReply = useCookie<boolean>('agent-speak', { default: () => false })

// Mic-on state is local — it reflects whether the VAD is actually running
const micOn = ref(false)

// History slideover open state
const historyOpen = ref(false)

// Caption over the canvas: the message currently being spoken/typed. On small
// screens (transcript hidden) this is the only live text.
const caption = computed(() => voice.transcript.value[voice.transcript.value.length - 1] ?? null)

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
  voice.transcript.value = messages.map(m => ({ role: m.role, text: m.content }))
  await voice.loadConversation(id)
  historyOpen.value = false
}

// Auto-connect the WS on mount so the chat is usable immediately — typing and
// sending "just work" without an explicit Connect step. Resume a thread if ?c= is set.
onMounted(async () => {
  await voice.connect()
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
          :chips="activity.chips.value"
          @undo="activity.undo"
        />
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
