<script setup lang="ts">
import { useVirtualList } from '@vueuse/core'
import type { SessionMessageDTO, SessionToolEventDTO } from '~~/shared/types/session'

const props = defineProps<{
  messages: SessionMessageDTO[]
  toolEvents: SessionToolEventDTO[]
  loading?: boolean
}>()

// ── Virtualization ────────────────────────────────────────────────────────────
// Only the visible window of message rows is mounted in the DOM, so multi-thousand
// message imported sessions scroll smoothly. Individual rows are height-bounded
// (internal max-h scrolls on big content) so a constant item-height estimate works.
const { list, containerProps, wrapperProps } = useVirtualList(
  computed(() => props.messages),
  { itemHeight: 140, overscan: 10 },
)

// Scroll container ref — a later task uses it for virtualization / scroll control.
// containerProps.ref is the same node the virtual list scrolls; alias it so both work.
const scrollEl = containerProps.ref

// ── Message classification ────────────────────────────────────────────────────
type MsgKind = 'user' | 'assistant' | 'tool'

function msgKind(msg: SessionMessageDTO): MsgKind {
  if (msg.metadata?.type === 'tool_result') return 'tool'
  if (Array.isArray(msg.metadata?.tools) && (msg.metadata.tools as unknown[]).length > 0) return 'tool'
  if (msg.role === 'assistant') return 'assistant'
  return 'user'
}

function toolNames(msg: SessionMessageDTO): string[] {
  const tools = (msg.metadata as { tools?: unknown }).tools
  if (Array.isArray(tools)) {
    return tools
      .map(t => typeof t === 'string' ? t : (t && typeof t === 'object' ? ((t as { name?: string }).name ?? 'tool') : 'tool'))
      .filter(Boolean)
  }
  if (msg.metadata?.type === 'tool_result') {
    const name = (msg.metadata?.tool_name as string | undefined)
    return name ? [name] : ['tool_result']
  }
  return []
}

function hasMetaDetails(msg: SessionMessageDTO): boolean {
  return Object.keys(msg.metadata ?? {}).length > 0
}

function metaJson(msg: SessionMessageDTO): string {
  try {
    return JSON.stringify(msg.metadata, null, 2)
  } catch {
    return String(msg.metadata)
  }
}

// Open state tracking for metadata collapsibles
const openMeta = ref<Record<string, boolean>>({})
function toggleMeta(id: string) {
  openMeta.value[id] = !openMeta.value[id]
}

// ── Tool events ───────────────────────────────────────────────────────────────
const toolEventsByMsg = computed(() => {
  const m = new Map<string, SessionToolEventDTO[]>()
  for (const te of props.toolEvents ?? []) {
    if (!te.messageId) continue
    const arr = m.get(te.messageId) ?? []
    arr.push(te)
    m.set(te.messageId, arr)
  }
  return m
})

function exitColor(s: string | null): 'success' | 'error' | 'neutral' {
  return s === 'ok' ? 'success' : s ? 'error' : 'neutral'
}
</script>

<template>
  <div class="space-y-2 h-full flex flex-col">
    <h2 class="text-sm font-semibold text-muted uppercase tracking-wider px-1 shrink-0">
      Transcript
    </h2>

    <!-- Loading skeleton (outside the virtual list) -->
    <div
      v-if="loading && !messages.length"
      class="space-y-2 h-full overflow-y-auto pr-1"
    >
      <USkeleton
        v-for="i in 5"
        :key="i"
        class="h-24 w-full rounded-lg"
      />
    </div>

    <!-- Empty transcript (outside the virtual list) -->
    <div
      v-else-if="!loading && !messages.length"
      class="flex flex-col items-center justify-center py-16 gap-3 text-center h-full overflow-y-auto pr-1"
    >
      <UIcon
        name="i-lucide-message-square-off"
        class="size-10 text-muted"
      />
      <p class="text-sm text-muted">
        No messages in this session
      </p>
    </div>

    <!-- Virtualized scroll area fills the pane: only the visible window is mounted -->
    <div
      v-else
      v-bind="containerProps"
      class="h-full overflow-y-auto pr-1"
    >
      <div
        v-bind="wrapperProps"
        class="space-y-2"
      >
        <template
          v-for="{ data: msg } in list"
          :key="msg.id"
        >
        <!-- Tool turn -->
        <div
          v-if="msgKind(msg) === 'tool'"
          data-msg
          class="flex items-start gap-2"
          :class="msg.isSidechain ? 'opacity-70' : ''"
        >
          <div class="w-full">
            <UCard :ui="{ root: 'bg-elevated/40 border-muted', body: 'py-2 px-3' }">
              <div class="flex items-start justify-between gap-2">
                <div class="flex items-center gap-1.5 flex-wrap">
                  <UIcon name="i-lucide-wrench" class="size-3.5 text-warning shrink-0 mt-0.5" />
                  <template v-if="!toolEventsByMsg.get(msg.id)?.length">
                    <UBadge
                      v-for="name in toolNames(msg)"
                      :key="name"
                      :label="name"
                      color="warning"
                      variant="subtle"
                      size="xs"
                    />
                    <UBadge
                      v-if="msg.metadata?.type === 'tool_result'"
                      label="result"
                      color="neutral"
                      variant="outline"
                      size="xs"
                    />
                  </template>
                </div>
                <!-- Meta toggle -->
                <UButton
                  v-if="hasMetaDetails(msg)"
                  icon="i-lucide-chevron-down"
                  :class="openMeta[msg.id] ? 'rotate-180' : ''"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  class="shrink-0 transition-transform"
                  @click="toggleMeta(msg.id)"
                />
              </div>
              <div
                v-if="msg.content"
                class="mt-1.5 text-xs text-muted font-mono line-clamp-3"
              >
                {{ msg.content.slice(0, 300) }}{{ msg.content.length > 300 ? '…' : '' }}
              </div>
              <!-- Tool event detail (new rows with tool_events populated) -->
              <template v-if="toolEventsByMsg.get(msg.id)?.length">
                <div
                  v-for="te in toolEventsByMsg.get(msg.id)"
                  :key="te.id"
                  class="mt-1.5"
                >
                  <div class="flex items-center gap-1.5 flex-wrap">
                    <UBadge :label="te.toolName" color="warning" variant="subtle" size="xs" />
                    <UBadge v-if="te.exitStatus" :label="te.exitStatus" :color="exitColor(te.exitStatus)" variant="subtle" size="xs" />
                  </div>
                  <pre v-if="te.args" class="mt-1 text-xs text-dimmed font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto">{{ JSON.stringify(te.args, null, 2).slice(0, 500) }}</pre>
                  <pre v-if="te.result" class="mt-1 text-xs text-muted font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto">{{ typeof te.result === 'string' ? te.result.slice(0, 500) : JSON.stringify(te.result, null, 2).slice(0, 500) }}</pre>
                </div>
              </template>
              <div
                v-if="openMeta[msg.id]"
                class="mt-2 pt-2 border-t border-muted"
              >
                <pre class="text-xs text-dimmed font-mono overflow-x-auto whitespace-pre-wrap break-words max-h-48">{{ metaJson(msg) }}</pre>
              </div>
            </UCard>
          </div>
        </div>

        <!-- User turn -->
        <div
          v-else-if="msgKind(msg) === 'user'"
          data-msg
          class="flex justify-end"
          :class="msg.isSidechain ? 'opacity-70' : ''"
        >
          <div class="max-w-[85%]">
            <UCard :ui="{ root: 'bg-primary/10 border-primary/20', body: 'py-2.5 px-3.5' }">
              <div class="flex items-start justify-between gap-2 mb-1.5">
                <UBadge
                  label="user"
                  color="primary"
                  variant="subtle"
                  size="xs"
                />
                <UButton
                  v-if="hasMetaDetails(msg)"
                  icon="i-lucide-chevron-down"
                  :class="openMeta[msg.id] ? 'rotate-180' : ''"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  class="shrink-0 transition-transform"
                  @click="toggleMeta(msg.id)"
                />
              </div>
              <MdView :source="msg.content" />
              <div
                v-if="openMeta[msg.id]"
                class="mt-2 pt-2 border-t border-muted"
              >
                <pre class="text-xs text-dimmed font-mono overflow-x-auto whitespace-pre-wrap break-words max-h-48">{{ metaJson(msg) }}</pre>
              </div>
            </UCard>
          </div>
        </div>

        <!-- Assistant turn -->
        <div
          v-else
          data-msg
          class="flex justify-start"
          :class="msg.isSidechain ? 'opacity-70' : ''"
        >
          <div class="max-w-[85%]">
            <UCard :ui="{ body: 'py-2.5 px-3.5' }">
              <div class="flex items-start justify-between gap-2 mb-1.5">
                <div class="flex items-center gap-1.5 flex-wrap">
                  <UBadge
                    label="assistant"
                    color="neutral"
                    variant="subtle"
                    size="xs"
                  />
                  <span v-if="msg.model" class="text-xs text-dimmed font-mono">{{ msg.model }}</span>
                </div>
                <UButton
                  v-if="hasMetaDetails(msg)"
                  icon="i-lucide-chevron-down"
                  :class="openMeta[msg.id] ? 'rotate-180' : ''"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  class="shrink-0 transition-transform"
                  @click="toggleMeta(msg.id)"
                />
              </div>
              <details v-if="msg.thinking" class="mb-1.5">
                <summary class="text-xs text-dimmed cursor-pointer select-none">thinking…</summary>
                <pre class="mt-1 text-xs text-dimmed font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto">{{ msg.thinking }}</pre>
              </details>
              <MdView :source="msg.content" />
              <div
                v-if="openMeta[msg.id]"
                class="mt-2 pt-2 border-t border-muted"
              >
                <pre class="text-xs text-dimmed font-mono overflow-x-auto whitespace-pre-wrap break-words max-h-48">{{ metaJson(msg) }}</pre>
              </div>
            </UCard>
          </div>
        </div>
        </template>
      </div>
    </div>
  </div>
</template>
