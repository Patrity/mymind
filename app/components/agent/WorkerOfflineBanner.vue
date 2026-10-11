<script setup lang="ts">
// "Agent worker offline" (cycle 81 spec §6): the worker's newest heartbeat is older than 30s. Runs
// and workstreams wait in the queue meanwhile — messages are still accepted.
const { offline, beatAt } = useWorkerStatus()
const since = computed(() => (beatAt.value ? new Date(beatAt.value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null))
</script>

<template>
  <UAlert
    v-if="offline"
    color="warning"
    variant="subtle"
    icon="i-lucide-server-off"
    title="Agent worker offline"
    :description="`Nothing runs until it is back — messages and workstreams wait in the queue.${since ? ` Last seen ${since}.` : ''}`"
    class="rounded-none"
    data-testid="worker-offline"
  />
</template>
