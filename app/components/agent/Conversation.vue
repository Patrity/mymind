<!-- app/components/agent/Conversation.vue -->
<script setup lang="ts">
// The agent conversation, rendered from AI SDK UIMessages with AI Elements Vue. Replaces
// voice/Transcript.vue: scrolling (stick-to-bottom + scroll button) and streaming markdown
// now come from Elements instead of hand-rolled ResizeObserver/MDC-cache-key plumbing.
import type { AgentUIMessage } from '~~/shared/types/agent-ui'
import type { VoiceState } from '~/composables/useVoice'
import type { PendingApprovalDetails } from './ApprovalConfirmation.vue'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { subagentSteps } from '~/lib/agent/render'

defineProps<{
  messages: AgentUIMessage[]
  undone?: ReadonlySet<string>
  /** The pending approval's details, or null — forwarded to whichever tool part it belongs to. */
  approval?: PendingApprovalDetails | null
  /** Forwarded to AgentEmptyState for the hero Persona. */
  state: VoiceState
  connected: boolean
  /** Forwarded to AgentEmptyState: false while full-bleed voice mode is open, so its hero
   *  Persona doesn't mount a SECOND live Rive/WebGL2 canvas alongside the overlay's — see
   *  AgentEmptyState's `hero` prop. */
  hero: boolean
}>()
const emit = defineEmits<{
  undo: [toolCallId: string, undoToken: string]
  retry: [messageId: string]
  edit: [messageId: string]
  fork: [messageId: string]
  branch: [messageId: string, dir: -1 | 1]
  pick: [prompt: string]
  approve: [requestId: string, opts: { remember: boolean; pattern: string }]
  deny: [requestId: string]
}>()
</script>

<template>
  <Conversation
    class="min-h-0"
    data-ai-elements
  >
    <ConversationContent>
      <AgentEmptyState
        v-if="!messages.length"
        :state="state"
        :connected="connected"
        :hero="hero"
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
                :approval="approval"
                @undo="(t: string) => emit('undo', p.toolCallId, t)"
                @approve="(id: string, opts) => emit('approve', id, opts)"
                @deny="(id: string) => emit('deny', id)"
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
        <!-- :branch is hardcoded to a single-branch default here: `branch`/`siblingIds` are
             populated server-side on ConversationMessageDTO (server/services/conversations.ts)
             but are NOT threaded onto AgentUIMessage's metadata on the client — neither
             shared/types/agent-ui.ts's AgentMessageMetadata nor app/lib/agent/to-ui-messages.ts's
             toUIMessages() carries them across. Wiring real per-message branch data through would
             need both of those files, which are outside this task's two-file scope
             (ReplyActions.vue, Conversation.vue) — see task-8-report.md. AgentBranchPager already
             renders nothing for total <= 1, so this degrades to "no pager shown", matching every
             thread's actual current behaviour. -->
        <AgentReplyActions
          :message="m"
          :branch="{ index: 1, total: 1 }"
          @retry="emit('retry', m.id)"
          @edit="emit('edit', m.id)"
          @fork="emit('fork', m.id)"
          @branch="(d: -1 | 1) => emit('branch', m.id, d)"
        />
      </div>
    </ConversationContent>
    <ConversationScrollButton />
  </Conversation>
</template>
