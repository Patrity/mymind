<script setup lang="ts">
/**
 * Cycle 86 (option C): a TAINTED workspace (it handled mail/calendar or other untrusted content). Its
 * commands run like any other — the taint is bookkeeping: a run that reads from it is treated as
 * having read untrusted content, so its outbound tools ask for approval. Nothing to re-enable.
 */
import type { WorkspaceDTO } from '@mymind/core/shared/types/workspaces'

defineProps<{ workspace: WorkspaceDTO }>()
</script>

<template>
  <UAlert
    v-if="workspace.tainted"
    color="neutral"
    variant="subtle"
    icon="i-lucide-mail-warning"
    title="Handled untrusted content"
    :description="`This workspace handled mail, calendar or other untrusted content${workspace.taintedAt ? ` (${new Date(workspace.taintedAt).toLocaleString()})` : ''}. Bridget's commands here run normally; a run that reads from it is treated as having read untrusted content, so its outbound tools ask for your approval.`"
    class="rounded-none"
    data-testid="workspace-tainted"
  />
</template>
