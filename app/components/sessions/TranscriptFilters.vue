<script setup lang="ts">
import { refDebounced } from '@vueuse/core'
import type { SessionMessageFilters } from '~~/shared/types/session'

const model = defineModel<SessionMessageFilters>({ required: true })
const props = defineProps<{ toolNames: string[] }>()

// Every keystroke is a new query key and a round trip, so the text box is debounced.
const text = ref(model.value.q ?? '')
const debounced = refDebounced(text, 300)
watch(debounced, (v) => {
  // Replace the object wholesale: `useSessions` reads the filters through `toValue`, which does
  // NOT unwrap a plain reactive object — mutating a property in place would never refetch.
  model.value = { ...model.value, q: v || undefined }
})

// reka-ui's USelectMenu throws on an empty-string item value (it takes the whole popover down),
// so "All tools" carries a sentinel rather than ''.
const ALL = '__all__'
const toolItems = computed(() => [
  { label: 'All tools', value: ALL },
  ...props.toolNames.map(n => ({ label: n, value: n }))
])
const tool = computed({
  get: () => model.value.tool ?? ALL,
  set: (v: string) => { model.value = { ...model.value, tool: v === ALL ? undefined : v } }
})
const hideSidechain = computed({
  get: () => !!model.value.hideSidechain,
  set: (v: boolean) => { model.value = { ...model.value, hideSidechain: v || undefined } }
})
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 pb-2 shrink-0">
    <UInput
      v-model="text"
      placeholder="Find in session…"
      icon="i-lucide-search"
      size="sm"
      class="w-56"
      data-transcript-q
    />
    <USelectMenu
      v-if="toolNames.length"
      v-model="tool"
      :items="toolItems"
      value-key="value"
      size="sm"
      class="w-44"
      data-transcript-tool
    />
    <USwitch
      v-model="hideSidechain"
      label="Hide subagent"
      size="sm"
      data-transcript-sidechain
    />
  </div>
</template>
