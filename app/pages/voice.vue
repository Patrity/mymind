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
const selectedVoice = ref('kokoro|af_heart')
watch(selectedVoice, (val) => {
  const [p, vc] = val.split('|') as [string, string]
  voice.setVoice(p, vc)
})

// Caption over the canvas: the message currently being spoken/typed. On small
// screens (transcript hidden) this is the only live text.
const caption = computed(() => voice.transcript.value[voice.transcript.value.length - 1] ?? null)
</script>

<template>
  <UDashboardPanel id="voice">
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
      <div class="grid h-full grid-cols-1 gap-0 lg:grid-cols-[2fr_1fr]">
        <div class="relative flex items-center justify-center bg-elevated/20">
          <VoiceReactor
            :state="voice.state.value"
            :connected="voice.connected.value"
            :mic-analyser="voice.micAnalyser"
            :out-analyser="voice.outAnalyser"
            :on-viz-event="voice.onVizEvent"
          />
          <div
            v-if="caption"
            class="absolute inset-x-4 bottom-12 z-10 mx-auto w-fit max-w-2xl rounded-lg bg-elevated px-4 py-2.5 shadow-lg"
          >
            <span class="text-xs font-semibold uppercase tracking-wider text-muted">
              {{ caption.role === 'user' ? 'You' : 'MyMind' }}
            </span>
            <p class="mt-0.5 line-clamp-3 text-sm text-highlighted">{{ caption.text }}</p>
          </div>
          <span class="absolute bottom-4 text-xs uppercase tracking-widest text-muted">
            {{ voice.state.value }}
          </span>
          <UAlert
            v-if="voice.error.value"
            color="error"
            class="absolute top-4 mx-4"
            :title="voice.error.value"
          />
        </div>

        <div class="hidden min-h-0 flex-col border-l border-default lg:flex">
          <VoiceTranscript
            class="flex-1 min-h-0"
            :entries="voice.transcript.value"
            :chips="activity.chips.value"
            @undo="activity.undo"
          />
          <VoiceComposer :entries="voice.transcript.value" />
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
