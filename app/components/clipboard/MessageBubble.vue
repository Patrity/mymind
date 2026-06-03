<script setup lang="ts">
// Top-level message bubble. Three responsibilities:
//   1. Pick the inner component based on `kind` + (for files) MIME type.
//   2. Right/left split: messages sent from the current device land on the
//      right with a primary tint; everything else lands on the left in the
//      neutral elevated tone.
//   3. Show a "time" caption above each bubble (simplified from copipasta:
//      no device list needed — single-user, device label omitted).
//
// The wrapping `id="message-:id"` is the anchor used by Thread.vue's
// auto-scroll on new arrivals.
interface Message {
  id: string
  deviceId: string
  kind: 'text' | 'file'
  bodyText: string | null
  bodyHtml: string | null
  createdAt: string | Date | number
  attachment?: {
    storageKey: string
    sha256: string
    size: number
    mimeType: string
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
const isImage = computed(() => props.message.attachment?.mimeType?.startsWith('image/') ?? false)
const formattedTime = computed(() => {
  const d = props.message.createdAt instanceof Date
    ? props.message.createdAt
    : new Date(props.message.createdAt)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
})
</script>

<template>
  <div
    :id="`message-${props.message.id}`"
    class="flex flex-col gap-1"
    :class="isCurrent ? 'items-end' : 'items-start'"
  >
    <div v-if="props.showCaption" class="text-xs text-muted px-1">
      {{ formattedTime }}
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
      <ClipboardMessageFile
        v-else-if="props.message.attachment"
        :attachment="props.message.attachment"
      />
    </div>
  </div>
</template>
