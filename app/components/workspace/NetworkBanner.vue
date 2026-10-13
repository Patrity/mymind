<script setup lang="ts">
/**
 * Cycle 82 Task 3 / cycle 86: a TAINTED workspace (it handled mail/calendar or other untrusted
 * content). With taint confinement on (Settings → Bridget) its commands run confined — no network,
 * writes only inside the workspace, no secrets — until Tony re-enables it. Re-enable goes to the
 * agent worker (it stops the workspace's tainted commands first, then clears the flag) —
 * session-only, behind a confirmation that says what he is trusting.
 */
import type { WorkspaceDTO } from '@mymind/core/shared/types/workspaces'

const props = defineProps<{ workspace: WorkspaceDTO }>()
const toast = useToast()
const open = ref(false)
const { reenable } = useWorkspaceActions()

async function confirm() {
  try {
    await reenable.mutateAsync(props.workspace.id)
    open.value = false
    toast.add({ color: 'success', title: 'Workspace re-enabled', description: 'Commands in this workspace run unconfined (network, the whole Mac, exported secrets) again.' })
  } catch (e) {
    toast.add({ color: 'error', title: 'The workspace stays confined', description: workspaceErrorOf(e) })
  }
}
</script>

<template>
  <UAlert
    v-if="workspace.tainted"
    color="warning"
    variant="subtle"
    icon="i-lucide-wifi-off"
    title="Confined (tainted)"
    :description="`This workspace handled mail, calendar or other untrusted content${workspace.taintedAt ? ` (${new Date(workspace.taintedAt).toLocaleString()})` : ''}, so its commands run confined — no network, writes only inside the workspace, no secrets, no background shells or watches (while taint confinement is on in Settings → Bridget).`"
    :actions="[{ label: 'Re-enable network', color: 'warning', variant: 'solid', icon: 'i-lucide-wifi', onClick: () => { open = true } }]"
    class="rounded-none"
    data-testid="workspace-tainted"
  />
  <UModal
    v-model:open="open"
    title="Re-enable network?"
    :description="'Trust this workspace with the internet again'"
  >
    <template #body>
      <div
        class="flex flex-col gap-3 text-sm"
        data-testid="reenable-modal"
      >
        <p>
          This workspace handled <strong>mail, calendar or other untrusted content</strong>. Files written while
          it was tainted may carry instructions or code planted in that content (git hooks, package scripts,
          a "helpful" script).
        </p>
        <p>
          Once re-enabled, its commands get the network, the whole Mac and your exported secrets again — so
          anything left in it could send what it read out. Look through its files first if you are not sure.
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          label="Keep it offline"
          color="neutral"
          variant="ghost"
          @click="open = false"
        />
        <UButton
          label="Re-enable network"
          color="warning"
          icon="i-lucide-wifi"
          :loading="reenable.isPending.value"
          data-testid="reenable-confirm"
          @click="confirm"
        />
      </div>
    </template>
  </UModal>
</template>
