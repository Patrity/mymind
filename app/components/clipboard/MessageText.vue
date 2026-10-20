<script setup lang="ts">
// Renders a text message's body. If the producer captured a `bodyHtml` (e.g.
// rich paste from Google Docs), we render that — it's already been sanitized
// on write. Otherwise we render `bodyText` through the MDC markdown pipeline
// so plain pastes still get headings, lists, code blocks.
//
// Adapted from copipasta: uses MyMind's MdView component for plain-text
// rendering (MDC-based) instead of copipasta's marked+sanitize pipeline.
// bodyHtml is sanitized client-side through hardenStoredHtml (DOMPurify + the cycle-88 stored-
// content policy: no remote images, no style/srcset/ping, no iframes/embeds), not bare DOMPurify —
// DOMPurify's defaults keep <img src=remote> and style="url(…)", which load on render.
//
// CopyButtons live in an absolutely-positioned overlay that only appears on
// hover, keeping the message body uncluttered while the user is reading.
import { hardenStoredHtml } from '~/lib/markdown/stored-harden'

interface MessageLike {
  id: string
  bodyText: string | null
  bodyHtml: string | null
}
const props = defineProps<{ message: MessageLike }>()

const sanitizedHtml = computed(() => {
  if (!props.message.bodyHtml) return null
  return hardenStoredHtml(props.message.bodyHtml, { origin: useRequestURL().origin })
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
