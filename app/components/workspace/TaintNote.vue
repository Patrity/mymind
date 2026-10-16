<script setup lang="ts">
/**
 * Cycle 86 (option C): a TAINTED workspace (it handled mail/calendar or other untrusted content). Its
 * commands run like any other — the taint is bookkeeping: a run that reads from it is treated as
 * having read untrusted content, so its outbound tools ask for approval. "Mark trusted" (web session
 * only, behind a confirmation) clears the flag; a workstream's own taint is not affected.
 */
import type { WorkspaceDTO } from '@mymind/core/shared/types/workspaces'

const props = defineProps<{ workspace: WorkspaceDTO }>()
const toast = useToast()
const open = ref(false)
const { trust } = useWorkspaceActions()

async function confirm() {
  try {
    await trust.mutateAsync(props.workspace.id)
    open.value = false
    toast.add({ color: 'success', title: 'Workspace marked trusted', description: 'Runs that read from it no longer need your approval for outbound tools on its account.' })
  } catch (e) {
    toast.add({ color: 'error', title: 'The workspace stays tainted', description: workspaceErrorOf(e) })
  }
}
</script>

<template>
  <UAlert
    v-if="workspace.tainted"
    color="neutral"
    variant="subtle"
    icon="i-lucide-mail-warning"
    title="Handled untrusted content"
    :description="`This workspace handled mail, calendar or other untrusted content${workspace.taintedAt ? ` (${new Date(workspace.taintedAt).toLocaleString()})` : ''}. Bridget's commands here run normally; a run that reads from it is treated as having read untrusted content, so its outbound tools ask for your approval.`"
    :actions="[{ label: 'Mark trusted', color: 'neutral', variant: 'outline', icon: 'i-lucide-shield-check', onClick: () => { open = true } }]"
    class="rounded-none"
    data-testid="workspace-tainted"
  />
  <UModal
    v-model:open="open"
    title="Mark this workspace trusted?"
    description="Stop treating what Bridget reads here as untrusted"
  >
    <template #body>
      <div
        class="flex flex-col gap-3 text-sm"
        data-testid="trust-modal"
      >
        <p>
          This workspace handled <strong>mail, calendar or other untrusted content</strong>. Its files may still
          carry instructions planted in that content.
        </p>
        <p>
          Once trusted, <strong>runs that read this workspace will no longer need your approval for outbound
          tools</strong> (sending messages, mail, web requests on your behalf) on its account. Look through its
          files first if you are not sure. A workstream that read mail itself stays tainted.
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          label="Keep it tainted"
          color="neutral"
          variant="ghost"
          @click="open = false"
        />
        <UButton
          label="Mark trusted"
          color="primary"
          icon="i-lucide-shield-check"
          :loading="trust.isPending.value"
          data-testid="trust-confirm"
          @click="confirm"
        />
      </div>
    </template>
  </UModal>
</template>
