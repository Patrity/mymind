<script setup lang="ts">
import type { DocTreeTarget } from '~/composables/useDocumentTree'
import type { FolderImpact } from '~/composables/useFolders'

const props = defineProps<{
  open: boolean
  folder: DocTreeTarget | null
}>()

const emit = defineEmits<{ 'update:open': [boolean], deleted: [] }>()

const toast = useToast()
const { impact: fetchImpact } = useFolders()
const deleteFolder = useDeleteFolderMutation()

// `impact()` reports `foldersInside` — what the folder CONTAINS, excluding itself — which is
// exactly right for a preview shown before the delete happens (see useFolders.ts's comment on
// why this is deliberately not the same field `remove()` returns).
const impact = ref<FolderImpact | null>(null)
const impactLoading = ref(false)
const impactError = ref(false)
const deleting = ref(false)

async function loadImpact() {
  if (!props.folder) return
  impactLoading.value = true
  impactError.value = false
  try {
    impact.value = await fetchImpact(props.folder.id)
  } catch {
    // Fail CLOSED: a failed check leaves `impact` null and `impactError` true — the template
    // swaps the Delete button for a Retry button (below) rather than showing zeros or letting
    // an irreversible bulk soft-delete proceed with the user shown nothing about its contents.
    impact.value = null
    impactError.value = true
  } finally {
    impactLoading.value = false
  }
}

watch(() => props.open, (isOpen) => {
  impact.value = null
  impactError.value = false
  if (!isOpen || !props.folder) return
  loadImpact()
})

const isEmpty = computed(() =>
  !!impact.value && impact.value.documents === 0 && impact.value.foldersInside === 0)

// The count on the button is the document count — the number a user approving an irreversible
// bulk soft-delete most needs to see at the moment they press it. Falls back to the sub-folder
// count when there are no documents but the folder isn't empty (nested empty folders only), and
// to a plain label once we know there's nothing here at all.
const confirmLabel = computed(() => {
  if (!impact.value) return 'Delete'
  const { documents, foldersInside } = impact.value
  if (documents > 0) return `Delete ${documents} document${documents === 1 ? '' : 's'}`
  if (foldersInside > 0) return `Delete ${foldersInside} sub-folder${foldersInside === 1 ? '' : 's'}`
  return 'Delete folder'
})

async function confirmDelete() {
  if (!props.folder) return
  // Fail CLOSED: never delete without having successfully shown what it contains. The template
  // already swaps this action out for a Retry button while `impactError` is set, but this holds
  // even if that ever gets out of sync.
  if (!impact.value) return
  deleting.value = true
  try {
    // `remove()` returns `foldersDeleted`, which INCLUDES the folder itself — the right count
    // to report back as "what actually happened", as distinct from the pre-delete preview's
    // `foldersInside` above.
    const result = await deleteFolder.mutateAsync({ id: props.folder.id, path: props.folder.path })
    // Defend against the known repo-wide trap: an unmatched relative route resolves to the SPA
    // shell with a 200, which ofetch does not throw on. A real DELETE always answers numeric
    // counts — anything else is treated as failure, never reported as a success toast.
    if (!result || typeof result.foldersDeleted !== 'number') {
      throw new Error('The server did not confirm the folder delete')
    }
    toast.add({
      color: 'success',
      title: `Deleted "${props.folder.label}"`,
      description: result.documents > 0
        ? `${result.documents} document${result.documents === 1 ? '' : 's'} soft-deleted, ${result.foldersDeleted} folder${result.foldersDeleted === 1 ? '' : 's'} removed.`
        : `${result.foldersDeleted} folder${result.foldersDeleted === 1 ? '' : 's'} removed.`
    })
    emit('update:open', false)
    emit('deleted')
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Delete failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <UModal
    :open="open"
    @update:open="emit('update:open', $event)"
  >
    <template #content>
      <UCard>
        <template #header>
          <div class="flex items-center gap-2 text-error">
            <UIcon
              name="i-lucide-trash-2"
              class="size-5"
            />
            <span class="font-semibold">Delete folder</span>
          </div>
        </template>

        <p class="text-sm">
          Delete <strong class="font-mono">{{ folder?.path }}</strong>?
        </p>

        <p
          v-if="impactLoading"
          class="text-sm text-dimmed mt-2"
        >
          Checking contents…
        </p>
        <UAlert
          v-else-if="impactError"
          color="error"
          icon="i-lucide-triangle-alert"
          title="Couldn't check this folder's contents"
          description="We don't know what this would remove — try the check again before deleting."
          class="mt-2"
        />
        <template v-else-if="impact">
          <p
            v-if="!isEmpty"
            class="text-sm text-warning mt-2"
          >
            {{ impact.documents }} document{{ impact.documents === 1 ? '' : 's' }}
            and {{ impact.foldersInside }} sub-folder{{ impact.foldersInside === 1 ? '' : 's' }} will be deleted.
            Documents are soft-deleted and can be restored.
          </p>
          <p
            v-else
            class="text-sm text-muted mt-2"
          >
            This folder is empty.
          </p>
        </template>

        <template #footer>
          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              @click="emit('update:open', false)"
            >
              Cancel
            </UButton>
            <!-- Fail CLOSED: a failed contents check swaps Delete out for Retry entirely, rather
                 than leaving the destructive action clickable once `impactLoading` clears. -->
            <UButton
              v-if="impactError"
              color="neutral"
              :loading="impactLoading"
              @click="loadImpact"
            >
              Retry
            </UButton>
            <UButton
              v-else
              color="error"
              :loading="deleting"
              :disabled="impactLoading || !impact"
              @click="confirmDelete"
            >
              {{ confirmLabel }}
            </UButton>
          </div>
        </template>
      </UCard>
    </template>
  </UModal>
</template>
