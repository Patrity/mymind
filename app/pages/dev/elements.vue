<script setup lang="ts">
// Dev-only fixture for the AI Elements spike and for Task 9's component work. Not in production
// builds at all (nuxt.config `$production.ignore`); the guard below is belt and braces.
import type { LanguageModelUsage } from 'ai'
import type { AgentUIMessage } from '~~/shared/types/agent-ui'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtStep } from '@/components/ai-elements/chain-of-thought'
// Task 0 spike (cycle 65): the six new Elements installed alongside the cycle-64 set.
import { Persona } from '@/components/ai-elements/persona'
import {
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextTrigger
} from '@/components/ai-elements/context'
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion'
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools
} from '@/components/ai-elements/prompt-input'
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle
} from '@/components/ai-elements/confirmation'
import { Attachment, AttachmentInfo, Attachments, AttachmentPreview, AttachmentRemove } from '@/components/ai-elements/attachments'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

if (!import.meta.dev) throw createError({ statusCode: 404, statusMessage: 'Not found', fatal: true })
definePageMeta({ title: 'Elements fixture' })

// Uploaded in THIS worktree's gitignored .data/uploads (the dev DB is shared across
// worktrees but uploads are not) — if this 404s in another checkout, re-upload via
// /api/upload and swap the id.
const IMAGE_ID = 'db176c21-a420-41b4-bea9-b0455fcd416e' // Step 6: a real id from /api/images
const md = [
  '## Heading', '', 'Some **bold**, `inline code`, and a [link](https://example.com).', '',
  '- one', '- two', '', '| a | b |', '|---|---|', '| 1 | 2 |', '',
  '```ts', 'const x: number = 1', '```', '',
  `![a real embed](/api/images/${IMAGE_ID}/raw)`
].join('\n')
const states = ['input-streaming', 'input-available', 'output-available', 'output-error', 'output-denied'] as const

const undone = reactive(new Set<string>())
const fixture: AgentUIMessage[] = [
  {
    id: 'u1', role: 'user',
    parts: [
      { type: 'text', text: 'Find my notes on Orpheus and check the web' },
      { type: 'file', mediaType: 'image/png', url: `/api/images/${IMAGE_ID}/raw`, filename: 'screenshot.png' }
    ],
    metadata: { createdAt: '2026-09-19T10:00:00.000Z' }
  },
  {
    id: 'a1', role: 'assistant',
    metadata: { createdAt: '2026-09-19T10:00:05.000Z', usage: { inputTokens: 1500, outputTokens: 340, totalTokens: 1840 } },
    parts: [
      { type: 'reasoning', text: 'Documents first, then a research pass.', state: 'done' },
      { type: 'text', text: 'Looking. ', state: 'done' },
      { type: 'dynamic-tool', toolName: 'web_fetch', toolCallId: 't-run', state: 'input-available', input: { url: 'https://example.com' } },
      { type: 'dynamic-tool', toolName: 'create_task', toolCallId: 't-ok', state: 'output-available', input: { title: 'Try Orpheus' },
        output: { value: { id: 'task1', title: 'Try Orpheus' }, summary: "added 'Try Orpheus' to todo", undoToken: 'fixture-undo', kind: 'create' } },
      { type: 'dynamic-tool', toolName: 'web_fetch', toolCallId: 't-err', state: 'output-error', input: { url: 'https://ebay.com' }, errorText: '403 Forbidden' },
      { type: 'dynamic-tool', toolName: 'exec', toolCallId: 't-deny', state: 'output-denied', input: { command: 'df -h' }, approval: { id: 't-deny', approved: false } },
      { type: 'dynamic-tool', toolName: 'research_web', toolCallId: 't-sub', state: 'input-available', input: { task: 'orpheus tts self-hosting' } },
      { type: 'data-subagent', id: 't-sub', data: { steps: [
        { callId: 'n1', name: 'web_search', summary: 'searched (5)', state: 'done' },
        { callId: 'n2', name: 'web_fetch', summary: 'failed: web_fetch', state: 'error' },
        { callId: 'n3', name: 'web_fetch', state: 'running' }
      ] } },
      { type: 'text', text: md, state: 'done' }
    ]
  },
  {
    id: 'a2', role: 'assistant',
    metadata: { createdAt: '2026-09-19T10:01:00.000Z', errorText: 'model unavailable' },
    parts: [{ type: 'text', text: 'Partial answer before the model dro', state: 'done' }]
  }
]

// ── Task 0 spike (cycle 65) fixture state ──────────────────────────────────────────
const personaStates = ['idle', 'listening', 'thinking', 'speaking', 'asleep'] as const
const personaVariants = ['command', 'glint', 'halo', 'mana', 'obsidian', 'opal'] as const
const personaState = ref<typeof personaStates[number]>('idle')
const personaVariant = ref<typeof personaVariants[number]>('obsidian')

// Proves the loadError fallback path is real: an unreachable URL via the `srcOverride`
// prop (Persona.vue patch) rather than a real `sources` entry.
const personaLoadErrorFired = ref(false)
const personaLoadErrorMessage = ref('')
function onBogusPersonaLoadError(err: unknown) {
  personaLoadErrorFired.value = true
  personaLoadErrorMessage.value = err instanceof Error ? err.message : String(err)
}

const contextUsage: LanguageModelUsage = {
  inputTokens: 32000,
  inputTokenDetails: { noCacheTokens: 31000, cacheReadTokens: 1000, cacheWriteTokens: 0 },
  outputTokens: 12000,
  outputTokenDetails: { textTokens: 9000, reasoningTokens: 3000 },
  totalTokens: 48000,
  // Deprecated flat fields — the vendored Context*Usage.vue components (registry
  // source) still read these directly rather than the nested *TokenDetails.
  reasoningTokens: 3000,
  cachedInputTokens: 1000
}

const suggestionsDemo = ['Summarize my week', 'What changed in cycle 64?', 'Draft a reply', 'Search my notes for Orpheus']
const suggestionClicked = ref('')

const promptSubmitLog = ref('')
function onPromptSubmit(payload: { text: string, files: unknown[] }) {
  promptSubmitLog.value = JSON.stringify(payload)
}

const confirmationDecision = ref('')

const attachmentsDemo = [
  { id: 'att-img', type: 'file' as const, mediaType: 'image/png', url: `/api/images/${IMAGE_ID}/raw`, filename: 'screenshot.png' },
  { id: 'att-doc', type: 'file' as const, mediaType: 'application/pdf', url: '#', filename: 'notes.pdf' }
]
</script>

<template>
  <!-- Not a flex column: AgentConversation's inner Elements `Conversation` sets flex-1 (flex-basis
       0%), which collapses to 0 height when a flex sibling here (the spike block below) also
       wants real height inside a viewport-capped `h-full` parent. Plain block flow lets
       `h-[70vh]` apply directly and the page just scrolls past both. -->
  <div class="h-full overflow-y-auto p-4 space-y-8">
    <AgentConversation
      class="h-[70vh]"
      :messages="fixture"
      :undone="undone"
      @undo="(id: string) => undone.add(id)"
    />
    <!-- Task 0 spike block (unchanged) follows -->
    <div class="h-full p-4" data-ai-elements>
      <Conversation class="h-full">
        <ConversationContent>
          <Message from="user"><MessageContent>Find my notes on Orpheus</MessageContent></Message>
          <Message from="assistant">
            <MessageContent>
              <Reasoning :is-streaming="false" :default-open="false">
                <ReasoningTrigger />
                <ReasoningContent content="Looking through documents first, then the web." />
              </Reasoning>
              <Tool v-for="s in states" :key="s" :default-open="s === 'output-available'">
                <ToolHeader type="dynamic-tool" tool-name="search_docs" :state="s" />
                <ToolContent>
                  <ToolInput :input="{ query: 'orpheus', limit: 5 }" />
                  <ToolOutput
                    :output="s === 'output-available' ? { hits: 4 } : undefined"
                    :error-text="s === 'output-error' ? '403 from example.com' : undefined"
                  />
                </ToolContent>
              </Tool>
              <ChainOfThought :default-open="true">
                <ChainOfThoughtHeader>research: orpheus TTS</ChainOfThoughtHeader>
                <ChainOfThoughtContent>
                  <ChainOfThoughtStep label="web_search" description="searched (5)" status="complete" />
                  <ChainOfThoughtStep label="web_fetch" description="fetching…" status="active" />
                </ChainOfThoughtContent>
              </ChainOfThought>
              <MessageResponse :content="md" />
            </MessageContent>
          </Message>
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
    </div>

    <!-- ══════════════════════════════════════════════════════════════════════════════
         Task 0 spike (cycle 65): Persona, Context, Suggestions, PromptInput,
         Confirmation, Attachments — go/no-go fixture.
         ══════════════════════════════════════════════════════════════════════════════ -->
    <div class="space-y-8 border-t border-default pt-8" data-ai-elements>
      <section class="space-y-3">
        <h2 class="text-sm font-medium text-muted-foreground">
          Persona (Rive, self-hosted wasm)
        </h2>
        <div class="flex flex-wrap items-center gap-4">
          <Select v-model="personaState">
            <SelectTrigger class="w-36">
              <SelectValue placeholder="state" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="s in personaStates" :key="s" :value="s">
                {{ s }}
              </SelectItem>
            </SelectContent>
          </Select>
          <Select v-model="personaVariant">
            <SelectTrigger class="w-36">
              <SelectValue placeholder="variant" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="v in personaVariants" :key="v" :value="v">
                {{ v }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <ClientOnly>
          <div class="flex items-start gap-10">
            <div>
              <p class="mb-2 text-xs text-muted-foreground">
                Live — {{ personaVariant }} / {{ personaState }}
              </p>
              <Persona
                class="size-32 overflow-hidden rounded-full border border-default"
                :state="personaState"
                :variant="personaVariant"
              />
            </div>
            <div>
              <p class="mb-2 text-xs text-muted-foreground">
                Bogus source (proves loadError)
              </p>
              <Persona
                class="size-32 overflow-hidden rounded-full border border-default"
                state="idle"
                variant="opal"
                src-override="https://example.invalid/does-not-exist.riv"
                @load-error="onBogusPersonaLoadError"
              />
              <p v-if="personaLoadErrorFired" class="mt-2 max-w-56 text-xs text-error">
                loadError fired: {{ personaLoadErrorMessage }}
              </p>
            </div>
          </div>
          <template #fallback>
            <p class="text-xs text-muted-foreground">
              Persona is client-only…
            </p>
          </template>
        </ClientOnly>
      </section>

      <section class="space-y-3">
        <h2 class="text-sm font-medium text-muted-foreground">
          Context (tokenlens removed — token counts only, no cost)
        </h2>
        <Context :used-tokens="48000" :max-tokens="128000" :usage="contextUsage" model-id="anthropic/claude-sonnet-5">
          <ContextTrigger />
          <ContextContent>
            <ContextContentHeader />
            <ContextContentBody>
              <ContextInputUsage />
              <ContextOutputUsage />
              <ContextReasoningUsage />
              <ContextCacheUsage />
            </ContextContentBody>
            <ContextContentFooter />
          </ContextContent>
        </Context>
      </section>

      <section class="space-y-3">
        <h2 class="text-sm font-medium text-muted-foreground">
          Suggestions
        </h2>
        <Suggestions>
          <Suggestion
            v-for="s in suggestionsDemo"
            :key="s"
            :suggestion="s"
            @click="(v: string) => (suggestionClicked = v)"
          />
        </Suggestions>
        <p v-if="suggestionClicked" class="text-xs text-muted-foreground">
          clicked: {{ suggestionClicked }}
        </p>
      </section>

      <section class="space-y-3">
        <h2 class="text-sm font-medium text-muted-foreground">
          PromptInput
        </h2>
        <PromptInput class="max-w-xl" @submit="onPromptSubmit">
          <PromptInputBody>
            <PromptInputTextarea />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <PromptInputActionMenu>
                <PromptInputActionMenuTrigger />
                <PromptInputActionMenuContent>
                  <PromptInputActionAddAttachments />
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
            </PromptInputTools>
            <PromptInputSubmit />
          </PromptInputFooter>
        </PromptInput>
        <p v-if="promptSubmitLog" class="text-xs text-muted-foreground">
          submit payload: {{ promptSubmitLog }}
        </p>
      </section>

      <section class="space-y-3">
        <h2 class="text-sm font-medium text-muted-foreground">
          Confirmation (approval-requested)
        </h2>
        <Confirmation class="max-w-md" state="approval-requested" :approval="{ id: 'confirm-1' }">
          <ConfirmationRequest>
            <ConfirmationTitle>
              Run <code>df -h</code>?
            </ConfirmationTitle>
            <ConfirmationActions>
              <ConfirmationAction @click="confirmationDecision = 'approved'">
                Approve
              </ConfirmationAction>
              <ConfirmationAction variant="outline" @click="confirmationDecision = 'denied'">
                Deny
              </ConfirmationAction>
            </ConfirmationActions>
          </ConfirmationRequest>
        </Confirmation>
        <p v-if="confirmationDecision" class="text-xs text-muted-foreground">
          decision: {{ confirmationDecision }}
        </p>
      </section>

      <section class="space-y-3">
        <h2 class="text-sm font-medium text-muted-foreground">
          Attachments
        </h2>
        <Attachments variant="list" class="max-w-md">
          <Attachment v-for="a in attachmentsDemo" :key="a.id" :data="a">
            <AttachmentPreview />
            <AttachmentInfo show-media-type />
            <AttachmentRemove />
          </Attachment>
        </Attachments>
      </section>
    </div>
  </div>
</template>
