<!-- app/components/agent/MessageActions.vue -->
<script setup lang="ts">
import type { TranscriptEntry } from '~/composables/useVoice'

const props = defineProps<{ entry: TranscriptEntry }>()
const emit = defineEmits<{ retry: [] }>()

const toast = useToast()
const copied = ref(false)

async function copy() {
  try {
    await navigator.clipboard.writeText(props.entry.text)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch {
    toast.add({ color: 'error', title: 'Copy failed', description: 'The browser blocked clipboard access.' })
  }
}

const time = computed(() =>
  props.entry.createdAt ? new Date(props.entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')

// Absent usage renders nothing rather than a misleading zero — messages written
// before the usage column exists (or a turn the server never reported usage for)
// simply have no count.
const tokens = computed(() => {
  const t = props.entry.usage?.totalTokens
  return typeof t === 'number' && t > 0 ? (t >= 1000 ? `${(t / 1000).toFixed(1)}k tok` : `${t} tok`) : ''
})
</script>

<template>
  <div class="flex items-center gap-2 pt-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
    <UButton
      :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
      size="xs"
      variant="ghost"
      color="neutral"
      :aria-label="copied ? 'Copied' : 'Copy message'"
      @click="copy"
    />
    <UButton
      v-if="entry.role === 'assistant'"
      icon="i-lucide-refresh-cw"
      size="xs"
      variant="ghost"
      color="neutral"
      aria-label="Retry this reply"
      @click="emit('retry')"
    />
    <span v-if="time" class="text-[10px] text-dimmed tabular-nums">{{ time }}</span>
    <span v-if="tokens" class="text-[10px] text-dimmed tabular-nums">{{ tokens }}</span>
  </div>
</template>
