<script setup lang="ts">
// Image attachment renderer. Width/height come from sharp on upload
// (best-effort — null when the format can't be sniffed) and we surface them
// as the intrinsic `width`/`height` attributes so the browser reserves layout
// space and avoids CLS. The max-w-md/max-h-96 caps keep the bubble from
// blowing out the message thread on large screenshots.
//
// Image src → /api/clipboard/files/<storageKey> (MyMind auth-gated file serving).
// Hover overlay offers Copy (clipboard image item) + Download (original file).
interface AttachmentLike {
  storageKey: string
  mime: string
  originalName: string
  width: number | null
  height: number | null
}
const props = defineProps<{ attachment: AttachmentLike }>()
const url = computed(() => `/api/clipboard/files/${props.attachment.storageKey}`)
const { copyImage } = useClipboard()
</script>

<template>
  <div class="group relative inline-block">
    <img
      :src="url"
      :alt="props.attachment.originalName"
      :width="props.attachment.width ?? undefined"
      :height="props.attachment.height ?? undefined"
      loading="lazy"
      class="rounded-md max-w-md max-h-96"
    >
    <div class="absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition">
      <UButton
        size="xs"
        variant="solid"
        color="neutral"
        icon="i-lucide-copy"
        label="Copy"
        @click="copyImage(url, props.attachment.mime)"
      />
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
