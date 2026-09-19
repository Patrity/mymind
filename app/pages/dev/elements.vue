<script setup lang="ts">
// Dev-only fixture for the AI Elements spike and for Task 9's component work. Not in production
// builds at all (nuxt.config `$production.ignore`); the guard below is belt and braces.
import type { LanguageModelUsage } from 'ai'
import type { AgentUIMessage } from '~~/shared/types/agent-ui'
import type { AttachmentRef } from '~~/shared/types/conversation'
import type { VoiceState } from '~/composables/useVoice'
import type { PendingApprovalDetails } from '@/components/agent/ApprovalConfirmation.vue'
import type { ContextMeterData } from '~/lib/agent/context-meter'
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

// ══════════════════════════════════════════════════════════════════════════════
// Task 5 fixture state (cycle 65): AgentPersona, AgentContextMeter, inline
// AgentApprovalConfirmation (exercised through AgentConversation -> AgentToolPart, the
// real wiring), the rewritten AgentEmptyState.
// ══════════════════════════════════════════════════════════════════════════════
const agentVoiceStates: VoiceState[] = ['connecting', 'idle', 'listening', 'thinking', 'speaking', 'tool', 'typing']

const agentPersonaState = ref<VoiceState>('idle')
const agentPersonaConnected = ref(true)

const contextKnownWindow: ContextMeterData = { usedTokens: 42000, maxTokens: 200000, modelDefId: 'demo' }
const contextUnknownWindow: ContextMeterData = { usedTokens: 1800, maxTokens: null, modelDefId: 'demo' }

// Only 'r1' has details (voice.pendingApproval); 'r2' proves the minimal (no details) path —
// AgentToolPart only forwards `details` to the part whose approval.id matches.
const approvalDetails = ref<PendingApprovalDetails | null>({
  requestId: 'r1',
  tool: 'exec',
  command: 'rm -rf /tmp/scratch',
  proposedPattern: 'rm -rf /tmp/*'
})
const approvalFixtureMessages: AgentUIMessage[] = [
  {
    id: 'approval-1', role: 'assistant',
    parts: [{
      type: 'dynamic-tool', toolName: 'exec', toolCallId: 't-approve', state: 'approval-requested',
      input: { command: 'rm -rf /tmp/scratch' }, approval: { id: 'r1' }
    }]
  },
  {
    id: 'approval-2', role: 'assistant',
    parts: [{
      type: 'dynamic-tool', toolName: 'read_file', toolCallId: 't-approve-minimal', state: 'approval-requested',
      input: { path: '/etc/hosts' }, approval: { id: 'r2' }
    }]
  }
]
const approvalLog = ref('')
function onApprovalApprove(requestId: string, opts: { remember: boolean, pattern: string }) {
  approvalLog.value = `approve(${JSON.stringify(requestId)}, ${JSON.stringify(opts)})`
}
function onApprovalDeny(requestId: string) {
  approvalLog.value = `deny(${JSON.stringify(requestId)})`
}

const emptyStateState = ref<VoiceState>('idle')
const emptyStateConnected = ref(true)
const emptyStatePicked = ref('')

// ══════════════════════════════════════════════════════════════════════════════
// Task 6 fixture state (cycle 65): AgentPromptInput — the Elements composer.
// ══════════════════════════════════════════════════════════════════════════════
const promptInputSpeak = ref(false)
const promptInputModel = ref('__default__')
const promptInputBusy = ref(false)
const promptInputMicOn = ref(false)
const promptInputShowPersona = ref(true)
const promptInputInitialText = ref('')
const promptInputAutoSend = ref(false)
const promptInputPrefill = ref('')
const promptInputLog = ref('')
// Counts sendText calls (not just the latest payload) — lets the double-submit re-entrancy
// check assert "exactly one send" rather than just eyeballing the last log line.
const promptInputSendCount = ref(0)
async function onPromptInputSend(text: string, speak?: boolean, attachments?: AttachmentRef[]) {
  promptInputSendCount.value++
  promptInputLog.value = JSON.stringify({ text, speak, attachments })
  return true
}
function simulateQuery() {
  promptInputAutoSend.value = true
  promptInputInitialText.value = `hand-off question ${Date.now()}`
}
function simulatePrefill() {
  promptInputPrefill.value = `starter click ${Date.now()}`
}
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
      state="idle"
      :connected="true"
      :hero="true"
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

    <!-- ══════════════════════════════════════════════════════════════════════════════
         Task 5 (cycle 65): AgentPersona, AgentContextMeter, inline AgentApprovalConfirmation
         (via the real AgentConversation -> AgentToolPart wiring), the rewritten AgentEmptyState.
         ══════════════════════════════════════════════════════════════════════════════ -->
    <div class="space-y-8 border-t border-default pt-8">
      <section class="space-y-3">
        <h2 class="text-sm font-medium text-muted-foreground">
          AgentPersona (hero / inline / full, CSS fallback)
        </h2>
        <div class="flex flex-wrap items-center gap-4">
          <Select v-model="agentPersonaState">
            <SelectTrigger class="w-36">
              <SelectValue placeholder="state" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="s in agentVoiceStates" :key="s" :value="s">
                {{ s }}
              </SelectItem>
            </SelectContent>
          </Select>
          <USwitch v-model="agentPersonaConnected" label="connected" />
        </div>
        <ClientOnly>
          <div class="flex flex-wrap items-end gap-10">
            <div>
              <p class="mb-2 text-xs text-muted-foreground">
                hero
              </p>
              <AgentPersona size="hero" :state="agentPersonaState" :connected="agentPersonaConnected" />
            </div>
            <div>
              <p class="mb-2 text-xs text-muted-foreground">
                inline
              </p>
              <AgentPersona size="inline" :state="agentPersonaState" :connected="agentPersonaConnected" />
            </div>
            <div>
              <p class="mb-2 text-xs text-muted-foreground">
                full
              </p>
              <AgentPersona size="full" :state="agentPersonaState" :connected="agentPersonaConnected" />
            </div>
            <div>
              <p class="mb-2 text-xs text-muted-foreground">
                forced fallback ×2 (bogus src — follows the state select; pulses for
                listening/thinking/speaking, static for idle/asleep). Two SEPARATE component
                instances, both erroring — proves the console.warn latch is once per page
                load, not once per instance (check devtools console: exactly one
                "[persona] falling back" entry).
              </p>
              <div class="flex items-end gap-4">
                <AgentPersona
                  size="hero"
                  :state="agentPersonaState"
                  :connected="agentPersonaConnected"
                  src-override="https://example.invalid/does-not-exist.riv"
                />
                <AgentPersona
                  size="inline"
                  :state="agentPersonaState"
                  :connected="agentPersonaConnected"
                  src-override="https://example.invalid/also-does-not-exist.riv"
                />
              </div>
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
          AgentContextMeter
        </h2>
        <div class="flex flex-wrap items-start gap-8">
          <div>
            <p class="mb-1 text-xs text-muted-foreground">
              known window (ring + %)
            </p>
            <AgentContextMeter :data="contextKnownWindow" />
          </div>
          <div>
            <p class="mb-1 text-xs text-muted-foreground">
              unknown window (count + tooltip, no ring)
            </p>
            <AgentContextMeter :data="contextUnknownWindow" />
          </div>
          <div>
            <p class="mb-1 text-xs text-muted-foreground">
              null (no usage yet — renders nothing)
            </p>
            <AgentContextMeter :data="null" />
          </div>
        </div>
      </section>

      <section class="space-y-3">
        <h2 class="text-sm font-medium text-muted-foreground">
          Inline approval — AgentConversation → AgentToolPart → AgentApprovalConfirmation
        </h2>
        <p class="text-xs text-muted-foreground">
          't-approve' (approval.id 'r1') has matching details from "voice.pendingApproval";
          't-approve-minimal' (approval.id 'r2') has none — the minimal (input-JSON) variant.
        </p>
        <AgentConversation
          class="h-96"
          :messages="approvalFixtureMessages"
          :approval="approvalDetails"
          state="tool"
          :connected="true"
          :hero="true"
          @approve="onApprovalApprove"
          @deny="onApprovalDeny"
        />
        <p v-if="approvalLog" class="text-xs text-muted-foreground">
          {{ approvalLog }}
        </p>
      </section>

      <section class="space-y-3">
        <h2 class="text-sm font-medium text-muted-foreground">
          AgentEmptyState (hero Persona + Suggestions)
        </h2>
        <div class="flex flex-wrap items-center gap-4">
          <Select v-model="emptyStateState">
            <SelectTrigger class="w-36">
              <SelectValue placeholder="state" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="s in agentVoiceStates" :key="s" :value="s">
                {{ s }}
              </SelectItem>
            </SelectContent>
          </Select>
          <USwitch v-model="emptyStateConnected" label="connected" />
        </div>
        <div class="rounded-md border border-default">
          <AgentEmptyState
            :state="emptyStateState"
            :connected="emptyStateConnected"
            :hero="true"
            @pick="(p: string) => (emptyStatePicked = p)"
          />
        </div>
        <p v-if="emptyStatePicked" class="text-xs text-muted-foreground">
          picked: {{ emptyStatePicked }}
        </p>
      </section>

      <section class="space-y-3">
        <h2 class="text-sm font-medium text-muted-foreground">
          AgentPromptInput (the Elements composer)
        </h2>
        <div class="flex flex-wrap items-center gap-4">
          <USwitch v-model="promptInputBusy" label="busy" />
          <USwitch v-model="promptInputMicOn" label="mic on" />
          <USwitch v-model="promptInputShowPersona" label="show persona" />
          <UButton size="xs" variant="soft" @click="simulateQuery">
            simulate ?q= auto-send
          </UButton>
          <UButton size="xs" variant="soft" @click="simulatePrefill">
            simulate starter prefill
          </UButton>
        </div>
        <div class="max-w-2xl rounded-md border border-default">
          <AgentPromptInput
            v-model:speak="promptInputSpeak"
            v-model:model="promptInputModel"
            :send-text="onPromptInputSend"
            :busy="promptInputBusy"
            :mic-on="promptInputMicOn"
            state="idle"
            :connected="true"
            :show-persona="promptInputShowPersona"
            :context-meter="contextKnownWindow"
            :initial-text="promptInputInitialText"
            :auto-send="promptInputAutoSend"
            :prefill="promptInputPrefill"
            @stop="promptInputLog = 'stop emitted'"
            @toggle-mic="promptInputMicOn = !promptInputMicOn"
          />
        </div>
        <p class="text-xs text-muted-foreground">
          speak: {{ promptInputSpeak }} · model: {{ promptInputModel }} · sends: {{ promptInputSendCount }}
        </p>
        <p v-if="promptInputLog" class="text-xs text-muted-foreground font-mono">
          {{ promptInputLog }}
        </p>
      </section>
    </div>
  </div>
</template>
