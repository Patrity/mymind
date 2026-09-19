<script setup lang="ts">
import type { FileUIPart } from 'ai'
defineProps<{ part: FileUIPart }>()
</script>

<template>
  <img
    v-if="part.mediaType.startsWith('image/')"
    :src="part.url"
    :alt="part.filename || 'attachment'"
    class="max-h-32 rounded-md border border-default object-cover"
  >
  <a
    v-else
    :href="part.url"
    :download="part.filename || true"
    class="inline-flex items-center gap-1.5 rounded-md border border-default bg-elevated px-2 py-1 text-xs text-default hover:bg-accented"
  >
    <UIcon name="i-lucide-file" class="size-3.5" />
    <span class="truncate max-w-[12rem]">{{ part.filename || 'file' }}</span>
  </a>
</template>
