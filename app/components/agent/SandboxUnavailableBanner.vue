<script setup lang="ts">
// "Sandbox unavailable" (cycle 82 final review I6): the agent worker is up but its sandbox preflight
// failed (no Docker, no image, firewall or resource limits not in place, low disk). Workspace tools
// refuse until it is fixed; nothing else is affected.
const { sandboxProblem } = useWorkerStatus()
</script>

<template>
  <UAlert
    v-if="sandboxProblem"
    color="warning"
    variant="subtle"
    icon="i-lucide-box"
    :title="`Sandbox unavailable: ${sandboxProblem}`"
    description="Bridget's workspace tools (files, bash, watches) are refused until this is fixed — everything else works."
    class="rounded-none"
    data-testid="sandbox-unavailable"
  />
</template>
