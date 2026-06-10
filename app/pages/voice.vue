<script setup lang="ts">
definePageMeta({ title: 'Voice' })

const voice = useVoice()
const activity = useAgentActivity()

// Voice picker — fetched from same-origin proxy that aggregates both TTS providers.
const { data: voiceList } = await useFetch('/api/voice/voices', {
  default: () => ({ voices: [] as { provider: string, voice: string }[] })
})
const voiceItems = computed(() =>
  voiceList.value.voices.map(v => ({ label: `${v.provider} · ${v.voice}`, value: `${v.provider}|${v.voice}` }))
)
const selectedVoice = ref('chatterbox|Gianna.wav')
watch(selectedVoice, (val) => {
  const [p, vc] = val.split('|') as [string, string]
  voice.setVoice(p, vc)
})

// Caption over the canvas: the message currently being spoken/typed. On small
// screens (transcript hidden) this is the only live text.
const caption = computed(() => voice.transcript.value[voice.transcript.value.length - 1] ?? null)
</script>

<template>
  <!-- Resizable panels don't have a single root element — wrap in a flex container.
       Nuxt UI's resize handle only supports a sized panel LEFT of the handle, and the
       transcript belongs on the right — so the CANVAS is the sized/resizable panel
       (sizes are rem: the layout's UDashboardGroup sets unit="rem") and the transcript
       is fluid. Dragging the handle right grows the canvas / shrinks the transcript. -->
  <div class="flex flex-1 min-w-0 h-full">
    <UDashboardPanel
      id="voice"
      resizable
      :default-size="48"
      :min-size="30"
      :max-size="120"
      :ui="{ body: '!p-0 !gap-0 overflow-hidden' }"
    >
      <template #header>
        <UDashboardNavbar title="Voice">
          <template #leading>
            <UDashboardSidebarCollapse />
          </template>
          <template #right>
            <USelect
              v-model="selectedVoice"
              :items="voiceItems"
              value-key="value"
              icon="i-lucide-mic-vocal"
              class="w-56"
            />
            <UButton
              v-if="!voice.connected.value"
              icon="i-lucide-mic"
              label="Connect"
              @click="voice.start()"
            />
            <UButton
              v-else
              color="error"
              variant="soft"
              icon="i-lucide-phone-off"
              label="Disconnect"
              @click="voice.stop()"
            />
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
              {{ caption.role === 'user' ? 'You' : 'MyMind' }}
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

    <UDashboardPanel
      id="voice-transcript"
      class="hidden lg:flex"
      :ui="{ body: '!p-0 !gap-0' }"
    >
      <template #header>
        <UDashboardNavbar title="Transcript" />
      </template>

      <template #body>
        <VoiceTranscript
          class="flex-1 min-h-0"
          :entries="voice.transcript.value"
          :chips="activity.chips.value"
          @undo="activity.undo"
        />
        <VoiceComposer :entries="voice.transcript.value" />
      </template>
    </UDashboardPanel>
  </div>
</template>
