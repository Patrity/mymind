<script setup lang="ts">
definePageMeta({ title: 'Voice' })

const unmute = useUnmute()
const activity = useAgentActivity()

// Reactor reads whichever analyser is active for the current state.
const activeAnalyser = () =>
  unmute.state.value === 'speaking' ? unmute.outAnalyser() : unmute.micAnalyser()
</script>

<template>
  <UDashboardPanel id="voice">
    <template #header>
      <UDashboardNavbar title="Voice">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            v-if="!unmute.connected.value"
            icon="i-lucide-mic"
            label="Connect"
            @click="unmute.start()"
          />
          <UButton
            v-else
            color="error"
            variant="soft"
            icon="i-lucide-phone-off"
            label="Disconnect"
            @click="unmute.stop()"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="grid h-full grid-rows-[1fr_auto] gap-0 lg:grid-cols-[1.2fr_1fr] lg:grid-rows-1">
        <div class="relative flex items-center justify-center bg-elevated/20">
          <VoiceReactor
            :state="unmute.state.value"
            :analyser="activeAnalyser"
          />
          <span class="absolute bottom-4 text-xs uppercase tracking-widest text-muted">
            {{ unmute.state.value }}
          </span>
          <UAlert
            v-if="unmute.error.value"
            color="error"
            class="absolute top-4 mx-4"
            :title="unmute.error.value"
          />
        </div>

        <div class="flex min-h-0 flex-col border-l border-default">
          <VoiceTranscript
            class="flex-1 min-h-0"
            :entries="unmute.transcript.value"
            :chips="activity.chips.value"
            @undo="activity.undo"
          />
          <VoiceComposer :entries="unmute.transcript.value" />
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
