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
  /** False for tools Tony must confirm every time (decide_review): no "always allow". */
  allowlistable?: boolean
  /** Per-tool card heading (cycle 79 review m1) — e.g. gmail_send's "Send this email?". Falls
   *  back to the generic "Run this?" when absent. */
  title?: string
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

const canRemember = computed(() => props.details?.allowlistable === true)

// exec commands are one-liners whose long unbroken tokens (paths, flags) are better clipped
// mid-token than left to overflow; every other tool's command (e.g. gmail_send's From/To/Cc/
// Subject + prose body) reads as text, where breaking mid-word is wrong (cycle 79 review m1).
const wrapClass = computed(() => (props.details?.tool ?? props.part.toolName) === 'exec' ? 'break-all' : 'break-words')

function approve() {
  emit('approve', props.part.approval.id, { remember: canRemember.value && remember.value, pattern: pattern.value })
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
          <span v-if="details">{{ details.title ?? 'Run this?' }}</span>
          <span v-else>Approve <code class="font-mono">{{ part.toolName }}</code>?</span>
        </ConfirmationTitle>
        <pre class="overflow-x-auto whitespace-pre-wrap rounded bg-elevated/60 p-2 text-xs font-mono" :class="wrapClass">{{ details ? details.command : inputJson }}</pre>
        <div v-if="details && canRemember" class="flex flex-wrap items-center gap-2" data-testid="approval-always-allow">
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
