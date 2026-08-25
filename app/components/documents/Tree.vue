<script setup lang="ts">
import type { TreeNode } from '~~/server/services/tree'
import type { ContextMenuItem } from '@nuxt/ui'
import type { FolderColorSource } from '~~/shared/types/folders'
import { collectFolderPaths } from '~/lib/documents/folder-list'
import { basenameOf } from '~/composables/useDocumentTree'

interface TreeItem {
  id: string
  label: string
  path: string
  nodeType: 'file' | 'folder'
  icon?: string
  defaultExpanded?: boolean
  children?: TreeItem[]
  color?: string | null
  colorSource?: FolderColorSource | null
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
const { move } = useDocuments()

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
        color: n.color ?? null,
        colorSource: n.colorSource ?? null,
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

// ---- helpers ----

const allFolders = computed(() => collectFolderPaths(props.tree))

const {
  promptRename,
  promptMove,
  promptDelete,
  confirmDelete,
  shareDoc,
  retriageDoc,
  renameState,
  moveState,
  deleteState,
  deleteLoading
} = useDocumentTree(() => emit('refresh'))

// ---- Context menu items ----
function contextMenuItems(item: TreeItem): ContextMenuItem[][] {
  return [
    [
      {
        label: 'Rename',
        icon: 'i-lucide-pencil',
        onSelect: () => promptRename(item.id, item.path, item.label)
      },
      {
        label: 'Move',
        icon: 'i-lucide-folder-input',
        onSelect: () => promptMove(item.id, item.path, item.label)
      }
    ],
    [
      {
        label: 'Share / Copy link',
        icon: 'i-lucide-link',
        onSelect: () => shareDoc(item.id)
      },
      // Only meaningful for the inbox — see retriageDoc's note.
      ...(item.nodeType === 'file' && item.path.startsWith('/input/')
        ? [{
            label: 'Re-triage',
            icon: 'i-lucide-refresh-cw',
            onSelect: () => retriageDoc(item.id, item.label)
          }]
        : [])
    ],
    [
      {
        label: 'Delete',
        icon: 'i-lucide-trash-2',
        color: 'error' as const,
        onSelect: () => promptDelete(item.id, item.path, item.label)
      }
    ]
  ]
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

// ---- Drag-and-drop ----

/** Currently dragged file; shared across all recursive tree instances */
const draggedFile = ref<{ id: string; path: string } | null>(null)

/** Path of the folder currently being hovered during a drag */
const dropTargetPath = ref<string | null>(null)

function onDragStart(e: DragEvent, item: TreeItem) {
  draggedFile.value = { id: item.id, path: item.path }
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/mymind-file', JSON.stringify({ id: item.id, path: item.path }))
  }
}

function onDragEnd() {
  draggedFile.value = null
  dropTargetPath.value = null
}

function onFolderDragOver(e: DragEvent, folderPath: string) {
  // Only highlight if we have a file being dragged (intra-tree)
  if (!draggedFile.value) return
  e.preventDefault()
  dropTargetPath.value = folderPath
}

function onFolderDragLeave(folderPath: string) {
  if (dropTargetPath.value === folderPath) {
    dropTargetPath.value = null
  }
}

async function onFolderDrop(e: DragEvent, folderPath: string) {
  e.stopPropagation() // prevent bubbling to ancestor folder drop handlers
  dropTargetPath.value = null

  const file = draggedFile.value
  draggedFile.value = null

  if (!file) return

  const base = basenameOf(file.path)
  const dest = folderPath === '/' ? '/' + base : folderPath + '/' + base

  // Same folder — no-op
  if (dest === file.path) return

  try {
    await move(file.id, dest)
    toast.add({ color: 'success', title: 'Moved', description: `"${base}" → ${folderPath}` })
    emit('refresh')
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }; message?: string }
    toast.add({
      color: 'error',
      title: "Couldn't move",
      description: err.data?.statusMessage ?? err.message ?? 'Name collision?'
    })
  }
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
          <!-- File nodes get context menu + draggable -->
          <UContextMenu
            v-if="item.nodeType === 'file'"
            :items="contextMenuItems(item)"
          >
            <div
              draggable="true"
              class="w-full cursor-grab active:cursor-grabbing"
              @dragstart="onDragStart($event, item)"
              @dragend="onDragEnd"
            >
              <DocumentsTreeRow
                :item="item"
                :expanded="expanded"
                :selected="selectedId === item.id"
              />
            </div>
          </UContextMenu>

          <!-- Folder row — drop target. Context menu is empty for now; Task 10 fills it. -->
          <UContextMenu
            v-else
            :items="[]"
          >
            <div
              class="w-full rounded transition-colors"
              :class="dropTargetPath === item.path ? 'bg-primary/20 ring-1 ring-primary/40' : ''"
              @dragover="onFolderDragOver($event, item.path)"
              @dragleave="onFolderDragLeave(item.path)"
              @drop.stop="onFolderDrop($event, item.path)"
            >
              <DocumentsTreeRow
                :item="item"
                :expanded="expanded"
                :selected="selectedId === item.id"
              />
            </div>
          </UContextMenu>
        </template>
      </UTree>
    </div>

    <!-- Delete confirmation modal -->
    <UModal v-model:open="deleteState.open">
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
            Delete <strong>{{ deleteState.target?.label }}</strong>? This cannot be undone.
          </p>

          <template #footer>
            <div class="flex justify-end gap-2">
              <UButton
                color="neutral"
                variant="ghost"
                @click="deleteState.open = false"
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

    <!-- Rename modal -->
    <DocumentsRenameModal
      :target="renameState.target"
      :open="renameState.open"
      @update:open="renameState.open = $event"
      @done="emit('refresh')"
    />

    <!-- Move modal -->
    <DocumentsMoveModal
      :target="moveState.target"
      :open="moveState.open"
      :folders="allFolders"
      @update:open="moveState.open = $event"
      @done="emit('refresh')"
    />
  </div>
</template>
