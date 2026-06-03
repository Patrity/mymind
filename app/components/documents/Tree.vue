<script setup lang="ts">
import type { TreeNode } from '~~/server/services/tree'

interface TreeItem {
  id: string
  label: string
  path: string
  nodeType: 'file' | 'folder'
  icon?: string
  defaultExpanded?: boolean
  children?: TreeItem[]
}

const props = defineProps<{
  tree: TreeNode[]
  selectedId?: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
  refresh: []
}>()

const toast = useToast()
const { remove } = useDocuments()

function getFileIcon(name: string): string {
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'i-lucide-file-text'
  if (name.endsWith('.json')) return 'i-lucide-file-json'
  if (name.endsWith('.yaml') || name.endsWith('.yml')) return 'i-lucide-file-code'
  if (name.endsWith('.sql')) return 'i-lucide-database'
  if (name.endsWith('.ts') || name.endsWith('.js')) return 'i-lucide-file-code-2'
  return 'i-lucide-file'
}

function toTreeItems(nodes: TreeNode[]): TreeItem[] {
  return nodes.map((n) => {
    if (n.type === 'folder') {
      return {
        id: n.path,
        label: n.name,
        path: n.path,
        nodeType: 'folder',
        defaultExpanded: true,
        children: n.children ? toTreeItems(n.children) : []
      }
    }
    return {
      id: n.id ?? n.path,
      label: n.title || n.name,
      path: n.path,
      nodeType: 'file',
      icon: getFileIcon(n.name)
    }
  })
}

const treeItems = computed(() => toTreeItems(props.tree))

const expandedKeys = useCookie<string[]>('mm.documents.expanded', {
  default: () => [],
  maxAge: 60 * 60 * 24 * 365,
  watch: 'shallow'
})

// Seed top-level folders as expanded on first visit
const topLevelFolders = computed(() =>
  props.tree.filter(n => n.type === 'folder').map(n => n.path)
)
watch(topLevelFolders, (dirs) => {
  if (expandedKeys.value.length === 0 && dirs.length) {
    expandedKeys.value = [...dirs]
  }
}, { immediate: true })

// Delete confirmation modal
const showDeleteModal = ref(false)
const deleteTarget = ref<{ id: string, label: string } | null>(null)
const deleteLoading = ref(false)

function promptDelete(id: string, label: string) {
  deleteTarget.value = { id, label }
  showDeleteModal.value = true
}

async function confirmDelete() {
  if (!deleteTarget.value) return
  deleteLoading.value = true
  try {
    await remove(deleteTarget.value.id)
    toast.add({ color: 'success', title: `Deleted "${deleteTarget.value.label}"` })
    showDeleteModal.value = false
    deleteTarget.value = null
    emit('refresh')
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Delete failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    deleteLoading.value = false
  }
}

function onSelect(_e: unknown, item: TreeItem) {
  if (item.nodeType === 'file') {
    emit('select', item.id)
  }
}

// Find selected item's path to highlight it
function findSelectedPath(nodes: TreeNode[], id: string | null | undefined): string | null {
  if (!id) return null
  for (const n of nodes) {
    if (n.type === 'file' && (n.id === id || n.path === id)) return n.path
    if (n.children) {
      const found = findSelectedPath(n.children, id)
      if (found) return found
    }
  }
  return null
}

function findNodeId(nodes: TreeNode[], path: string): string | null {
  for (const n of nodes) {
    if (n.type === 'file' && n.path === path) return n.id ?? null
    if (n.children) {
      const found = findNodeId(n.children, path)
      if (found) return found
    }
  }
  return null
}
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="flex-1 overflow-auto p-2">
      <div
        v-if="tree.length === 0"
        class="flex flex-col items-center justify-center py-12 text-dimmed text-sm"
      >
        <UIcon
          name="i-lucide-folder-open"
          class="size-8 mb-2 opacity-50"
        />
        <p>No documents yet.</p>
        <p class="text-xs mt-1">
          Create one to get started.
        </p>
      </div>

      <UTree
        v-else
        v-model:expanded="expandedKeys"
        :items="treeItems"
        :get-key="(item: TreeItem) => item.id"
        color="primary"
        @select="onSelect"
      >
        <template #item="{ item, expanded }">
          <div
            class="flex items-center gap-2 w-full rounded px-1 -mx-1 transition-colors group"
            :class="selectedId === item.id ? 'bg-primary/10' : ''"
          >
            <UIcon
              v-if="item.children !== undefined"
              :name="expanded ? 'i-lucide-folder-open' : 'i-lucide-folder'"
              class="size-4 shrink-0 text-dimmed"
            />
            <UIcon
              v-else-if="item.icon"
              :name="item.icon"
              class="size-4 shrink-0 text-dimmed"
            />
            <span class="truncate text-sm flex-1">{{ item.label }}</span>
            <!-- Delete button, shown on hover for files only -->
            <UButton
              v-if="item.nodeType === 'file'"
              icon="i-lucide-trash-2"
              size="xs"
              variant="ghost"
              color="error"
              class="opacity-0 group-hover:opacity-100 shrink-0"
              @click.stop="promptDelete(item.id, item.label)"
            />
          </div>
        </template>
      </UTree>
    </div>

    <!-- Delete confirmation modal -->
    <UModal v-model:open="showDeleteModal">
      <template #content>
        <UCard>
          <template #header>
            <div class="flex items-center gap-2 text-error">
              <UIcon
                name="i-lucide-trash-2"
                class="size-5"
              />
              <span class="font-semibold">Delete document</span>
            </div>
          </template>

          <p class="text-sm">
            Delete <strong>{{ deleteTarget?.label }}</strong>? This cannot be undone.
          </p>

          <template #footer>
            <div class="flex justify-end gap-2">
              <UButton
                color="neutral"
                variant="ghost"
                @click="showDeleteModal = false"
              >
                Cancel
              </UButton>
              <UButton
                color="error"
                :loading="deleteLoading"
                @click="confirmDelete"
              >
                Delete
              </UButton>
            </div>
          </template>
        </UCard>
      </template>
    </UModal>
  </div>
</template>
