<!-- app/components/voice/Composer.vue -->
<script setup lang="ts">
import { textStreamToTranscript } from '~/composables/useTextChat'
import type { TranscriptEntry } from '~/composables/useVoice'

const props = defineProps<{ entries: TranscriptEntry[] }>()
const text = ref('')
const busy = ref(false)

async function send() {
  const q = text.value.trim()
  if (!q || busy.value) return
  text.value = ''
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
