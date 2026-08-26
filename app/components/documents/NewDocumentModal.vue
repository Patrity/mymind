<script setup lang="ts">
import type { TreeNode } from '~~/server/services/tree'
import { collectFolderPaths } from '~/lib/documents/folder-list'

const props = defineProps<{
  open: boolean
  tree: TreeNode[]
  /** Folder to preselect — the open document's folder, or the folder that was right-clicked. */
  defaultFolder?: string
}>()

const emit = defineEmits<{ 'update:open': [boolean], created: [id: string] }>()

const toast = useToast()
const createDocument = useCreateDocumentMutation()

const folder = ref('/')
const filename = ref('untitled.md')
const creating = ref(false)

const folders = computed(() => collectFolderPaths(props.tree))

// The path the user is about to create, shown live under the fields. Typing a full path by
// hand was the whole complaint — this is the reassurance that the two fields add up.
const finalPath = computed(() => {
  const name = filename.value.trim()
  if (!name) return ''
  return folder.value === '/' ? `/${name}` : `${folder.value}/${name}`
})

// Reset on each open so a previous attempt never leaks into the next one.
watch(() => props.open, (isOpen) => {
  if (!isOpen) return
  folder.value = props.defaultFolder && folders.value.includes(props.defaultFolder)
    ? props.defaultFolder
    : '/'
  filename.value = 'untitled.md'
})

async function submit() {
  if (!finalPath.value) return
  creating.value = true
  try {
    const doc = await createDocument.mutateAsync({ body: { path: finalPath.value } })
    emit('created', doc.id)
    emit('update:open', false)
    toast.add({ color: 'success', title: 'Document created', description: doc.path })
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Create failed', description: err.data?.statusMessage ?? err.message })
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
              name="i-lucide-file-plus"
              class="size-5"
            />
            <span class="font-semibold">New document</span>
          </div>
        </template>

        <div class="space-y-3">
          <UFormField label="Folder">
            <USelectMenu
              v-model="folder"
              :items="folders"
              class="w-full font-mono text-sm"
              placeholder="Select a folder"
            />
          </UFormField>

          <UFormField label="Filename">
            <UInput
              v-model="filename"
              autofocus
              class="w-full font-mono text-sm"
              placeholder="untitled.md"
              @keyup.enter="submit"
            />
          </UFormField>

          <p class="text-xs text-dimmed font-mono truncate">
            {{ finalPath || '—' }}
          </p>
        </div>

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
