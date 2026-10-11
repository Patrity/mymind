<script setup lang="ts">
// Shown after a few failed reconnects of the chat socket (cycle 81 Task 6): the turn on screen
// keeps running in the agent worker and resumes once the socket is back.
defineProps<{ show: boolean }>()
</script>

<template>
  <UAlert
    v-if="show"
    color="neutral"
    variant="subtle"
    icon="i-lucide-loader-circle"
    title="Reconnecting…"
    description="Lost the connection to the server. Anything running keeps going and shows up here once it is back."
    class="rounded-none"
    :ui="{ icon: 'animate-spin' }"
    data-testid="reconnecting"
  />
</template>
