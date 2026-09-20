<script setup lang="ts">
import type { SessionMessageDTO, SessionToolEventDTO } from '~~/shared/types/session'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { CodeBlock } from '@/components/ai-elements/code-block'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { sessionToolState } from '~/lib/sessions/tool-state'

const props = defineProps<{
  message: SessionMessageDTO
  toolEvents: SessionToolEventDTO[]
}>()

// Rows stay scannable: a body is clamped until asked otherwise. Expanding re-measures, so the
// virtualizer is told via the resize observer it already has on each row.
const expanded = ref(false)

// The largest message in prod is 279,751 chars. Even expanded, a row must not be able to blow
// the list out — past this we show the head and say so.
const MAX_EXPANDED = 20_000
// Collapsed rows only ever show 6 clamped lines, but an uncapped string still flows into
// MessageResponse -> vue-stream-markdown, which fully parses and lays it out before CSS
// line-clamp hides the rest. Under a virtualizer that mounts/unmounts rows on every scroll
// tick, parsing a quarter-million characters to show six lines defeats the point of the
// cycle — so the collapsed preview gets its own, much smaller cap. 2,000 chars is far more
// than six lines can show at any viewport width. A cut mid-markdown (an unclosed code fence,
// a half-written link) is acceptable here: it's a preview, and "Show more" gives the properly
// capped, uncut content.
const PREVIEW_CHARS = 2_000
const body = computed(() => {
  const c = props.message.content
  if (!expanded.value) return c.length > PREVIEW_CHARS ? c.slice(0, PREVIEW_CHARS) : c
  return c.length > MAX_EXPANDED ? c.slice(0, MAX_EXPANDED) : c
})
const truncated = computed(() => expanded.value && props.message.content.length > MAX_EXPANDED)
const clampable = computed(() => props.message.content.length > 400)
const role = computed(() => (props.message.role === 'user' ? 'user' : 'assistant'))

// The DTO still carries `metadata` — whatever the parser stored for this message (`type`,
// `tool_name`, …) — and this disclosure is the only place it is visible, as it was before the
// rewrite. Behind a collapsible, so a row nobody opens pays nothing for it.
const hasMetadata = computed(() => Object.keys(props.message.metadata ?? {}).length > 0)
const metadataJson = computed(() => {
  try {
    return JSON.stringify(props.message.metadata, null, 2)
  } catch {
    return String(props.message.metadata)
  }
})

// sessionToolState is pure but the naive template would call it three times per tool event
// (once for state, once for input, once for output). Compute it once per event instead, keyed
// by event id, so re-renders don't triple the work.
const toolViews = computed(() => {
  const m = new Map<string, ReturnType<typeof sessionToolState>>()
  for (const te of props.toolEvents) m.set(te.id, sessionToolState(te))
  return m
})
</script>

<template>
  <div class="py-1" :class="message.isSidechain ? 'opacity-70' : ''">
    <!-- Which model produced this turn. `messages.model` became a first-class column so a
         transcript could be audited model by model, so the label belongs on the turn. -->
    <div
      v-if="message.model"
      class="mb-1 flex items-center gap-1.5"
      :class="role === 'user' ? 'justify-end' : ''"
    >
      <UBadge
        :label="message.model"
        color="neutral"
        variant="subtle"
        size="xs"
        class="font-mono"
      />
    </div>

    <Reasoning v-if="message.thinking" class="mb-1">
      <ReasoningTrigger />
      <ReasoningContent :content="message.thinking" />
    </Reasoning>

    <Message v-if="body" :from="role">
      <MessageContent>
        <div :class="!expanded && clampable ? 'line-clamp-6 overflow-hidden' : ''">
          <MessageResponse>{{ body }}</MessageResponse>
        </div>
        <p v-if="truncated" class="mt-1 text-xs text-dimmed">
          Showing the first {{ MAX_EXPANDED.toLocaleString() }} of
          {{ message.content.length.toLocaleString() }} characters.
        </p>
        <UButton
          v-if="clampable"
          :label="expanded ? 'Show less' : 'Show more'"
          color="neutral"
          variant="link"
          size="xs"
          class="mt-1 px-0"
          @click="expanded = !expanded"
        />
      </MessageContent>
    </Message>

    <Tool v-for="te in toolEvents" :key="te.id" :default-open="false" class="mt-1">
      <ToolHeader
        type="dynamic-tool"
        :tool-name="te.toolName"
        :state="toolViews.get(te.id)!.state"
      />
      <ToolContent>
        <ToolInput :input="toolViews.get(te.id)!.input" />
        <ToolOutput
          :output="toolViews.get(te.id)!.output"
          :error-text="toolViews.get(te.id)!.state === 'output-error' ? String(toolViews.get(te.id)!.output ?? 'Error') : undefined"
        />
      </ToolContent>
    </Tool>

    <Collapsible
      v-if="hasMetadata"
      class="group mt-1 w-fit max-w-full"
    >
      <CollapsibleTrigger
        class="flex items-center gap-1.5 text-xs text-dimmed transition-colors hover:text-muted"
        data-transcript-meta-trigger
      >
        <UIcon name="i-lucide-braces" class="size-3.5" />
        <span>Metadata</span>
        <UIcon
          name="i-lucide-chevron-down"
          class="size-3.5 transition-transform group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        class="mt-1 max-h-48 overflow-auto rounded-md border border-muted"
        data-transcript-meta-content
      >
        <CodeBlock :code="metadataJson" language="json" />
      </CollapsibleContent>
    </Collapsible>
  </div>
</template>
