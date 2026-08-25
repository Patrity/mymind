<script setup lang="ts">
import type { TreeNode } from '~~/server/services/tree'
import type { ContextMenuItem } from '@nuxt/ui'
import type { FolderColorSource } from '~~/shared/types/folders'
import { collectFolderPaths, dirnameOf } from '~/lib/documents/folder-list'
import { basenameOf, copyText } from '~/composables/useDocumentTree'

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
  /** Folders only: the folder's real `folders` table id. NOT the same as `id` above, which
   *  is the tree-item's path — the colour picker needs the real id to PATCH by. Absent only
   *  if this folder somehow has no registry row yet, which real data never leaves it in. */
  folderId?: string | null
}

const props = defineProps<{
  tree: TreeNode[]
  selectedId?: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
  refresh: []
  /** A "New document here" / "New document" menu item was chosen — path is where to create it. */
  newDocument: [path: string]
}>()

const toast = useToast()
const { move, get, create } = useDocuments()

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
        folderId: n.id ?? null,
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
  promptNewFolder,
  promptFolderDelete,
  promptFolderRename,
  promptFolderMove,
  renameState,
  moveState,
  deleteState,
  deleteLoading
} = useDocumentTree(() => emit('refresh'))

// ---- File menu ----
function fileMenuItems(item: TreeItem): ContextMenuItem[][] {
  return [
    [
      {
        label: 'Open',
        icon: 'i-lucide-external-link',
        onSelect: () => emit('select', item.id)
      }
    ],
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
      },
      {
        label: 'Duplicate',
        icon: 'i-lucide-copy',
        onSelect: () => duplicateDoc(item)
      }
    ],
    [
      {
        label: 'Copy path',
        icon: 'i-lucide-clipboard',
        onSelect: () => copyText(item.path)
      },
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

/**
 * Copy a file's full content to a sibling path — "<name> copy.<ext>" next to the original,
 * uniquified against paths already in the tree so a repeat "Duplicate" doesn't collide.
 * No server endpoint for this; it's a plain read-then-create against the existing document API.
 */
async function duplicateDoc(item: TreeItem) {
  try {
    const doc = await get(item.id)
    const dir = dirnameOf(item.path)
    const base = basenameOf(item.path)
    const dot = base.lastIndexOf('.')
    const [name, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, '']

    const existing = collectFilePaths(props.tree)
    const pathFor = (n: string) => (dir === '/' ? `/${n}` : `${dir}/${n}`)
    let candidate = `${name} copy${ext}`
    let i = 2
    while (existing.has(pathFor(candidate))) {
      candidate = `${name} copy ${i}${ext}`
      i++
    }

    // Only carry the title across if it was curated (differs from the auto-derived
    // filename) — otherwise the duplicate should auto-derive its own from ITS filename,
    // or the tree shows two rows both labelled with the original's stale filename.
    const carriedTitle = doc.title && doc.title !== base ? doc.title : undefined

    const created = await create({
      path: pathFor(candidate),
      title: carriedTitle,
      content: doc.content,
      frontmatter: doc.frontmatter,
      project: doc.project,
      domain: doc.domain,
      type: doc.type,
      tags: doc.tags,
      topic: doc.topic
    })
    toast.add({ color: 'success', title: 'Duplicated', description: created.path })
    emit('refresh')
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }; message?: string }
    toast.add({ color: 'error', title: "Couldn't duplicate", description: err.data?.statusMessage ?? err.message })
  }
}

function collectFilePaths(nodes: TreeNode[], out: Set<string> = new Set()): Set<string> {
  for (const n of nodes) {
    if (n.type === 'file') out.add(n.path)
    if (n.children) collectFilePaths(n.children, out)
  }
  return out
}

// ---- Folder menu ----
function folderMenuItems(item: TreeItem): ContextMenuItem[][] {
  return [
    [
      {
        label: 'New document here',
        icon: 'i-lucide-file-plus',
        onSelect: () => emit('newDocument', item.path)
      },
      {
        label: 'New subfolder',
        icon: 'i-lucide-folder-plus',
        onSelect: () => promptNewFolder(item.path)
      }
    ],
    [
      {
        label: 'Rename',
        icon: 'i-lucide-pencil',
        onSelect: () => promptFolderRename({ id: item.id, path: item.path, label: item.label })
      },
      {
        label: 'Move',
        icon: 'i-lucide-folder-input',
        onSelect: () => promptFolderMove({ id: item.id, path: item.path, label: item.label })
      },
      {
        label: 'Colour',
        icon: 'i-lucide-palette',
        onSelect: () => promptColor(item)
      }
    ],
    [
      {
        label: 'Copy path',
        icon: 'i-lucide-clipboard',
        onSelect: () => copyText(item.path)
      },
      {
        label: 'Collapse all',
        icon: 'i-lucide-chevrons-down-up',
        onSelect: () => collapseUnder(item.path)
      }
    ],
    [
      {
        label: 'Delete',
        icon: 'i-lucide-trash-2',
        color: 'error' as const,
        onSelect: () => promptFolderDelete({ id: item.id, path: item.path, label: item.label })
      }
    ]
  ]
}

// ---- Folder colour ----
interface ColorPromptTarget {
  folderId: string
  path: string
  color: string | null
  colorSource: FolderColorSource | null
}
const colorState = reactive<{ open: boolean, target: ColorPromptTarget | null }>({ open: false, target: null })

function promptColor(item: TreeItem) {
  if (!item.folderId) {
    // Real data never leaves a folder without a registry row — every writer that can produce
    // one runs `ensureFolders`/`createFolder` first. Guarded anyway rather than opening a
    // picker that would 404 on save.
    toast.add({ color: 'error', title: "Can't set colour", description: `"${item.label}" has no folder id yet — try refreshing.` })
    return
  }
  colorState.target = { folderId: item.folderId, path: item.path, color: item.color ?? null, colorSource: item.colorSource ?? null }
  colorState.open = true
}

// ---- Root / empty-space menu ----
function rootMenuItems(): ContextMenuItem[][] {
  return [
    [
      {
        label: 'New document',
        icon: 'i-lucide-file-plus',
        onSelect: () => emit('newDocument', '/')
      },
      {
        label: 'New folder',
        icon: 'i-lucide-folder-plus',
        onSelect: () => promptNewFolder('/')
      }
    ],
    [
      {
        label: 'Expand all',
        icon: 'i-lucide-chevrons-up-down',
        onSelect: expandAll
      },
      {
        label: 'Collapse all',
        icon: 'i-lucide-chevrons-down-up',
        onSelect: collapseAll
      }
    ]
  ]
}

/** Expand every folder in the tree, root included. */
function expandAll() {
  expandedKeys.value = allFolders.value.filter(p => p !== '/')
}

/** Collapse every folder in the tree. */
function collapseAll() {
  expandedKeys.value = []
}

/** Collapse one folder and any expanded descendants under it — scoped, unlike `collapseAll`. */
function collapseUnder(path: string) {
  expandedKeys.value = expandedKeys.value.filter(p => p !== path && !p.startsWith(path + '/'))
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
    <!-- Root menu — right-clicking empty space below the tree, not any row. Row-level menus
         below preventDefault first, so a right-click ON a row never falls through to this one. -->
    <UContextMenu :items="rootMenuItems()">
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
              :items="fileMenuItems(item)"
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

            <!-- Folder row — drop target, plus its own menu. -->
            <UContextMenu
              v-else
              :items="folderMenuItems(item)"
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
    </UContextMenu>

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

    <!-- Folder colour picker. No @done here — the PATCH publishes a `folder` live event that
         invalidates the ['document','list'] query the tree is fed from (see live-dispatch.ts),
         so the rail/colorSource update on their own without an explicit refresh. -->
    <DocumentsFolderColorPicker
      :open="colorState.open"
      :folder-id="colorState.target?.folderId ?? ''"
      :folder-path="colorState.target?.path ?? ''"
      :current="colorState.target?.color ?? null"
      :source="colorState.target?.colorSource ?? null"
      @update:open="colorState.open = $event"
    />
  </div>
</template>
