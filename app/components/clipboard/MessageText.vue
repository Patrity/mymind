<script setup lang="ts">
// Renders a text message's body. If the producer captured a `bodyHtml` (e.g.
// rich paste from Google Docs), we render that — it's already been sanitized
// on write. Otherwise we render `bodyText` through the MDC markdown pipeline
// so plain pastes still get headings, lists, code blocks.
//
// Adapted from copipasta: uses MyMind's MdView component for plain-text
// rendering (MDC-based) instead of copipasta's marked+sanitize pipeline.
// For bodyHtml we still sanitize client-side via isomorphic-dompurify.
//
// CopyButtons live in an absolutely-positioned overlay that only appears on
// hover, keeping the message body uncluttered while the user is reading.
import DOMPurify from 'isomorphic-dompurify'

interface MessageLike {
  id: string
  bodyText: string | null
  bodyHtml: string | null
}
const props = defineProps<{ message: MessageLike }>()

const sanitizedHtml = computed(() => {
  if (!props.message.bodyHtml) return null
  return DOMPurify.sanitize(props.message.bodyHtml, {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick']
  })
})
</script>

<template>
  <div class="group relative">
    <!-- bodyHtml: render sanitised rich HTML directly -->
    <div
      v-if="sanitizedHtml"
      class="prose prose-sm dark:prose-invert max-w-none break-words"
      v-html="sanitizedHtml"
    />
    <!-- bodyText: render via MyMind's MDC pipeline for markdown support -->
    <MdView
      v-else
      :source="props.message.bodyText ?? ''"
    />
    <div class="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition">
      <ClipboardCopyButtons :message="props.message" />
    </div>
  </div>
</template>
