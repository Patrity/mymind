<!-- app/components/agent/Toolbar.vue -->
<script setup lang="ts">
defineProps<{ title: string | null; micOn: boolean }>()
const speak = defineModel<boolean>('speak', { required: true })
const model = defineModel<string>('model', { required: true })
const emit = defineEmits<{ fullBleed: []; toggleMic: []; threads: [] }>()

// Mirrors the page's sentinel: reka-ui's USelectMenu rejects an empty-string item
// value, so "no override" travels as a non-empty sentinel that the page maps back
// to an empty cookie / null model. Keep the two in step.
const DEFAULT_MODEL = '__default__'
const { draft: aiDraft } = useAiConfig()
const modelItems = computed(() => {
  const models = aiDraft.value.models
  const chain = (aiDraft.value.assignments.reasoning ?? [])
    .map(id => models.find(m => m.id === id))
    .filter((m): m is NonNullable<typeof m> => !!m)
  return [{ label: 'Default (chain order)', value: DEFAULT_MODEL }, ...chain.map(m => ({ label: m.label, value: m.id }))]
})
</script>

<template>
  <UDashboardNavbar :title="title || 'Bridget'">
    <template #leading>
      <UDashboardSidebarCollapse />
      <!-- Below lg the thread rail is hidden, so it is reached from here instead. -->
      <UButton
        icon="i-lucide-panel-left"
        variant="ghost"
        color="neutral"
        class="lg:hidden"
        aria-label="Conversations"
        @click="emit('threads')"
      />
    </template>
    <template #right>
      <!-- The wide controls collapse away under sm so the navbar cannot overflow a
           phone-width viewport and push the conversation off screen. -->
      <div class="hidden items-center gap-1.5 sm:flex">
        <USwitch
          v-model="speak"
          label="Voice replies"
          size="sm"
        />
        <USelectMenu
          v-model="model"
          :items="modelItems"
          value-key="value"
          icon="i-lucide-cpu"
          size="sm"
          class="w-44"
          aria-label="Agent model"
        />
      </div>
      <!-- Mic toggle (auto-connects if needed) -->
      <UButton
        :icon="micOn ? 'i-lucide-mic' : 'i-lucide-mic-off'"
        :color="micOn ? 'primary' : 'neutral'"
        :variant="micOn ? 'soft' : 'ghost'"
        :aria-label="micOn ? 'Disable microphone' : 'Enable microphone'"
        @click="emit('toggleMic')"
      />
      <UButton
        icon="i-lucide-maximize-2"
        variant="ghost"
        color="neutral"
        aria-label="Full-screen voice mode"
        @click="emit('fullBleed')"
      />
      <!-- Voice settings live here as a self-contained slideover (it owns its own
           cog trigger), passed in by the page so this component stays voice-agnostic. -->
      <slot name="actions" />
    </template>
  </UDashboardNavbar>
</template>
