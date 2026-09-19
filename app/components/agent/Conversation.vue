<!-- app/components/agent/Conversation.vue -->
<script setup lang="ts">
// The agent conversation, rendered from AI SDK UIMessages with AI Elements Vue. Replaces
// voice/Transcript.vue: scrolling (stick-to-bottom + scroll button) and streaming markdown
// now come from Elements instead of hand-rolled ResizeObserver/MDC-cache-key plumbing.
import type { AgentUIMessage } from '~~/shared/types/agent-ui'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { subagentSteps } from '~/lib/agent/render'

defineProps<{ messages: AgentUIMessage[]; undone?: ReadonlySet<string> }>()
const emit = defineEmits<{ undo: [toolCallId: string, undoToken: string]; retry: [messageId: string]; pick: [prompt: string] }>()
</script>

<template>
  <Conversation
    class="min-h-0"
    data-ai-elements
  >
    <ConversationContent>
      <AgentEmptyState
        v-if="!messages.length"
        @pick="(p: string) => emit('pick', p)"
      />
      <div
        v-for="m in messages"
        :key="m.id"
        class="group"
      >
        <Message :from="m.role">
          <MessageContent>
            <template
              v-for="(p, i) in m.parts"
              :key="`${m.id}-${i}`"
            >
              <template v-if="p.type === 'text'">
                <MessageResponse
                  v-if="m.role === 'assistant'"
                  :content="p.text"
                  :streaming="p.state === 'streaming'"
                />
                <p
                  v-else
                  class="whitespace-pre-wrap"
                >{{ p.text }}</p>
              </template>
              <Reasoning
                v-else-if="p.type === 'reasoning'"
                :is-streaming="p.state === 'streaming'"
                :default-open="false"
              >
                <ReasoningTrigger />
                <ReasoningContent
                  :content="p.text"
                  :streaming="p.state === 'streaming'"
                />
              </Reasoning>
              <AgentToolPart
                v-else-if="p.type === 'dynamic-tool'"
                :part="p"
                :steps="subagentSteps(m, p.toolCallId)"
                :undone="undone?.has(p.toolCallId)"
                @undo="(t: string) => emit('undo', p.toolCallId, t)"
              />
              <AgentAttachment
                v-else-if="p.type === 'file'"
                :part="p"
              />
            </template>
            <UAlert
              v-if="m.metadata?.errorText"
              color="error"
              variant="subtle"
              :title="m.metadata.errorText"
            />
            <span
              v-else-if="m.metadata?.interrupted"
              class="text-xs text-dimmed"
            >stopped</span>
          </MessageContent>
        </Message>
        <AgentReplyActions
          :message="m"
          @retry="emit('retry', m.id)"
        />
      </div>
    </ConversationContent>
    <ConversationScrollButton />
  </Conversation>
</template>
