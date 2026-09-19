<script setup lang="ts">
// Dev-only fixture for the AI Elements spike and for Task 9's component work. 404s in prod.
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtStep } from '@/components/ai-elements/chain-of-thought'

if (!import.meta.dev) throw createError({ statusCode: 404, statusMessage: 'Not found', fatal: true })
definePageMeta({ title: 'Elements fixture' })

const IMAGE_ID = 'db176c21-a420-41b4-bea9-b0455fcd416e' // Step 6: a real id from /api/images
const md = [
  '## Heading', '', 'Some **bold**, `inline code`, and a [link](https://example.com).', '',
  '- one', '- two', '', '| a | b |', '|---|---|', '| 1 | 2 |', '',
  '```ts', 'const x: number = 1', '```', '',
  `![a real embed](/api/images/${IMAGE_ID}/raw)`
].join('\n')
const states = ['input-streaming', 'input-available', 'output-available', 'output-error', 'output-denied'] as const
</script>

<template>
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
</template>
