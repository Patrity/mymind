<!-- app/components/agent/ReplyActions.vue -->
<script setup lang="ts">
import type { AgentUIMessage } from '~~/shared/types/agent-ui'
import { uiMessageText, tokenLabel } from '~/lib/agent/render'

const props = defineProps<{ message: AgentUIMessage }>()
const emit = defineEmits<{ retry: [] }>()

const toast = useToast()
const copied = ref(false)

async function copy() {
  try {
    await navigator.clipboard.writeText(uiMessageText(props.message))
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch {
    toast.add({ color: 'error', title: 'Copy failed', description: 'The browser blocked clipboard access.' })
  }
}

const time = computed(() => {
  const at = props.message.metadata?.createdAt
  return at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
})
const tokens = computed(() => tokenLabel(props.message.metadata?.usage))
</script>

<template>
  <div class="flex items-center gap-2 pt-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
    <UButton :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'" size="xs" variant="ghost" color="neutral" :aria-label="copied ? 'Copied' : 'Copy message'" @click="copy" />
    <UButton v-if="message.role === 'assistant'" icon="i-lucide-refresh-cw" size="xs" variant="ghost" color="neutral" aria-label="Retry this reply" @click="emit('retry')" />
    <span v-if="time" class="text-[10px] text-dimmed tabular-nums">{{ time }}</span>
    <span v-if="tokens" class="text-[10px] text-dimmed tabular-nums">{{ tokens }}</span>
  </div>
</template>
