<script setup lang="ts">
import type { SubagentStep } from '~~/shared/types/agent-ui'
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtStep } from '@/components/ai-elements/chain-of-thought'
import { toolTitle } from '~/lib/agent/render'

defineProps<{ steps: SubagentStep[]; running: boolean }>()
const status = (s: SubagentStep) => (s.state === 'running' ? 'active' : 'complete') as 'active' | 'complete'
</script>

<template>
  <ChainOfThought :default-open="running">
    <ChainOfThoughtHeader>{{ steps.length }} step{{ steps.length === 1 ? '' : 's' }}</ChainOfThoughtHeader>
    <ChainOfThoughtContent>
      <ChainOfThoughtStep
        v-for="s in steps"
        :key="s.callId"
        :label="toolTitle(s.name)"
        :description="s.state === 'error' ? `${s.summary ?? 'failed'}` : s.summary"
        :status="status(s)"
        :class="s.state === 'error' ? 'text-error' : ''"
      />
    </ChainOfThoughtContent>
  </ChainOfThought>
</template>
