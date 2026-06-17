<!-- app/components/voice/Composer.vue -->
<script setup lang="ts">
import { textStreamToTranscript } from '~/composables/useTextChat'
import type { TranscriptEntry } from '~/composables/useVoice'

const props = defineProps<{
  entries: TranscriptEntry[]
  // Voice-loop injection: when connected, typed turns go over the voice WS
  // (post-STT) so the agent animates and replies aloud.
  connected?: boolean
  sendText?: (t: string, speak?: boolean) => boolean
  /** When true, typed sends request a spoken reply from the agent. */
  speak?: boolean
}>()
const text = ref('')
const busy = ref(false)

async function send() {
  const q = text.value.trim()
  if (!q || busy.value) return
  text.value = ''
  // Voice path: the server echoes the user transcript and streams the reply
  // (text + audio + states) over the WS — nothing to await or append here.
  if (props.connected && props.sendText?.(q, props.speak ?? false)) return
  busy.value = true
  // Use a local alias so vue/no-mutating-props is not triggered; the parent
  // intentionally passes a reactive array by reference for streaming appends.
  const log = props.entries
  log.push({ role: 'user', text: q })
  try {
    await textStreamToTranscript(log)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form
    class="flex items-center gap-2 border-t border-default p-3"
    @submit.prevent="send"
  >
    <UInput
      v-model="text"
      placeholder="Type a message…"
      class="flex-1"
      :disabled="busy"
    />
    <UButton
      type="submit"
      icon="i-lucide-send"
      :loading="busy"
      :disabled="!text.trim()"
    />
  </form>
</template>
