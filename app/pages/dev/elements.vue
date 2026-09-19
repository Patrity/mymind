<script setup lang="ts">
// Dev-only fixture for the AI Elements spike and for Task 9's component work. 404s in prod.
import type { AgentUIMessage } from '~~/shared/types/agent-ui'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtStep } from '@/components/ai-elements/chain-of-thought'

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
  </div>
</template>
