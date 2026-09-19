<script setup lang="ts">
import type { AgentUIPart, SubagentStep, ToolEnvelope } from '~~/shared/types/agent-ui'
import type { PendingApprovalDetails } from './ApprovalConfirmation.vue'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import { toolTitle, isRunning } from '~/lib/agent/render'

const props = defineProps<{
  part: Extract<AgentUIPart, { type: 'dynamic-tool' }>
  steps: SubagentStep[] | null
  undone?: boolean
  approval?: PendingApprovalDetails | null
}>()
const emit = defineEmits<{
  undo: [undoToken: string]
  approve: [requestId: string, opts: { remember: boolean; pattern: string }]
  deny: [requestId: string]
}>()

const envelope = computed(() => (props.part.state === 'output-available' ? props.part.output as ToolEnvelope : null))
const running = computed(() => isRunning(props.part))
const pendingPart = computed(() => (props.part.state === 'approval-requested' ? props.part : null))
const approvalDetails = computed(() => (
  pendingPart.value && props.approval?.requestId === pendingPart.value.approval.id ? props.approval : null
))
</script>

<template>
  <Tool :default-open="false">
    <ToolHeader
      type="dynamic-tool"
      :tool-name="part.toolName"
      :state="part.state"
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
  <AgentSubagentSteps
    v-if="steps?.length"
    :steps="steps"
    :running="running"
    class="mb-3"
  />
</template>
