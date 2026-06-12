<script setup lang="ts">
// Top-level message bubble. Three responsibilities:
//   1. Pick the inner component based on `kind` + (for files) MIME type.
//   2. Right/left split: messages sent from the current device land on the
//      right with a primary tint; everything else lands on the left in the
//      neutral elevated tone.
//   3. Show a "device · time" caption above each bubble (copipasta-style)
//      so the user can tell at a glance which machine produced what.
//
// The wrapping `id="message-:id"` is the anchor used by Thread.vue's
// auto-scroll on new arrivals.
interface Message {
  id: string
  deviceId: string
  deviceLabel?: string | null
  kind: 'text' | 'file'
  bodyText: string | null
  bodyHtml: string | null
  createdAt: string | Date | number
  attachment?: {
    storageKey: string
    sha256: string
    size: number
    mime: string
    originalName: string
    width: number | null
    height: number | null
  }
}
const props = withDefaults(defineProps<{
  message: Message
  currentDeviceId: string | null
  showCaption?: boolean
}>(), {
  showCaption: true
})

const isCurrent = computed(() => props.message.deviceId === props.currentDeviceId)
const isImage = computed(() => props.message.attachment?.mime?.startsWith('image/') ?? false)
const isVideo = computed(() => props.message.attachment?.mime?.startsWith('video/') ?? false)
const formattedTime = computed(() => {
  const d = props.message.createdAt instanceof Date
    ? props.message.createdAt
    : new Date(props.message.createdAt)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
})
const caption = computed(() => {
  const label = props.message.deviceLabel ?? 'Unknown device'
  return `${label} · ${formattedTime.value}`
})
</script>

<template>
  <div
    :id="`message-${props.message.id}`"
    class="flex flex-col gap-1"
    :class="isCurrent ? 'items-end' : 'items-start'"
  >
    <div v-if="props.showCaption" class="text-xs text-muted px-1">
      {{ caption }}
    </div>
    <div
      class="max-w-[80%] rounded-2xl px-3 py-2"
      :class="isCurrent ? 'bg-primary/10' : 'bg-elevated'"
    >
      <ClipboardMessageText
        v-if="props.message.kind === 'text'"
        :message="props.message"
      />
      <ClipboardMessageImage
        v-else-if="isImage && props.message.attachment"
        :attachment="props.message.attachment"
      />
      <ClipboardMessageVideo
        v-else-if="isVideo && props.message.attachment"
        :attachment="props.message.attachment"
      />
      <ClipboardMessageFile
        v-else-if="props.message.attachment"
        :attachment="props.message.attachment"
      />
    </div>
  </div>
</template>
