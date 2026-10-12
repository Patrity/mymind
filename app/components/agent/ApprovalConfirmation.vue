<!-- app/components/agent/ApprovalConfirmation.vue -->
<!-- Elements Confirmation rendered ON the exec tool part awaiting approval — replaces the old
     detached ApprovalPrompt.vue banner. `details` (tool/command/proposedPattern) come from
     voice.pendingApprovals (one entry PER request, cycle 79 fix wave I1), looked up by the caller
     on part.approval.id. When absent, an exec card still works from its input JSON (exec's args
     are the command); any other tool's card offers Deny only — its args don't show what would
     actually be sent. -->
<script setup lang="ts">
import type { AgentUIPart } from '@mymind/core/shared/types/agent-ui'
import { canApprove, type PendingApprovalDetails } from '~/lib/agent/approvals'
import { autoApprovedLabel } from '~/lib/agent/judge-display'
import { Confirmation, ConfirmationAction, ConfirmationActions, ConfirmationRequest, ConfirmationTitle } from '@/components/ai-elements/confirmation'


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

const approvable = computed(() => canApprove(props.part.toolName, props.details))

const canRemember = computed(() => props.details?.allowlistable === true && !props.details.auto)

// Cycle 84: the judge approved this call — the card stays until its result lands, with no buttons.
const autoLabel = computed(() => (props.details?.auto ? autoApprovedLabel(props.details.auto) : null))

// exec commands are one-liners whose long unbroken tokens (paths, flags) are better clipped
// mid-token than left to overflow; every other tool's command (e.g. gmail_send's From/To/Cc/
// Subject + prose body) reads as text, where breaking mid-word is wrong (cycle 79 review m1).
const wrapClass = computed(() => (props.details?.tool ?? props.part.toolName) === 'exec' ? 'break-all' : 'break-words')

function approve() {
  if (!approvable.value) return
  emit('approve', props.part.approval.id, { remember: canRemember.value && remember.value, pattern: pattern.value })
}
function deny() {
  if (autoLabel.value) return
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
          <span
            v-if="autoLabel"
            class="text-success"
            data-testid="approval-auto"
          >{{ autoLabel }}</span>
          <span v-else-if="details">{{ details.title ?? 'Run this?' }}</span>
          <span v-else-if="approvable">Approve <code class="font-mono">{{ part.toolName }}</code>?</span>
          <span v-else data-testid="approval-details-unavailable">Details unavailable — deny <code class="font-mono">{{ part.toolName }}</code></span>
        </ConfirmationTitle>
        <!-- Never truncated (review I2): the card shows the WHOLE email body / description / note
             that will be sent, scrolling instead of cutting it off. -->
        <pre class="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-elevated/60 p-2 text-xs font-mono" :class="wrapClass" data-testid="approval-command">{{ details ? details.command : inputJson }}</pre>
        <AgentJudgeVerdict
          v-if="details?.judge && !autoLabel"
          :judge="details.judge"
        />
        <div v-if="details && canRemember" class="flex flex-wrap items-center gap-2" data-testid="approval-always-allow">
          <UCheckbox v-model="remember" />
          <span class="text-sm text-muted">Always allow commands matching</span>
          <UInput v-model="pattern" :disabled="!remember" size="xs" class="max-w-xs flex-1 font-mono" />
        </div>
        <ConfirmationActions v-if="!autoLabel">
          <ConfirmationAction variant="outline" @click="deny">
            Deny
          </ConfirmationAction>
          <ConfirmationAction v-if="approvable" @click="approve">
            Approve
          </ConfirmationAction>
        </ConfirmationActions>
      </div>
    </ConfirmationRequest>
  </Confirmation>
</template>
