<!-- app/components/agent/ReplyActions.vue -->
<script setup lang="ts">
import type { AgentUIMessage } from '~~/shared/types/agent-ui'
import { uiMessageText, tokenLabel } from '~/lib/agent/render'
import { rateLabel, durationLabel } from '~/lib/agent/metrics'

const props = defineProps<{
  message: AgentUIMessage
  /** 1-based position among siblings and the sibling count; total 1 renders no pager
   *  (AgentBranchPager itself is a v-if on total > 1). */
  branch: { index: number, total: number }
}>()
// edit/fork/branch carry no payload here — this component's own parent (Conversation.vue)
// already knows which message this is from its v-for scope. Conversation.vue re-emits these
// upward WITH the message id attached, matching how `retry` already crosses that boundary.
const emit = defineEmits<{ retry: [], edit: [], fork: [], branch: [dir: -1 | 1] }>()

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
const duration = computed(() => durationLabel(props.message.metadata?.usage))
const rate = computed(() => rateLabel(props.message.metadata?.usage))

// Token count + model id move out of the always-visible row into a hover-only detail, so the
// row itself stays scannable.
const tooltip = computed(() => {
  const tokens = tokenLabel(props.message.metadata?.usage)
  const model = props.message.metadata?.usage?.modelDefId
  const bits = [tokens, model].filter(Boolean)
  return bits.length ? bits.join(' · ') : undefined
})
</script>

<template>
  <!-- Was opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity: the row
       was hover-only, which made copy and regenerate undiscoverable and completely unreachable
       on a touch device, where there is no hover at all (cycle 68 discoverability fix). -->
  <div
    class="flex flex-wrap items-center gap-2 pt-0.5 text-dimmed"
    :title="tooltip"
  >
    <UButton :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'" size="xs" variant="ghost" color="neutral" :aria-label="copied ? 'Copied' : 'Copy message'" @click="copy" />
    <UButton v-if="message.role === 'assistant'" icon="i-lucide-refresh-cw" size="xs" variant="ghost" color="neutral" aria-label="Regenerate (keeps the previous reply)" @click="emit('retry')" />
    <UButton v-if="message.role === 'user'" icon="i-lucide-pencil" size="xs" variant="ghost" color="neutral" aria-label="Edit and resend" @click="emit('edit')" />
    <UButton icon="i-lucide-git-branch" size="xs" variant="ghost" color="neutral" aria-label="Fork from here" @click="emit('fork')" />
    <AgentBranchPager :index="branch.index" :total="branch.total" @go="(d: -1 | 1) => emit('branch', d)" />
    <span v-if="time" class="text-[10px] text-dimmed tabular-nums">{{ time }}</span>
    <span v-if="duration" class="text-[10px] tabular-nums">{{ duration }}</span>
    <span v-if="rate" class="text-[10px] tabular-nums">{{ rate }}</span>
  </div>
</template>
