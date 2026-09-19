<!-- app/components/agent/ApprovalConfirmation.vue -->
<!-- Elements Confirmation rendered ON the exec tool part awaiting approval — replaces the old
     detached ApprovalPrompt.vue banner. `details` (tool/command/proposedPattern) come from
     voice.pendingApproval, matched by the caller on part.approval.id; when absent this still
     works with just the input JSON and the tool name. -->
<script setup lang="ts">
import type { AgentUIPart } from '~~/shared/types/agent-ui'
import { Confirmation, ConfirmationAction, ConfirmationActions, ConfirmationRequest, ConfirmationTitle } from '@/components/ai-elements/confirmation'

export interface PendingApprovalDetails {
  requestId: string
  tool: string
  command: string
  proposedPattern: string
}

type ApprovalPart = Extract<AgentUIPart, { type: 'dynamic-tool'; state: 'approval-requested' }>

const props = defineProps<{
  part: ApprovalPart
  details: PendingApprovalDetails | null
}>()
const emit = defineEmits<{
  approve: [requestId: string, opts: { remember: boolean; pattern: string }]
  deny: [requestId: string]
}>()

const remember = ref(false)
const pattern = ref(props.details?.proposedPattern ?? '')
watch(
  () => props.details?.requestId,
  () => {
    remember.value = false
    pattern.value = props.details?.proposedPattern ?? ''
  }
)

const inputJson = computed(() => JSON.stringify(props.part.input, null, 2))

function approve() {
  emit('approve', props.part.approval.id, { remember: remember.value, pattern: pattern.value })
}
function deny() {
  emit('deny', props.part.approval.id)
}
</script>

<template>
  <Confirmation
    class="rounded-none border-x-0 border-t-0 border-b border-warning/40 bg-warning/5"
    :approval="part.approval"
    :state="part.state"
  >
    <!-- ConfirmationRequest's root is a bare `<template v-if>` (a fragment, per the vendored
         source) — it can't take a `class` itself, so the layout classes live on this inner
         div instead. -->
    <ConfirmationRequest>
      <div class="flex flex-col gap-3">
        <ConfirmationTitle>
          <span v-if="details">Run this?</span>
          <span v-else>Approve <code class="font-mono">{{ part.toolName }}</code>?</span>
        </ConfirmationTitle>
        <pre class="overflow-x-auto whitespace-pre-wrap break-all rounded bg-elevated/60 p-2 text-xs font-mono">{{ details ? details.command : inputJson }}</pre>
        <div v-if="details" class="flex flex-wrap items-center gap-2">
          <UCheckbox v-model="remember" />
          <span class="text-sm text-muted">Always allow commands matching</span>
          <UInput v-model="pattern" :disabled="!remember" size="xs" class="max-w-xs flex-1 font-mono" />
        </div>
        <ConfirmationActions>
          <ConfirmationAction variant="outline" @click="deny">
            Deny
          </ConfirmationAction>
          <ConfirmationAction @click="approve">
            Approve
          </ConfirmationAction>
        </ConfirmationActions>
      </div>
    </ConfirmationRequest>
  </Confirmation>
</template>
