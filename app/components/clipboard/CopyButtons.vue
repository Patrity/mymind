<script setup lang="ts">
// Hover-only copy controls for a text message. Two flavours:
//   - "Copy"     → copyRich (HTML + plain fallback when html is present)
//   - "Copy raw" → copyRaw (forces plain text; only useful when html exists)
// We hide the raw button when there's no formatted version because the two
// buttons would copy identical bytes and the UI would feel redundant.
interface MessageLike {
  bodyText: string | null
  bodyHtml: string | null
}
const props = defineProps<{ message: MessageLike }>()
const { copyRich, copyRaw } = useClipboard()
const hasRich = computed(() => !!props.message.bodyHtml)
</script>

<template>
  <div class="flex gap-1">
    <UButton
      size="xs"
      variant="ghost"
      color="neutral"
      icon="i-lucide-copy"
      label="Copy"
      @click="copyRich(props.message)"
    />
    <UButton
      v-if="hasRich"
      size="xs"
      variant="ghost"
      color="neutral"
      icon="i-lucide-text"
      label="Copy raw"
      @click="copyRaw(props.message)"
    />
  </div>
</template>
