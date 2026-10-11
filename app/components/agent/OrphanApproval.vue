<script setup lang="ts">
// A pending approval with no tool part on screen to sit on (cycle 81 Task 6): a workstream's card
// mirrored into the chat it was started from (spec §5.4: the card shows in the workstream view AND
// that chat), or a card re-sent on attach for a run this transcript does not show. Rendered with
// the same ApprovalConfirmation, on a stand-in part built from the request's own details — so it
// can always be approved (details present) and says exactly what would run.
//
// It waits a moment before showing: in an ordinary turn the `approval` frame can land just before
// the tool part that carries it, and a card that flashes up twice reads as two requests.
import type { AgentUIPart } from '@mymind/core/shared/types/agent-ui'
import type { PendingApprovalDetails } from '~/lib/agent/approvals'

const props = defineProps<{ details: PendingApprovalDetails }>()
const emit = defineEmits<{
  approve: [requestId: string, opts: { remember: boolean; pattern: string }]
  deny: [requestId: string]
}>()

const shown = ref(false)
onMounted(() => {
  const t = setTimeout(() => { shown.value = true }, ORPHAN_APPROVAL_DELAY_MS)
  onBeforeUnmount(() => clearTimeout(t))
})

const part = computed(() => ({
  type: 'dynamic-tool',
  toolName: props.details.tool,
  toolCallId: props.details.requestId,
  input: {},
  state: 'approval-requested',
  approval: { id: props.details.requestId }
}) as Extract<AgentUIPart, { type: 'dynamic-tool'; state: 'approval-requested' }>)
</script>

<script lang="ts">
export const ORPHAN_APPROVAL_DELAY_MS = 1500
</script>

<template>
  <UCard
    v-if="shown"
    variant="outline"
    class="shrink-0 overflow-hidden"
    :ui="{ header: 'px-4 py-2 sm:px-4', body: 'p-0 sm:p-0' }"
    data-testid="orphan-approval"
  >
    <template #header>
      <div class="flex items-center gap-2 text-sm text-muted">
        <UIcon
          name="i-lucide-shield-question"
          class="size-4 text-warning"
        />
        Waiting for your approval — <code class="font-mono">{{ details.tool }}</code>
      </div>
    </template>
    <AgentApprovalConfirmation
      :part="part"
      :details="details"
      @approve="(id: string, o) => emit('approve', id, o)"
      @deny="(id: string) => emit('deny', id)"
    />
  </UCard>
</template>
