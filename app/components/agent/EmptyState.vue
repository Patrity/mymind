<!-- app/components/agent/EmptyState.vue -->
<script setup lang="ts">
const emit = defineEmits<{ pick: [prompt: string] }>()

// Drawn from the real tool surface — the page previously gave no indication that
// ~20 tools, skills and subagents sit behind it.
const starters = [
  { icon: 'i-lucide-brain', label: 'What did we work on yesterday?' },
  { icon: 'i-lucide-list-checks', label: 'What are my open tasks?' },
  { icon: 'i-lucide-globe', label: 'Research the latest on self-hosted TTS' },
  { icon: 'i-lucide-terminal', label: 'Check disk usage on the app box' }
]
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-5 px-6 py-16 text-center">
    <div class="flex flex-col gap-1.5">
      <h2 class="text-lg font-semibold text-highlighted">Bridget</h2>
      <p class="max-w-md text-sm text-muted">
        She can search your memories, documents, projects and tasks, research the web,
        generate images, and run commands on the box — and she'll ask before anything destructive.
      </p>
    </div>
    <div class="grid gap-2 sm:grid-cols-2 w-full max-w-lg">
      <UButton
        v-for="s in starters"
        :key="s.label"
        :icon="s.icon"
        :label="s.label"
        color="neutral"
        variant="outline"
        size="sm"
        class="justify-start text-left"
        @click="emit('pick', s.label)"
      />
    </div>
  </div>
</template>
