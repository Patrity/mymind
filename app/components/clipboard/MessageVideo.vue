<script setup lang="ts">
// Video attachment renderer. Mirrors MessageImage sizing. Serves the original
// from /api/clipboard/files/<storageKey> (auth-gated). Native controls; the
// hover Download button preserves the original filename.
interface AttachmentLike {
  storageKey: string
  mime: string
  originalName: string
}
const props = defineProps<{ attachment: AttachmentLike }>()
const url = computed(() => `/api/clipboard/files/${props.attachment.storageKey}`)
</script>

<template>
  <div class="group relative inline-block">
    <video
      :src="url"
      controls
      preload="metadata"
      class="rounded-md max-w-md max-h-96"
    />
    <div class="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition">
      <UButton
        :to="url"
        :download="props.attachment.originalName"
        external
        size="xs"
        variant="solid"
        color="neutral"
        icon="i-lucide-download"
      />
    </div>
  </div>
</template>
