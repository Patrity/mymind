<script setup lang="ts">
import { dirnameOf } from '~/lib/documents/folder-list'
import { basenameOf, type DocTreeTarget } from '~/composables/useDocumentTree'

const props = defineProps<{
  target: DocTreeTarget | null
  open: boolean
}>()

const emit = defineEmits<{ 'update:open': [boolean], done: [] }>()

const toast = useToast()
const { update } = useDocuments()

const renameName = ref('')
const renameLoading = ref(false)

// Reset on each open so a previous attempt never leaks into the next one.
watch(() => props.open, (isOpen) => {
  if (!isOpen || !props.target) return
  renameName.value = basenameOf(props.target.path)
})

async function confirmRename() {
  if (!props.target || !renameName.value.trim()) return
  renameLoading.value = true
  const dir = dirnameOf(props.target.path)
  const newPath = dir === '/' ? '/' + renameName.value.trim() : dir + '/' + renameName.value.trim()
  try {
    await update(props.target.id, { path: newPath })
    toast.add({ color: 'success', title: `Renamed to "${renameName.value.trim()}"` })
    emit('update:open', false)
    emit('done')
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Rename failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    renameLoading.value = false
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
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-pencil"
              class="size-5"
            />
            <span class="font-semibold">Rename document</span>
          </div>
        </template>

        <UFormField label="New name">
          <UInput
            v-model="renameName"
            autofocus
            class="w-full font-mono text-sm"
            placeholder="filename.md"
            @keyup.enter="confirmRename"
          />
        </UFormField>

        <template #footer>
          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              @click="emit('update:open', false)"
            >
              Cancel
            </UButton>
            <UButton
              :loading="renameLoading"
              :disabled="!renameName.trim()"
              @click="confirmRename"
            >
              Rename
            </UButton>
          </div>
        </template>
      </UCard>
    </template>
  </UModal>
</template>
