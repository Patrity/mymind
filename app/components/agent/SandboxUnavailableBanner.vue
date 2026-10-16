<script setup lang="ts">
// "Workspace unavailable" (cycle 82 final review I6 / cycle 86): the agent worker is up but its
// workspace health check failed (the workspaces dir is not writable, or the Mac is low on disk).
// Workspace tools refuse until it is fixed;
// nothing else is affected.
const { sandboxProblem } = useWorkerStatus()
</script>

<template>
  <UAlert
    v-if="sandboxProblem"
    color="warning"
    variant="subtle"
    icon="i-lucide-box"
    :title="`Workspace unavailable: ${sandboxProblem}`"
    description="Bridget's workspace tools (files, bash, watches) may be refused until this is fixed — everything else works."
    class="rounded-none"
    data-testid="sandbox-unavailable"
  />
</template>
