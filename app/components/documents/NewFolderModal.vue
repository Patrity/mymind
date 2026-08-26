<script setup lang="ts">
const props = defineProps<{
  open: boolean
  /** Folder to create under — the folder that was right-clicked, or '/' from the root menu. */
  parentPath: string | null
}>()

const emit = defineEmits<{ 'update:open': [boolean], done: [] }>()

const toast = useToast()
const createFolder = useCreateFolderMutation()

const name = ref('')
const creating = ref(false)

// Reset on each open so a previous attempt never leaks into the next one.
watch(() => props.open, (isOpen) => {
  if (!isOpen) return
  name.value = ''
})

// The path the user is about to create, shown live under the field — same reassurance
// NewDocumentModal gives for a two-field path.
const finalPath = computed(() => {
  const n = name.value.trim()
  if (!n || !props.parentPath) return ''
  return props.parentPath === '/' ? `/${n}` : `${props.parentPath}/${n}`
})

async function submit() {
  if (!finalPath.value) return
  creating.value = true
  try {
    const folder = await createFolder.mutateAsync({ path: finalPath.value })
    // Defend against the known repo-wide trap: an unmatched relative route resolves to the SPA
    // shell with a 200, which ofetch does not throw on. A real create always answers a folder
    // with a real id — anything else is treated as failure, never reported as a success toast.
    if (!folder?.id || !folder?.path) {
      throw new Error('The server did not confirm the folder was created')
    }
    // No success toast (Task 17 toast discipline): the new folder's row appears in the tree,
    // which is the visible result.
    emit('update:open', false)
    emit('done')
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: "Couldn't create folder", description: err.data?.statusMessage ?? err.message })
  } finally {
    creating.value = false
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
              name="i-lucide-folder-plus"
              class="size-5"
            />
            <span class="font-semibold">New folder</span>
          </div>
        </template>

        <UFormField
          label="Folder name"
          :description="parentPath ? `In: ${parentPath}` : undefined"
        >
          <UInput
            v-model="name"
            autofocus
            class="w-full font-mono text-sm"
            placeholder="folder-name"
            @keyup.enter="submit"
          />
        </UFormField>

        <p class="text-xs text-dimmed font-mono truncate mt-2">
          {{ finalPath || '—' }}
        </p>

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
              :loading="creating"
              :disabled="!finalPath"
              @click="submit"
            >
              Create
            </UButton>
          </div>
        </template>
      </UCard>
    </template>
  </UModal>
</template>
