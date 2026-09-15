<!-- app/components/voice/PresetRail.vue -->
<script setup lang="ts">
import type { VoicePresetDTO } from '~~/shared/types/voice-presets'
import { modeBadge } from '~/lib/voice/studio'

const props = defineProps<{
  presets: VoicePresetDTO[]
  selectedId: string
  loading?: boolean
  busy?: boolean
}>()

const emit = defineEmits<{
  'select': [id: string]
  'create': []
  'duplicate': [id: string]
  'delete': [id: string]
  'make-default': [id: string]
}>()

const selected = computed(() => props.presets.find(p => p.id === props.selectedId) ?? null)

// Inline confirm rather than a modal — same pattern the memories list uses, and one
// fewer overlay to fight in a browser test.
const confirmingDelete = ref(false)
watch(() => props.selectedId, () => {
  confirmingDelete.value = false
})

/** The calibrated ceiling is only worth showing when it is BELOW the 200-char default:
 *  that means a reference clip ate into the prompt budget, which is the number that
 *  explains why a long paragraph stops early. 200 is just "not calibrated yet". */
function cap(p: VoicePresetDTO): number | null {
  return p.maxSegmentChars < 200 ? p.maxSegmentChars : null
}
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <div class="p-2 border-b border-default">
      <UButton
        block
        icon="i-lucide-plus"
        label="New voice"
        size="sm"
        color="neutral"
        variant="soft"
        :disabled="props.busy"
        @click="emit('create')"
      />
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-1">
      <p
        v-if="props.loading"
        class="px-2 py-4 text-xs text-muted"
      >
        <UIcon
          name="i-lucide-loader-2"
          class="inline size-3 animate-spin"
        /> Loading voices…
      </p>

      <p
        v-else-if="!props.presets.length"
        class="px-2 py-4 text-xs text-muted"
      >
        No voices yet. Create one to get started.
      </p>

      <UButton
        v-for="p in props.presets"
        :key="p.id"
        block
        :color="p.id === props.selectedId ? 'primary' : 'neutral'"
        :variant="p.id === props.selectedId ? 'soft' : 'ghost'"
        class="text-left"
        @click="emit('select', p.id)"
      >
        <div class="flex flex-col gap-1 w-full min-w-0">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="text-sm truncate grow">{{ p.name }}</span>
            <UIcon
              v-if="p.isDefault"
              name="i-lucide-star"
              class="size-3 shrink-0 text-primary"
            />
          </div>
          <div class="flex items-center gap-1.5">
            <UBadge
              size="sm"
              variant="subtle"
              :color="modeBadge(p).color"
              :label="modeBadge(p).label"
            />
            <!-- Calibrated ceiling, shown only when a reference clip pulled it below the
                 200-char default: it is the number that explains a render stopping early. -->
            <span
              v-if="cap(p)"
              class="text-[10px] tabular-nums text-dimmed"
            >{{ cap(p) }} char cap</span>
          </div>
        </div>
      </UButton>
    </div>

    <div class="p-2 border-t border-default flex flex-col gap-1">
      <template v-if="confirmingDelete && selected">
        <span class="px-1 text-xs text-muted">Delete “{{ selected.name }}”?</span>
        <div class="flex gap-1">
          <UButton
            block
            size="xs"
            color="neutral"
            variant="ghost"
            label="Cancel"
            @click="confirmingDelete = false"
          />
          <UButton
            block
            size="xs"
            color="error"
            label="Confirm"
            :loading="props.busy"
            @click="emit('delete', selected.id); confirmingDelete = false"
          />
        </div>
      </template>

      <template v-else>
        <UButton
          block
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-copy"
          label="Duplicate"
          :disabled="!selected || props.busy"
          @click="selected && emit('duplicate', selected.id)"
        />
        <UButton
          block
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-star"
          label="Make default"
          :disabled="!selected || selected.isDefault || props.busy"
          @click="selected && emit('make-default', selected.id)"
        />
        <!-- Disabled on the default: the server refuses it outright (the agent resolves
             every turn's voice through the default row), so offering it would only
             produce an error toast. -->
        <UButton
          block
          size="xs"
          color="error"
          variant="ghost"
          icon="i-lucide-trash-2"
          label="Delete"
          :disabled="!selected || selected.isDefault || props.busy"
          @click="confirmingDelete = true"
        />
        <p
          v-if="selected?.isDefault"
          class="px-1 text-[10px] text-dimmed"
        >
          The default voice can't be deleted — make another one the default first.
        </p>
      </template>
    </div>
  </div>
</template>
