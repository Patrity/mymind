<script setup lang="ts">
// Thread view. Loads the message history once, then attaches `useThreadStream`
// to receive live arrivals (SSE with polling fallback). The composable handles
// reconnects and Last-Event-ID replay; we just dedupe on `id` in case the
// catch-up replay overlaps with what we already have in history.
//
// Adapted from copipasta: removed multi-user device list fetch (no /api/devices
// endpoint in MyMind), removed lastThreadId PATCH call (single-thread model),
// removed auth guards (MyMind handles auth globally).
interface AttachmentRow {
  storageKey: string
  sha256: string
  size: number
  mimeType: string
  originalName: string
  width: number | null
  height: number | null
}
interface MessageRow {
  id: string
  deviceId: string
  deviceLabel?: string | null
  kind: 'text' | 'file'
  bodyText: string | null
  bodyHtml: string | null
  createdAt: string | Date | number
  attachment?: AttachmentRow
}

const props = defineProps<{ threadId: string }>()
const threadIdRef = computed(() => props.threadId)
const messages = ref<MessageRow[]>([])

// Current device id from the long-lived cookie set by /api/clipboard/devices/register.
const currentDeviceId = useCookie<string | null>('clip_device')

// Load initial history in ascending createdAt order.
const { data: history } = await useFetch<MessageRow[]>(`/api/clipboard/threads/${props.threadId}/messages`, {
  server: false,
  default: () => []
})
watch(history, (v) => {
  messages.value = v ?? []
}, { immediate: true })

// Wire the live stream. The composable handles SSE → polling fallback; we
// just dedupe and auto-scroll on each arrival.
useThreadStream(threadIdRef, (m) => {
  const cast = m as unknown as MessageRow
  if (messages.value.find(x => x.id === cast.id)) return
  messages.value.push(cast)
  nextTick(() => {
    const last = document.getElementById(`message-${cast.id}`)
    last?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  })
})

// Group consecutive messages from the same device. When the previous message
// has the same deviceId AND was sent within a few minutes, the bubble
// suppresses its caption to reduce visual noise.
const CAPTION_GAP_MS = 5 * 60 * 1000

function shouldShowCaption(index: number): boolean {
  if (index === 0) return true
  const prev = messages.value[index - 1]
  const cur = messages.value[index]
  if (!prev || !cur || prev.deviceId !== cur.deviceId) return true
  const prevMs = prev.createdAt instanceof Date ? prev.createdAt.getTime() : Number(prev.createdAt)
  const curMs = cur.createdAt instanceof Date ? cur.createdAt.getTime() : Number(cur.createdAt)
  return Math.abs(curMs - prevMs) > CAPTION_GAP_MS
}
</script>

<template>
  <div class="flex-1 overflow-y-auto px-4 py-3">
    <template v-for="(m, i) in messages" :key="m.id">
      <ClipboardMessageBubble
        :message="m"
        :current-device-id="currentDeviceId ?? null"
        :show-caption="shouldShowCaption(i)"
        :class="shouldShowCaption(i) ? 'mt-4 first:mt-0' : 'mt-0.5'"
      />
    </template>
    <div
      v-if="!messages.length"
      class="h-full flex flex-col items-center justify-center text-center gap-2 text-muted"
    >
      <UIcon name="i-lucide-clipboard-paste" class="size-10 text-dimmed" />
      <p class="text-sm">
        Nothing yet. Paste, type, or drop a file below.
      </p>
    </div>
  </div>
</template>
