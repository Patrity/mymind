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

const props = defineProps<{
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
  /** `/clear` boundaries reached this session (useVoice's `dividers`) — rendered as a labeled
   *  separator, REQUIRED rather than decorative: the model reads only messages after the
   *  boundary while this list still shows everything, and that divergence must stay visible,
   *  not silent. */
  dividers?: { afterMessageId: string | null, epochAt: string }[]
}>()
const emit = defineEmits<{
  undo: [toolCallId: string, undoToken: string]
  retry: [messageId: string]
  /** Emitted on SAVE, not on the pencil: the in-place editor below is this component's, so the
   *  page is handed the finished text rather than being asked to prompt for it. */
  edit: [messageId: string, text: string]
  fork: [messageId: string]
  branch: [messageId: string, dir: -1 | 1]
  pick: [prompt: string]
  approve: [requestId: string, opts: { remember: boolean, pattern: string }]
  deny: [requestId: string]
}>()

// Editing a user message happens IN PLACE — the message's own text becomes a textarea with
// Save/Cancel. Page-level state would be wrong here: the editor belongs to one message in the
// v-for, and only this component knows which.
const editingId = ref<string | null>(null)
const draft = ref('')

function startEdit(m: AgentUIMessage) {
  editingId.value = m.id
  // Text parts only: an attachment travels as metadata and is re-sent with the edited turn, so
  // it must not be flattened into the editable text.
  draft.value = m.parts.filter(p => p.type === 'text').map(p => p.text).join('')
}
function saveEdit() {
  const id = editingId.value
  const text = draft.value.trim()
  // An edit is a new branch, so an empty one would be a branch with no question in it. Saving
  // blank is therefore a CANCEL, not a silent discard that looks like it worked — and the Save
  // button is disabled while blank so it reads that way too.
  if (!id || !text) { editingId.value = null; return }
  editingId.value = null
  emit('edit', id, text)
}

// An open editor belongs to ONE message. When the list is replaced — another conversation, a
// branch switch, the post-turn re-read that swaps stream ids for row ids — a surviving
// `editingId` would re-attach the editor to whatever now sits at that id, or to nothing.
watch(() => props.messages, (list) => {
  if (editingId.value && !list.some(m => m.id === editingId.value)) editingId.value = null
})

/** Dividers anchored right after `afterMessageId` (`null` = before the first message). A
 *  message whose id no longer matches any divider (a different conversation's transcript,
 *  after `voice.dividers` was reset — see useVoice) simply renders none; nothing to guard. */
function dividersAfter(afterMessageId: string | null) {
  return (props.dividers ?? []).filter(d => d.afterMessageId === afterMessageId)
}
function dividerLabel(epochAt: string): string {
  const time = new Date(epochAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `Bridget's memory of this conversation starts here · ${time}`
}
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
      <USeparator
        v-for="d in dividersAfter(null)"
        :key="`epoch-${d.epochAt}`"
        color="primary"
        :label="dividerLabel(d.epochAt)"
        class="my-4"
      />
      <template
        v-for="m in messages"
        :key="m.id"
      >
        <div
          class="group"
        >
          <Message :from="m.role">
            <MessageContent>
              <!-- In-place edit. Saving does NOT rewrite this message: the page points the leaf
                 at its parent and re-sends, so the original stays reachable through the pager. -->
              <div
                v-if="editingId === m.id"
                class="flex w-full flex-col gap-2"
              >
                <UTextarea
                  v-model="draft"
                  autoresize
                  :rows="2"
                  class="w-full"
                  aria-label="Edit message"
                  autofocus
                  @keydown.esc="editingId = null"
                />
                <div class="flex items-center gap-2">
                  <UButton
                    size="xs"
                    color="primary"
                    label="Save"
                    :disabled="!draft.trim()"
                    @click="saveEdit"
                  />
                  <UButton
                    size="xs"
                    variant="ghost"
                    color="neutral"
                    label="Cancel"
                    @click="editingId = null"
                  />
                </div>
              </div>
              <template
                v-for="(p, i) in (editingId === m.id ? [] : m.parts)"
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
                  >
                    {{ p.text }}
                  </p>
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
          <!-- Real server-computed branch data now that AgentMessageMetadata carries it
             (shared/types/agent-ui.ts + app/lib/agent/to-ui-messages.ts, widened in Task 9 —
             the Pick there used to drop `branch`/`siblingIds`, so the pager could never render
             however correct the server was). A LIVE-streamed message is assembled client-side
             and has no branch metadata to carry, so it falls back to 1/1 — no pager — until the
             page refetches the thread, which it does after any turn that created a branch. -->
          <AgentReplyActions
            v-if="editingId !== m.id"
            :message="m"
            :branch="m.metadata?.branch ?? { index: 1, total: 1 }"
            @retry="emit('retry', m.id)"
            @edit="startEdit(m)"
            @fork="emit('fork', m.id)"
            @branch="(d: -1 | 1) => emit('branch', m.id, d)"
          />
        </div>
        <USeparator
          v-for="d in dividersAfter(m.id)"
          :key="`epoch-${d.epochAt}`"
          color="primary"
          :label="dividerLabel(d.epochAt)"
          class="my-4"
        />
      </template>
    </ConversationContent>
    <ConversationScrollButton />
  </Conversation>
</template>
