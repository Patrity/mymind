<!-- app/components/voice/Transcript.vue -->
<script setup lang="ts">
import type { TranscriptEntry } from '~/composables/useVoice'

defineProps<{ entries: TranscriptEntry[] }>()
const emit = defineEmits<{ undo: [entry: TranscriptEntry] }>()
</script>

<template>
  <div class="flex flex-col gap-2 overflow-y-auto p-3">
    <div
      v-for="e in entries"
      :key="e.id"
      class="flex flex-col gap-0.5"
    >
      <!-- Inline tool chip: rendered at its true position in the stream, so the
           transcript shows WHERE in a reply each tool ran. -->
      <UBadge
        v-if="e.role === 'tool'"
        :color="e.undone ? 'neutral' : 'primary'"
        variant="subtle"
        class="gap-1 self-start"
      >
        <UIcon
          name="i-lucide-wand-2"
          class="size-3"
        />
        {{ e.summary }}
        <UButton
          v-if="e.undoToken && !e.undone"
          size="xs"
          variant="link"
          color="primary"
          icon="i-lucide-undo-2"
          @click="emit('undo', e)"
        />
        <span
          v-else-if="e.undone"
          class="text-xs text-muted"
        >undone</span>
      </UBadge>
      <template v-else>
        <span class="text-[10px] uppercase tracking-wide text-muted">{{ e.role === 'user' ? 'You' : 'Bridget' }}</span>
        <!-- Assistant replies may contain markdown — render via the shared MDC renderer.
             cache-key MUST be per-entry: streamed entries sharing a first delta otherwise
             collide on MDC's hash-of-value key and mirror each other's content.
             User turns are literal text (preserve their line breaks). -->
        <MdView
          v-if="e.role === 'assistant'"
          :source="e.text"
          :cache-key="`transcript-${e.id}`"
          class="text-highlighted"
        />
        <template v-else>
          <div
            v-if="e.attachments?.length"
            class="flex flex-wrap gap-2"
          >
            <template
              v-for="(a, ai) in e.attachments"
              :key="ai"
            >
              <img
                v-if="a.kind === 'image'"
                :src="`/api/images/${a.id}/raw`"
                :alt="a.name || 'attachment'"
                class="max-h-32 rounded-md border border-default object-cover"
              >
              <a
                v-else
                :href="`/api/agent/files/${a.id}`"
                :download="a.name || true"
                class="inline-flex items-center gap-1.5 rounded-md border border-default bg-elevated px-2 py-1 text-xs text-default hover:bg-accented"
              >
                <UIcon
                  name="i-lucide-file"
                  class="size-3.5"
                />
                <span class="truncate max-w-[12rem]">{{ a.name || 'file' }}</span>
              </a>
            </template>
          </div>
          <p class="whitespace-pre-wrap text-sm text-default">{{ e.text }}</p>
        </template>
      </template>
    </div>
  </div>
</template>
