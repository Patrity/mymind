<script setup lang="ts">
import type { AgentUIPart, SubagentStep, ToolEnvelope } from '@mymind/core/shared/types/agent-ui'
import { approvalFor, headerState, type PendingApprovals } from '~/lib/agent/approvals'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import { toolTitle, isRunning } from '~/lib/agent/render'
import { startedWorkstream } from '~/lib/workstreams/display'
import { publishedArtifact } from '~/lib/artifacts/display'
import { autoApprovalNote } from '~/lib/agent/judge-display'
import type { OutputWarningDTO } from '@mymind/core/lib/agent/judge/types'

const props = defineProps<{
  part: Extract<AgentUIPart, { type: 'dynamic-tool' }>
  steps: SubagentStep[] | null
  undone?: boolean
  /** Every pending approval's details, by requestId — this part renders only its OWN entry. */
  approvals?: PendingApprovals | null
  /** Cycle 84: the output guard flagged this call's result (its `data-output_warning` part). */
  warning?: OutputWarningDTO | null
}>()
const emit = defineEmits<{
  undo: [undoToken: string]
  approve: [requestId: string, opts: { remember: boolean; pattern: string }]
  deny: [requestId: string]
}>()

const envelope = computed(() => (props.part.state === 'output-available' ? props.part.output as ToolEnvelope : null))
const running = computed(() => isRunning(props.part))
const pendingPart = computed(() => (props.part.state === 'approval-requested' ? props.part : null))
// A workstream this call started gets its compact card + link (cycle 81 spec §5.5).
const started = computed(() => (envelope.value ? startedWorkstream(props.part.toolName, props.part.input, envelope.value.value) : null))
// Cycle 86: a published/edited artifact gets an inline sandboxed preview card.
const artifact = computed(() => (envelope.value ? publishedArtifact(props.part.toolName, envelope.value.value) : null))
// Cycle 84: "⚖ auto-approved (0.94): <reason>" — the judge ran this call without Tony.
const autoNote = computed(() => autoApprovalNote(envelope.value?.approval))
const approvalDetails = computed(() => (
  pendingPart.value ? approvalFor(props.approvals, pendingPart.value.approval.id) : null
))
</script>

<template>
  <Tool :default-open="false">
    <ToolHeader
      type="dynamic-tool"
      :tool-name="part.toolName"
      :state="headerState(part.state, approvalDetails)"
      :title="envelope?.summary ?? toolTitle(part.toolName)"
    />
    <AgentApprovalConfirmation
      v-if="pendingPart"
      :part="pendingPart"
      :details="approvalDetails"
      @approve="(id: string, opts) => emit('approve', id, opts)"
      @deny="(id: string) => emit('deny', id)"
    />
    <ToolContent>
      <ToolInput :input="part.input" />
      <ToolOutput
        :output="envelope?.value"
        :error-text="part.state === 'output-error' ? part.errorText : part.state === 'output-denied' ? 'Denied' : undefined"
      />
    </ToolContent>
  </Tool>
  <p
    v-if="autoNote"
    class="-mt-2 mb-3 text-xs text-success break-words"
    data-testid="judge-auto-note"
  >
    {{ autoNote }}
  </p>
  <AgentOutputWarningChip
    v-if="warning"
    :warning="warning"
  />
  <div
    v-if="envelope?.undoToken"
    class="-mt-3 mb-3 flex justify-end"
  >
    <UButton
      v-if="!undone"
      size="xs"
      variant="link"
      color="primary"
      icon="i-lucide-undo-2"
      label="Undo"
      @click="emit('undo', envelope!.undoToken!)"
    />
    <span
      v-else
      class="text-xs text-muted"
    >undone</span>
  </div>
  <WorkstreamsStartedCard
    v-if="started"
    :id="started.id"
    :goal="started.goal"
  />
  <ArtifactsChatCard
    v-if="artifact"
    v-bind="artifact"
  />
  <AgentSubagentSteps
    v-if="steps?.length"
    :steps="steps"
    :running="running"
    class="mb-3"
  />
</template>
