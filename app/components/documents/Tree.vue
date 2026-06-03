<script setup lang="ts">
import type { TreeNode } from '~~/server/services/tree'
import type { ContextMenuItem } from '@nuxt/ui'

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
const { get, remove, update, move, share } = useDocuments()

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

// ---- helpers ----

function dirOf(path: string): string {
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.length ? '/' + parts.join('/') : '/'
}

function basenameOf(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/** Collect all folder paths from the tree recursively */
function collectFolders(nodes: TreeNode[], acc: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === 'folder') {
      acc.push(n.path || '/')
      if (n.children) collectFolders(n.children, acc)
    }
  }
  return acc
}

const allFolders = computed(() => collectFolders(props.tree))

async function copyText(text: string) {
  if (window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch { /* fall through */ }
  }
  // Legacy fallback
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '-9999px'
  document.body.appendChild(ta)
  ta.select()
  ta.setSelectionRange(0, text.length)
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  document.body.removeChild(ta)
  return ok
}

// ---- Delete ----
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

// ---- Rename ----
const showRenameModal = ref(false)
const renameTarget = ref<{ id: string, path: string, label: string } | null>(null)
const renameName = ref('')
const renameLoading = ref(false)

function promptRename(id: string, path: string, label: string) {
  renameTarget.value = { id, path, label }
  renameName.value = basenameOf(path)
  showRenameModal.value = true
}

async function confirmRename() {
  if (!renameTarget.value || !renameName.value.trim()) return
  renameLoading.value = true
  const dir = dirOf(renameTarget.value.path)
  const newPath = dir === '/' ? '/' + renameName.value.trim() : dir + '/' + renameName.value.trim()
  try {
    await update(renameTarget.value.id, { path: newPath })
    toast.add({ color: 'success', title: `Renamed to "${renameName.value.trim()}"` })
    showRenameModal.value = false
    emit('refresh')
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Rename failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    renameLoading.value = false
  }
}

// ---- Move ----
const showMoveModal = ref(false)
const moveTarget = ref<{ id: string, path: string, label: string } | null>(null)
const moveDestFolder = ref('')
const moveLoading = ref(false)

function promptMove(id: string, path: string, label: string) {
  moveTarget.value = { id, path, label }
  moveDestFolder.value = dirOf(path)
  showMoveModal.value = true
}

async function confirmMove() {
  if (!moveTarget.value || !moveDestFolder.value) return
  moveLoading.value = true
  const base = basenameOf(moveTarget.value.path)
  const dest = moveDestFolder.value === '/' ? '/' + base : moveDestFolder.value + '/' + base
  try {
    await move(moveTarget.value.id, dest)
    toast.add({ color: 'success', title: `Moved to "${moveDestFolder.value}"` })
    showMoveModal.value = false
    emit('refresh')
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Move failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    moveLoading.value = false
  }
}

// ---- Share ----
async function shareDoc(id: string) {
  try {
    // Fetch current state then toggle
    const doc = await get(id)
    const nowPublic = !doc.isPublic
    const updated = await share(id, nowPublic)
    if (nowPublic && updated.publicSlug) {
      const url = `${window.location.origin}/share/${updated.publicSlug}`
      await copyText(url)
      toast.add({ color: 'success', title: 'Document shared', description: 'Public link copied to clipboard' })
    } else {
      toast.add({ color: 'success', title: 'Document is now private' })
    }
    emit('refresh')
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Share failed', description: err.data?.statusMessage ?? err.message })
  }
}

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
      }
    ],
    [
      {
        label: 'Delete',
        icon: 'i-lucide-trash-2',
        color: 'error' as const,
        onSelect: () => promptDelete(item.id, item.label)
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
              class="flex items-center gap-2 w-full rounded px-1 -mx-1 transition-colors group cursor-grab active:cursor-grabbing"
              :class="selectedId === item.id ? 'bg-primary/10' : ''"
              @dragstart="onDragStart($event, item)"
              @dragend="onDragEnd"
            >
              <UIcon
                v-if="item.icon"
                :name="item.icon"
                class="size-4 shrink-0 text-dimmed"
              />
              <span class="truncate text-sm flex-1">{{ item.label }}</span>
              <!-- Delete button, shown on hover for files only -->
              <UButton
                icon="i-lucide-trash-2"
                size="xs"
                variant="ghost"
                color="error"
                class="opacity-0 group-hover:opacity-100 shrink-0"
                @click.stop="promptDelete(item.id, item.label)"
              />
            </div>
          </UContextMenu>

          <!-- Folder row — drop target -->
          <div
            v-else
            class="flex items-center gap-2 w-full rounded px-1 -mx-1 transition-colors"
            :class="dropTargetPath === item.path ? 'bg-primary/20 ring-1 ring-primary/40' : ''"
            @dragover="onFolderDragOver($event, item.path)"
            @dragleave="onFolderDragLeave(item.path)"
            @drop.stop="onFolderDrop($event, item.path)"
          >
            <UIcon
              :name="dropTargetPath === item.path ? 'i-lucide-folder-open' : (expanded ? 'i-lucide-folder-open' : 'i-lucide-folder')"
              class="size-4 shrink-0"
              :class="dropTargetPath === item.path ? 'text-primary' : 'text-dimmed'"
            />
            <span class="truncate text-sm flex-1">{{ item.label }}</span>
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

    <!-- Rename modal -->
    <UModal v-model:open="showRenameModal">
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
                @click="showRenameModal = false"
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

    <!-- Move modal -->
    <UModal v-model:open="showMoveModal">
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
            :description="moveTarget ? `Moving: ${moveTarget.label}` : ''"
          >
            <USelect
              v-model="moveDestFolder"
              :items="allFolders.length ? allFolders : ['/']"
              class="w-full font-mono text-sm"
              placeholder="Select folder"
            />
          </UFormField>

          <template #footer>
            <div class="flex justify-end gap-2">
              <UButton
                color="neutral"
                variant="ghost"
                @click="showMoveModal = false"
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
  </div>
</template>
