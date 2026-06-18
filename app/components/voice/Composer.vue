<!-- app/components/voice/Composer.vue -->
<script setup lang="ts">
import type { TranscriptEntry } from '~/composables/useVoice'

const props = defineProps<{
  entries: TranscriptEntry[]
  // Typed turns go over the voice WS only. sendText auto-connects the WS
  // transparently, so the composer is always usable — no explicit Connect step.
  sendText?: (t: string, speak?: boolean) => boolean | Promise<boolean>
  /** When true, typed sends request a spoken reply from the agent. */
  speak?: boolean
}>()
const text = ref('')

function send() {
  const q = text.value.trim()
  if (!q) return
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
      placeholder="Type a message…"
      class="flex-1"
    />
    <UButton
      type="submit"
      icon="i-lucide-send"
      :disabled="!text.trim()"
    />
  </form>
</template>
