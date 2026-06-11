<script setup lang="ts">
// Generic file attachment card. Used for any non-image attachment, or any
// attachment whose MIME type doesn't start with `image/`. The download is a
// link to `/api/clipboard/files/[storageKey]` (auth-gated), with the `download`
// attribute preserving the original filename on save.
interface AttachmentLike {
  storageKey: string
  size: number
  mime: string
  originalName: string
}
const props = defineProps<{ attachment: AttachmentLike }>()
const url = computed(() => `/api/clipboard/files/${props.attachment.storageKey}`)

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <div class="flex items-center gap-3 p-3 rounded-md bg-elevated min-w-0">
    <UIcon
      name="i-lucide-file"
      class="text-muted shrink-0 size-8"
    />
    <div class="min-w-0 flex-1">
      <p class="text-sm text-highlighted truncate">
        {{ props.attachment.originalName }}
      </p>
      <p class="text-xs text-muted">
        {{ formatBytes(props.attachment.size) }} · {{ props.attachment.mime }}
      </p>
    </div>
    <UButton
      :to="url"
      :download="props.attachment.originalName"
      external
      icon="i-lucide-download"
      size="xs"
      variant="ghost"
      color="neutral"
    />
  </div>
</template>
