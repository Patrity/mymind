<!-- app/components/voice/SettingsSlideover.vue -->
<script setup lang="ts">
const props = defineProps<{ voice: ReturnType<typeof useVoice> }>()

const { settings } = useVoiceSettings()

// Voice picker — same-origin proxy aggregating both TTS providers.
const { data: voiceList } = await useFetch('/api/voice/voices', {
  default: () => ({ voices: [] as { provider: string, voice: string }[] })
})
const voiceItems = computed(() =>
  voiceList.value.voices.map(v => ({ label: `${v.provider} · ${v.voice}`, value: `${v.provider}|${v.voice}` }))
)
const selectedVoice = computed({
  get: () => `${settings.value.provider}|${settings.value.voice}`,
  set: (val: string) => {
    const [p, v] = val.split('|') as [string, string]
    props.voice.setVoice(p, v) // sends over WS if connected + persists to the cookie
  },
})

// Live tuning meter: Silero speech probability — the same unit as the threshold
// slider, so "where does my room noise sit vs. the line" is directly visible.
const prob = computed(() => props.voice.speechProb.value)
const probAbove = computed(() => prob.value >= settings.value.positiveSpeechThreshold)

// vad-web bakes thresholds in at construction — debounce a VAD-only restart
// while the user drags. Toggle/playback settings apply live without this.
const applying = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
watch(
  () => [settings.value.positiveSpeechThreshold, settings.value.minSpeechMs, settings.value.redemptionMs],
  () => {
    clearTimeout(timer)
    timer = setTimeout(async () => {
      applying.value = true
      try { await props.voice.applyVadSettings() } finally { applying.value = false }
    }, 600)
  }
)
onUnmounted(() => clearTimeout(timer))
</script>

<template>
  <USlideover
    title="Voice settings"
    description="Capture, barge-in, and playback tuning — saved in this browser."
  >
    <UButton
      icon="i-lucide-settings"
      variant="ghost"
      color="neutral"
      aria-label="Voice settings"
    />

    <template #body>
      <div class="flex flex-col gap-6">
        <UFormField
          label="Voice"
          help="Applies immediately and persists."
        >
          <USelectMenu
            v-model="selectedVoice"
            :items="voiceItems"
            value-key="value"
            icon="i-lucide-mic-vocal"
            class="w-full"
          />
        </UFormField>

        <UFormField
          label="Speech sensitivity"
          :help="voice.connected.value
            ? 'The bar is your live mic: speak and watch where it lands. Frames past the marker count as speech — lower the threshold in quiet rooms, raise it in noisy ones.'
            : 'Connect to see your live mic level while tuning.'"
        >
          <div class="flex flex-col gap-2">
            <div class="relative h-2 w-full overflow-hidden rounded-full bg-accented">
              <div
                class="absolute inset-y-0 left-0 rounded-full transition-[width] duration-100"
                :class="probAbove ? 'bg-primary' : 'bg-primary/35'"
                :style="{ width: `${Math.round(prob * 100)}%` }"
              />
              <div
                class="absolute inset-y-0 w-0.5 bg-highlighted"
                :style="{ left: `${settings.positiveSpeechThreshold * 100}%` }"
              />
            </div>
            <USlider
              v-model="settings.positiveSpeechThreshold"
              :min="0.1"
              :max="0.9"
              :step="0.05"
            />
            <div class="flex justify-between text-xs text-muted">
              <span>sensitive</span>
              <span class="tabular-nums">threshold {{ settings.positiveSpeechThreshold.toFixed(2) }} · mic {{ prob.toFixed(2) }}</span>
              <span>strict</span>
            </div>
          </div>
        </UFormField>

        <UFormField
          label="Barge-in"
          help="Interrupt the assistant by speaking over it."
        >
          <USwitch
            v-model="settings.bargeInEnabled"
            :label="settings.bargeInEnabled ? 'Enabled' : 'Disabled'"
          />
        </UFormField>

        <UFormField
          label="Minimum speech"
          :help="`${settings.minSpeechMs} ms — shorter sounds are ignored (coughs, clicks).`"
        >
          <USlider
            v-model="settings.minSpeechMs"
            :min="60"
            :max="600"
            :step="20"
          />
        </UFormField>

        <UFormField
          label="End-of-turn silence"
          :help="`${settings.redemptionMs} ms of quiet before your turn is sent. Raise it if it cuts you off mid-sentence.`"
        >
          <USlider
            v-model="settings.redemptionMs"
            :min="120"
            :max="1200"
            :step="40"
          />
        </UFormField>

        <UFormField
          label="Playback speed"
          :help="`${settings.playbackRate.toFixed(2)}× — applies to the next reply.`"
        >
          <USlider
            v-model="settings.playbackRate"
            :min="0.8"
            :max="1.5"
            :step="0.05"
          />
        </UFormField>

        <p
          v-if="applying"
          class="text-xs text-muted"
        >
          <UIcon
            name="i-lucide-loader-2"
            class="inline size-3 animate-spin"
          /> Applying mic settings…
        </p>
      </div>
    </template>
  </USlideover>
</template>
