<script setup lang="ts">
definePageMeta({ title: 'Voice' })

const voice = useVoice()
const activity = useAgentActivity()

// Reactor reads whichever analyser is active for the current state.
const activeAnalyser = () =>
  voice.state.value === 'speaking' ? voice.outAnalyser() : voice.micAnalyser()

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
      <div class="grid h-full grid-rows-[1fr_auto] gap-0 lg:grid-cols-[1.2fr_1fr] lg:grid-rows-1">
        <div class="relative flex items-center justify-center bg-elevated/20">
          <VoiceReactor
            :state="voice.state.value"
            :analyser="activeAnalyser"
          />
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

        <div class="flex min-h-0 flex-col border-l border-default">
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
