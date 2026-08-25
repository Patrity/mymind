<script setup lang="ts">
import { dirnameOf } from '~/lib/documents/folder-list'
import { basenameOf, type DocTreeTarget } from '~/composables/useDocumentTree'

const props = defineProps<{
  target: DocTreeTarget | null
  open: boolean
  folders: string[]
}>()

const emit = defineEmits<{ 'update:open': [boolean], done: [] }>()

const toast = useToast()
const { move } = useDocuments()

const moveDestFolder = ref('')
const moveLoading = ref(false)

// Reset on each open so a previous attempt never leaks into the next one.
watch(() => props.open, (isOpen) => {
  if (!isOpen || !props.target) return
  moveDestFolder.value = dirnameOf(props.target.path)
})

async function confirmMove() {
  if (!props.target || !moveDestFolder.value) return
  const base = basenameOf(props.target.path)
  const dest = moveDestFolder.value === '/' ? '/' + base : moveDestFolder.value + '/' + base
  // Same-folder no-op: destination equals current path — just close.
  if (dest === props.target.path) {
    emit('update:open', false)
    return
  }
  moveLoading.value = true
  try {
    await move(props.target.id, dest)
    toast.add({ color: 'success', title: `Moved to "${moveDestFolder.value}"` })
    emit('update:open', false)
    emit('done')
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Move failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    moveLoading.value = false
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
              name="i-lucide-folder-input"
              class="size-5"
            />
            <span class="font-semibold">Move document</span>
          </div>
        </template>

        <UFormField
          label="Destination folder"
          :description="target ? `Moving: ${target.label}` : ''"
        >
          <USelectMenu
            v-model="moveDestFolder"
            :items="folders"
            class="w-full font-mono text-sm"
            placeholder="Select folder"
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
              :loading="moveLoading"
              :disabled="!moveDestFolder"
              @click="confirmMove"
            >
              Move
            </UButton>
          </div>
        </template>
      </UCard>
    </template>
  </UModal>
</template>
