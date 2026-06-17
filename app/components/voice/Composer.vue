<!-- app/components/voice/Composer.vue -->
<script setup lang="ts">
import type { TranscriptEntry } from '~/composables/useVoice'

const props = defineProps<{
  entries: TranscriptEntry[]
  // Voice-loop injection: typed turns go over the voice WS only.
  // The composer is disabled (and shows a placeholder) when not connected.
  connected?: boolean
  sendText?: (t: string, speak?: boolean) => boolean
  /** When true, typed sends request a spoken reply from the agent. */
  speak?: boolean
}>()
const text = ref('')

function send() {
  const q = text.value.trim()
  if (!q || !props.connected) return
  text.value = ''
  // WS path only: the server echoes the user transcript and streams the reply
  // (text + audio + states) over the WS — nothing to await or append here.
  props.sendText?.(q, props.speak ?? false)
}
</script>

<template>
  <form
    class="flex items-center gap-2 border-t border-default p-3"
    @submit.prevent="send"
  >
    <UInput
      v-model="text"
      :placeholder="connected ? 'Type a message…' : 'Connect to start chatting'"
      class="flex-1"
      :disabled="!connected"
    />
    <UButton
      type="submit"
      icon="i-lucide-send"
      :disabled="!connected || !text.trim()"
    />
  </form>
</template>
