<!-- app/components/voice/Transcript.vue -->
<script setup lang="ts">
import type { TranscriptEntry } from '~/composables/useVoice'
import type { ToolChip } from '~/composables/useAgentActivity'

defineProps<{ entries: TranscriptEntry[], chips: ToolChip[] }>()
const emit = defineEmits<{ undo: [chip: ToolChip] }>()
</script>

<template>
  <div class="flex flex-col gap-3 overflow-y-auto p-4">
    <div
      v-for="(e, i) in entries"
      :key="i"
      class="flex flex-col gap-0.5"
    >
      <span class="text-xs uppercase tracking-wide text-muted">{{ e.role === 'user' ? 'You' : 'MyMind' }}</span>
      <p
        class="text-sm"
        :class="e.role === 'user' ? 'text-default' : 'text-highlighted'"
      >
        {{ e.text }}
      </p>
    </div>

    <div
      v-if="chips.length"
      class="flex flex-wrap gap-2 pt-2"
    >
      <UBadge
        v-for="(c, i) in chips"
        :key="i"
        :color="c.undone ? 'neutral' : 'primary'"
        variant="subtle"
        class="gap-1"
      >
        <UIcon
          name="i-lucide-wand-2"
          class="size-3"
        />
        {{ c.summary }}
        <UButton
          v-if="c.undoToken && !c.undone"
          size="xs"
          variant="link"
          color="primary"
          icon="i-lucide-undo-2"
          @click="emit('undo', c)"
        />
        <span
          v-else-if="c.undone"
          class="text-xs text-muted"
        >undone</span>
      </UBadge>
    </div>
  </div>
</template>
