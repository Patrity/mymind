<script setup lang="ts">
const q = ref('')

// Navigates only — it never sends. See the agent page change below.
function ask() {
  const query = q.value.trim()
  if (!query) return
  navigateTo({ path: '/agent', query: { q: query } })
}
</script>

<template>
  <UCard>
    <UInput
      v-model="q"
      icon="i-lucide-sparkles"
      placeholder="Ask about anything you've saved…"
      aria-label="Ask about anything you've saved…"
      class="w-full"
      @keydown.enter="ask"
    />
  </UCard>
</template>
