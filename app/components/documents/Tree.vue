<script setup lang="ts">
import { useSortable, insertNodeAt, removeNode } from '@vueuse/integrations/useSortable'
import { createReusableTemplate } from '@vueuse/core'
import type Sortable from 'sortablejs'
import type { ComponentPublicInstance } from 'vue'
import type { TreeNode } from '~~/server/services/tree'
import type { ContextMenuItem } from '@nuxt/ui'
import type { FolderColorSource } from '~~/shared/types/folders'
import { collectFolderPaths, dirnameOf } from '~/lib/documents/folder-list'
import {
  canDropInto,
  destinationPathFor,
  isNoOpDrop,
  prunePathsUnderFolders
} from '~/lib/documents/tree-drag'
import { basenameOf, copyText, describeFolderError, type DocTreeTarget } from '~/composables/useDocumentTree'

interface TreeItem {
  id: string
  label: string
  path: string
  nodeType: 'file' | 'folder'
  icon?: string
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
const { patch: patchFolder, impact: fetchImpact } = useFolders()

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

/**
 * Server truth indexed by path. Deliberately derived from `treeItems` (the props) and NOT from
 * the drag-mutated `childrenByPath` below: the persistence pass needs each node's real id
 * (document id / folder registry id) as it stands on the SERVER, which an optimistic local
 * splice must not be able to influence.
 */
const itemByPath = computed(() => {
  const out = new Map<string, TreeItem>()
  const walk = (list: TreeItem[]) => {
    for (const it of list) {
      out.set(it.path, it)
      if (it.children) walk(it.children)
    }
  }
  walk(treeItems.value)
  return out
})

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

function isExpanded(path: string): boolean {
  return expandedKeys.value.includes(path)
}

function expand(path: string) {
  if (!isExpanded(path)) expandedKeys.value = [...expandedKeys.value, path]
}

function collapse(path: string) {
  if (isExpanded(path)) expandedKeys.value = expandedKeys.value.filter(p => p !== path)
}

function toggleExpanded(path: string) {
  if (isExpanded(path)) collapse(path)
  else expand(path)
}

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
  deleteLoading,
  newFolderState,
  folderDeleteState
} = useDocumentTree(() => emit('refresh'))

/**
 * A folder's tree-item `id` is its PATH (see `toTreeItems` above) — `PATCH`/`DELETE
 * /api/folders/[id]` need the folder's real registry uuid instead, which is carried
 * separately as `folderId`. Every folder-menu action that hits `/api/folders/[id]` goes
 * through this guard so none of them can accidentally submit a path where an id belongs
 * (exactly the bug that produced Task 10's false-success rename/move).
 */
function folderTarget(item: TreeItem): DocTreeTarget | null {
  if (!item.folderId) {
    // Real data never leaves a folder without a registry row — every writer that can produce
    // one runs `ensureFolders`/`createFolder` first (same guarantee `promptColor` relies on).
    toast.add({ color: 'error', title: "Can't do that yet", description: `"${item.label}" has no folder id yet — try refreshing.` })
    return null
  }
  return { id: item.folderId, path: item.path, label: item.label }
}

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
        onSelect: () => {
          const t = folderTarget(item)
          if (t) promptFolderRename(t)
        }
      },
      {
        label: 'Move',
        icon: 'i-lucide-folder-input',
        onSelect: () => {
          const t = folderTarget(item)
          if (t) openMoveModal(t, null)
        }
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
        onSelect: () => {
          const t = folderTarget(item)
          if (t) promptFolderDelete(t)
        }
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

// ---- Selection (click, plus cmd/shift multi-select for drag) ----

/** Paths in a cmd/shift multi-selection. A drag started on any of them carries the whole set. */
const marked = ref<string[]>([])
/** Anchor for a shift-click range — the last row picked without shift. */
const markAnchor = ref<string | null>(null)

/** Every currently *visible* row, top to bottom — the coordinate space a shift-range works in. */
const visiblePaths = computed(() => {
  const out: string[] = []
  const walk = (path: string) => {
    for (const it of childrenByPath[path] ?? []) {
      out.push(it.path)
      if (it.nodeType === 'folder' && isExpanded(it.path)) walk(it.path)
    }
  }
  walk('/')
  return out
})

function clearMarks() {
  if (marked.value.length) marked.value = []
}

function onRowClick(e: MouseEvent | KeyboardEvent, item: TreeItem) {
  // The grip is a drag handle, not a button — a click that lands on it must not also toggle
  // the folder it belongs to.
  if ((e.target as HTMLElement | null)?.closest('.drag-handle')) return

  if (e.metaKey || e.ctrlKey) {
    marked.value = marked.value.includes(item.path)
      ? marked.value.filter(p => p !== item.path)
      : [...marked.value, item.path]
    markAnchor.value = item.path
    return
  }

  if (e.shiftKey && markAnchor.value) {
    const rows = visiblePaths.value
    const from = rows.indexOf(markAnchor.value)
    const to = rows.indexOf(item.path)
    if (from !== -1 && to !== -1) {
      marked.value = rows.slice(Math.min(from, to), Math.max(from, to) + 1)
      return
    }
  }

  clearMarks()
  markAnchor.value = item.path
  if (item.nodeType === 'folder') toggleExpanded(item.path)
  else emit('select', item.id)
}

// ── Drag and drop (useSortable, one sortable per folder, one shared group) ─────────────────
//
// SHAPE: every folder renders its own <ul data-folder-path="…"> bound to its own mutable array
// in `childrenByPath`, and every one of those lists joins group 'documents'. That is what makes
// a drag between two folders a *cross-list* move rather than a reorder — the tree's structure
// is the drop-target model, so "which folder did this land in" is answered by the destination
// list's own `data-folder-path`, never by arithmetic on indices. The tree's scroll container
// holds the root list (`data-folder-path="/"`), so the top level is a drop target like any other.
//
// `sort: false` on every list is load-bearing, not decoration: row order here is derived
// (folders first, then alphabetical, applied server-side in `buildTree`) and this cycle adds no
// `sort_order` column, so a within-list reorder would be a gesture the app cannot honour — it
// would animate and then snap back on the next refetch. With `sort: false`, Sortable reverts a
// same-list drop and only ever hands us moves that actually change containment. Dropping INTO
// another list is unaffected: the target's `sort` is not consulted, only the group's put/pull.
//
// THE TRAP (canonical write-up: AssignmentChain.vue:9-14, app/pages/tasks.vue:109-120):
// useSortable mutates the bound array on a `nextTick`, so reading list state inside `onEnd`
// races that splice and persists the PRE-drop state — the "rows snap back" bug recorded in the
// `usesortable-onend-snapback` memory. So `onEnd` here reads ONLY stable DOM attributes
// (`evt.item.dataset.path`, `evt.from/to.dataset.folderPath`) and performs the cross-list splice
// that vueuse does not wire for you; a deep watch on `childrenByPath` is what tells us the
// mutation landed and drives persistence.

/** Mutable per-folder children arrays keyed by folder path; `'/'` is the root list. */
const childrenByPath = reactive<Record<string, TreeItem[]>>({})

/** True while a row is held. A live refetch (SSE invalidation) landing mid-drag must NOT
 *  rebuild the tree — that would yank the row out of the user's hand.
 *
 * This guard is sharper than the tasks board's: vueuse's `watchElement` calls
 * `sortable.destroy()` whenever a bound element goes away, and SortableJS's `destroy()` runs
 * `_onDrop()` — which ABORTS the drag in progress, whichever list was destroyed. So nothing may
 * unmount a folder's <ul> mid-drag. Found the hard way: collapsing the dragged folder to make a
 * tidier one-row placeholder silently killed every drag of an EXPANDED folder — the drop just
 * did nothing, with no error anywhere. So an expanded folder drags at its full subtree height;
 * that is cosmetic, and worth far less than the drag working. Expanding a folder mid-drag is
 * safe in the other direction: `cleanup()` on an undefined instance is a no-op, which is what
 * makes hover-to-expand legal. */
const isDragging = ref(false)

/** True while `rebuild` is writing server truth into `childrenByPath`. The persistence watch
 *  must not treat that as a user edit and write it straight back out — the same "which
 *  direction did this change come from" problem AssignmentChain.vue solves with
 *  `syncingFromProps`. Cleared on `nextTick` so it is still true for this mutation's flush. */
let syncingFromServer = false

function rebuild(items: TreeItem[]) {
  const next: Record<string, TreeItem[]> = {}
  const walk = (list: TreeItem[], path: string) => {
    next[path] = list
    for (const it of list) {
      if (it.nodeType === 'folder') walk(it.children ?? [], it.path)
    }
  }
  walk(items, '/')

  syncingFromServer = true
  for (const [path, list] of Object.entries(next)) {
    if (!childrenByPath[path]) childrenByPath[path] = []
    // Rebuild in place: the array identity is what Sortable and the reactive proxy both hold.
    childrenByPath[path]!.splice(0, childrenByPath[path]!.length, ...list)
  }
  // A folder that no longer exists is emptied, never deleted — its key stays so that if the
  // folder comes back (undo, a refetch race, a rename back) the SAME array is still the one its
  // already-registered sortable is bound to. Emptied lists are unreachable from the render walk.
  for (const path of Object.keys(childrenByPath)) {
    if (!(path in next)) childrenByPath[path]!.splice(0, childrenByPath[path]!.length)
  }
  nextTick(() => { syncingFromServer = false })
}

watch(treeItems, (items) => {
  if (!isDragging.value) rebuild(items)
}, { immediate: true })

// One <ul> element per folder path. Function refs rather than template refs because the lists
// are produced by a recursive template, and they mount/unmount as folders expand and collapse.
const listRefs = shallowReactive<Record<string, HTMLElement | null>>({})

/**
 * One STABLE ref-setter per folder path, memoised.
 *
 * An inline `:ref="el => …"` arrow is a new function on every render, and Vue re-invokes a
 * function ref whose identity changed — first with `null`, then with the element. That churn
 * feeds `watchElement`, which would tear down and rebuild the folder's Sortable on unrelated
 * re-renders (including one landing mid-drag). A memoised setter keeps the identity stable, so
 * Vue only calls it when the element genuinely mounts or unmounts.
 */
const listRefSetters = new Map<string, (el: Element | ComponentPublicInstance | null) => void>()

function listRefFor(path: string) {
  let setter = listRefSetters.get(path)
  if (!setter) {
    setter = (el) => {
      // Vue function refs must return void — wrap the assignment in a block statement.
      listRefs[path] = (el as HTMLElement | null) ?? null
    }
    listRefSetters.set(path, setter)
  }
  return setter
}

/** The folder whose list the in-flight drag would drop into — drives the row's destination cue. */
const activeDropPath = ref<string | null>(null)

/** Paths this drag carries: the multi-selection when the grabbed row is part of it, else just
 *  the grabbed row. Plain `let` — nothing renders from it. */
let dragPaths: string[] = []

const HOVER_EXPAND_MS = 600
let hoverExpandPath: string | null = null
let hoverExpandTimer: ReturnType<typeof setTimeout> | null = null

function clearHoverExpand() {
  if (hoverExpandTimer) clearTimeout(hoverExpandTimer)
  hoverExpandTimer = null
  hoverExpandPath = null
}

/** Rest the pointer on a collapsed folder mid-drag and it opens, so you can reach inside it
 *  without dropping first. Restarted whenever the hovered row changes; cleared on drop. */
function scheduleHoverExpand(row: HTMLElement | null | undefined) {
  const path = row?.dataset.path
  const nodeType = row?.dataset.nodeType
  if (!path || nodeType !== 'folder' || isExpanded(path)) {
    if (hoverExpandPath) clearHoverExpand()
    return
  }
  if (hoverExpandPath === path) return
  clearHoverExpand()
  hoverExpandPath = path
  hoverExpandTimer = setTimeout(() => {
    hoverExpandTimer = null
    hoverExpandPath = null
    expand(path)
  }, HOVER_EXPAND_MS)
}

const sortableInitialized = new Set<string>()

function ensureSortable(path: string) {
  if (sortableInitialized.has(path)) return
  sortableInitialized.add(path)
  if (!childrenByPath[path]) childrenByPath[path] = []
  // `childrenByPath[path]` is a plain array living inside reactive(), NOT a ref — see the note
  // at app/pages/tasks.vue's ensureSortable: that binding mutates live in two steps, which is
  // why persistence below defers past a macrotask instead of trusting the first watch fire.
  useSortable(() => listRefs[path], childrenByPath[path]!, {
    // Required, not cosmetic: a folder's <ul> does not exist at mount (it appears when the
    // folder expands, and again after every collapse), so useSortable's default mount-time
    // resolution would silently never attach.
    watchElement: true,
    group: 'documents',
    animation: 150,
    // R4: the hover-revealed grip is the ONLY drag origin. Without this the whole row drags and
    // fights click-to-select and text selection, and the grip becomes a lie.
    handle: '.drag-handle',
    draggable: '.mm-tree-node',
    sort: false,
    fallbackOnBody: true,
    invertSwap: true,
    // Without this, an expanded folder with no children is a zero-height list that the pointer
    // can never be "inside", so dropping into an empty folder would be impossible.
    emptyInsertThreshold: 8,
    ghostClass: 'mm-drop-indicator',
    onChoose: onNodeChoose,
    onUnchoose: onNodeUnchoose,
    onStart: onNodeDragStart,
    onMove: onNodeDragMove,
    onEnd: onNodeDragEnd
  })
}

onMounted(() => {
  // Folder paths aren't known until the tree query resolves, and they change as folders are
  // created/renamed — so sortables are registered lazily per path rather than in one static loop.
  watch(allFolders, (paths) => {
    for (const p of paths) ensureSortable(p)
  }, { immediate: true })
})

/** Fires on mousedown, before the browser snapshots the native drag image — which is why the
 *  multi-drag count badge has to be stamped on here and not in `onStart`. */
function onNodeChoose(evt: Sortable.SortableEvent) {
  const path = evt.item.dataset.path
  if (!path || !marked.value.includes(path) || marked.value.length < 2) return
  const allFiles = marked.value.every(p => itemByPath.value.get(p)?.nodeType === 'file')
  evt.item.setAttribute('data-drag-count', `${marked.value.length} ${allFiles ? 'documents' : 'items'}`)
}

function onNodeUnchoose(evt: Sortable.SortableEvent) {
  evt.item.removeAttribute('data-drag-count')
}

function onNodeDragStart(evt: Sortable.SortableEvent) {
  isDragging.value = true
  const path = evt.item.dataset.path
  dragPaths = path && marked.value.includes(path) && marked.value.length > 1
    ? prunePathsUnderFolders(marked.value, p => itemByPath.value.get(p)?.nodeType)
    : (path ? [path] : [])
}

function onNodeDragMove(evt: Sortable.MoveEvent): boolean | void {
  const dragged = evt.dragged as HTMLElement
  const to = evt.to as HTMLElement
  const draggedPath = dragged?.dataset.path
  const nodeType = dragged?.dataset.nodeType as 'file' | 'folder' | undefined
  const toPath = to?.dataset.folderPath
  if (!draggedPath || !nodeType || !toPath) return false

  // Belt and braces alongside the path check: moving a node into a list it physically contains
  // is a DOM error, not just an invalid move.
  if (dragged.contains(to)) return false
  if (!canDropInto({ path: draggedPath, nodeType }, toPath)) return false

  activeDropPath.value = toPath
  scheduleHoverExpand(evt.related as HTMLElement | undefined)
}

/**
 * Moves recorded by `onEnd` and drained by `persistPendingMoves`.
 *
 * Every field comes from a DOM attribute read while it was stable, never from list state — see
 * the trap write-up above. The deep watch below decides WHEN to drain this; it never decides
 * what is in it.
 */
const pendingMoves: { paths: string[], toFolder: string }[] = []

function onNodeDragEnd(evt: Sortable.SortableEvent) {
  // Cleared synchronously, exactly as tasks.vue's onCardMoved does: the model mutation below
  // lands on the microtask queue long before any SSE-driven refetch could arrive, so re-opening
  // the rebuild watch here doesn't race it.
  isDragging.value = false
  clearHoverExpand()
  activeDropPath.value = null
  evt.item.removeAttribute('data-drag-count')

  const fromFolder = (evt.from as HTMLElement).dataset.folderPath
  const toFolder = (evt.to as HTMLElement).dataset.folderPath
  const itemPath = evt.item.dataset.path
  const paths = dragPaths.length ? dragPaths : (itemPath ? [itemPath] : [])
  dragPaths = []

  // `sort: false` means a same-list drop moved nothing — Sortable already reverted it.
  if (!fromFolder || !toFolder || !paths.length || fromFolder === toFolder) return

  const { oldIndex } = evt
  const toList = childrenByPath[toFolder]
  if (oldIndex == null || !toList) return

  // Record BEFORE the deferred splice: whichever array mutation fires the watch below, this is
  // already sitting there waiting to be drained.
  pendingMoves.push({ paths, toFolder })

  // Sortable has physically moved the row into the destination <ul>. Undo that (put the node
  // back where Vue last rendered it) and let Vue perform the real move by re-rendering from the
  // spliced arrays a tick later — otherwise the DOM and Vue's vnode model disagree about which
  // list owns the node. Same dance as tasks.vue's cross-column branch, across N items.
  removeNode(evt.item)
  insertNodeAt(evt.from, evt.item, oldIndex)
  nextTick(() => {
    for (const p of paths) {
      const source = childrenByPath[dirnameOf(p)]
      if (!source) continue
      const i = source.findIndex(n => n.path === p)
      if (i === -1) continue
      const [moved] = source.splice(i, 1)
      // Position is meaningless (order is derived server-side) — append and let the refetch
      // put it where the sort says it belongs.
      if (moved) toList.push(moved)
    }
  })
}

// The persistence trigger. Reading `childrenByPath` here would be the trap all over again, so
// this only ever asks "did a drag's mutation land?" and drains `pendingMoves`, whose contents
// were captured from stable DOM attributes in `onEnd`. The macrotask defer (setTimeout 0 runs
// after every queued microtask/nextTick has drained) means the optimistic splice above is fully
// settled before anything is written.
let persisting = false
let persistHandle: ReturnType<typeof setTimeout> | null = null

function schedulePersist() {
  if (persistHandle != null) clearTimeout(persistHandle)
  persistHandle = setTimeout(() => {
    persistHandle = null
    void persistPendingMoves()
  }, 0)
}

watch(childrenByPath, () => {
  if (syncingFromServer) return
  if (!pendingMoves.length) return
  schedulePersist()
}, { deep: true })

/** Undo an optimistic splice by re-seeding from the server truth we already hold. */
function revertOptimistic() {
  rebuild(treeItems.value)
}

async function persistPendingMoves() {
  if (persisting) return
  persisting = true
  const failures: string[] = []
  let gated = false
  try {
    // `while` rather than a single pass: a second drag landing while the first one's network
    // calls are in flight must not be silently dropped.
    while (pendingMoves.length > 0) {
      const batch = pendingMoves.splice(0, pendingMoves.length)
      for (const mv of batch) {
        for (const path of mv.paths) {
          const item = itemByPath.value.get(path)
          if (!item) continue
          if (isNoOpDrop(path, mv.toFolder)) continue
          const dest = destinationPathFor(path, mv.toFolder)
          try {
            if (item.nodeType === 'folder') {
              // Only ONE folder can be waiting on the acknowledgement modal at a time — a second
              // call would silently replace the first folder's dialog with the second's, and the
              // first would be dropped with no dialog and no message. Skip it loudly instead.
              if (gated) {
                failures.push(`${item.label}: not moved — confirm the folder move already waiting first`)
                continue
              }
              gated = await moveFolder(item, mv.toFolder, dest)
            } else {
              await move(item.id, dest)
            }
          } catch (e: unknown) {
            failures.push(`${item.label}: ${item.nodeType === 'folder' ? describeFolderError(e) : errorText(e)}`)
          }
        }
      }
    }
  } finally {
    persisting = false
  }

  if (failures.length) {
    toast.add({ color: 'error', title: "Couldn't move", description: failures.join('\n') })
  }
  // A gated folder move has not happened yet (the Move modal is asking for an acknowledgement),
  // so the optimistic splice must not be left standing as if it had.
  if (failures.length || gated) revertOptimistic()
  clearMarks()
  emit('refresh')
}

function errorText(e: unknown): string {
  const err = e as { data?: { statusMessage?: string }, message?: string }
  return err.data?.statusMessage ?? err.message ?? 'Name collision?'
}

/**
 * Move a folder by drag — through the SAME safety gate a menu-driven move goes through.
 *
 * `documents.path` decides project membership, so dropping a folder across a `/projects/<slug>/`
 * boundary silently re-associates every document inside it. A drag is an easier gesture to
 * trigger by accident than a dialog, so it gets the stricter treatment, not the looser one:
 * `impact` is fetched first and, when it reports project changes, the write is NOT performed —
 * the drop is handed to MoveModal (already pointed at the folder it was dropped on), which owns
 * Task 12's warning, its acknowledgement checkbox and its fail-closed re-check.
 *
 * Returns true when the move was handed to the modal instead of being performed.
 */
async function moveFolder(item: TreeItem, toFolder: string, dest: string): Promise<boolean> {
  const target = folderTarget(item)
  if (!target) return true // no registry id: nothing was moved, so the splice must be reverted

  let impact: Awaited<ReturnType<typeof fetchImpact>>
  try {
    impact = await fetchImpact(target.id, dest)
  } catch {
    // Fail CLOSED, matching MoveModal: an unknown outcome is "assume the worst", never "assume
    // it's fine". A drag must not be the one path that commits without the check.
    toast.add({
      color: 'error',
      title: "Couldn't check what this move affects",
      description: `"${item.label}" was not moved — we can't confirm whether it crosses a project boundary.`
    })
    return true
  }

  if (impact.projectChanges.length) {
    openMoveModal(target, toFolder)
    return true
  }

  const result = await patchFolder(target.id, { path: dest })
  // An unmatched relative route resolves to the SPA shell with a 200, which ofetch does not
  // throw on — a real PATCH always answers `{ ok: true }`.
  if (!result || result.ok !== true) throw new Error('The server did not confirm the folder move')
  return false
}

/** Destination handed to MoveModal — set only when a *drag* opened it. */
const moveDestination = ref<string | null>(null)

function openMoveModal(target: DocTreeTarget, destination: string | null) {
  // Set first: MoveModal reads `destination` in its `open` watcher.
  moveDestination.value = destination
  promptFolderMove(target)
}

function onMoveModalOpenChange(open: boolean) {
  moveState.open = open
  if (!open) moveDestination.value = null
}

onBeforeUnmount(() => {
  clearHoverExpand()
  if (persistHandle != null) clearTimeout(persistHandle)
})

// Recursive list renderer. One template, reused at every depth, so the sortable wiring, the
// context menus and the selection handlers all stay in this one setup scope instead of being
// prop-drilled through a child component per level.
const [DefineList, ReuseList] = createReusableTemplate<{ path: string, level: number }>()
</script>

<template>
  <div class="h-full flex flex-col">
    <DefineList v-slot="{ path, level }">
      <ul
        :ref="listRefFor(path)"
        :data-folder-path="path"
        :role="level === 1 ? 'tree' : 'group'"
        :class="[
          level === 1 ? 'min-h-full' : 'border-s border-default ms-5',
          // An expanded folder with no children is a zero-height list nobody can point at. It
          // keeps a hairline of its own at rest, and opens into a real 1.5rem drop zone for the
          // duration of a drag — `emptyInsertThreshold` only widens the catch radius around a
          // list, it cannot conjure one out of nothing.
          level === 1 ? '' : (isDragging ? 'min-h-6' : 'min-h-2')
        ]"
      >
        <li
          v-for="item in childrenByPath[path] ?? []"
          :key="item.id"
          class="mm-tree-node relative w-full"
          :class="level > 1 ? 'ps-1.5 -ms-px' : ''"
          :data-path="item.path"
          :data-node-type="item.nodeType"
          role="treeitem"
          :aria-expanded="item.nodeType === 'folder' ? isExpanded(item.path) : undefined"
          :aria-selected="selectedId === item.id || marked.includes(item.path)"
        >
          <UContextMenu :items="item.nodeType === 'file' ? fileMenuItems(item) : folderMenuItems(item)">
            <div
              class="w-full flex items-center rounded-md px-2.5 py-1.5 text-sm select-none cursor-pointer focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              tabindex="0"
              @click="onRowClick($event, item)"
              @keydown.enter.prevent="onRowClick($event, item)"
            >
              <DocumentsTreeRow
                :item="item"
                :expanded="isExpanded(item.path)"
                :selected="selectedId === item.id"
                :marked="marked.includes(item.path)"
                :drop-active="item.nodeType === 'folder' && activeDropPath === item.path"
              />
            </div>
          </UContextMenu>

          <ReuseList
            v-if="item.nodeType === 'folder' && isExpanded(item.path)"
            :path="item.path"
            :level="level + 1"
          />
        </li>
      </ul>
    </DefineList>

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

        <!-- The root list IS the scroll container's child, so dropping in the empty space below
             the tree lands a document at the top level. -->
        <ReuseList
          v-else
          path="/"
          :level="1"
        />
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

    <!-- Rename modal — shared by files and folders, dispatched by `kind` -->
    <DocumentsRenameModal
      :target="renameState.target"
      :open="renameState.open"
      :kind="renameState.kind"
      @update:open="renameState.open = $event"
      @done="emit('refresh')"
    />

    <!-- Move modal — shared by files and folders, dispatched by `kind`. `destination` is set
         only when a cross-project folder DRAG handed the move over for acknowledgement. -->
    <DocumentsMoveModal
      :target="moveState.target"
      :open="moveState.open"
      :folders="allFolders"
      :kind="moveState.kind"
      :destination="moveDestination"
      @update:open="onMoveModalOpenChange"
      @done="emit('refresh')"
    />

    <!-- New folder modal -->
    <DocumentsNewFolderModal
      :open="newFolderState.open"
      :parent-path="newFolderState.parentPath"
      @update:open="newFolderState.open = $event"
      @done="emit('refresh')"
    />

    <!-- Folder delete confirmation -->
    <DocumentsFolderDeleteModal
      :open="folderDeleteState.open"
      :folder="folderDeleteState.target"
      @update:open="folderDeleteState.open = $event"
      @deleted="emit('refresh')"
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

<style scoped>
/* The insert indicator. Sortable leaves the dragged row in place as the placeholder and tags it
   with `ghostClass`; drawing a line on its leading edge turns that placeholder into "it goes
   here", which is what replaces the old whole-row drag-over tint. `--ui-primary` is the theme's
   own token (same one MdView.vue and AppLogo.vue read), so it follows a theme change. */
.mm-drop-indicator {
  background: var(--ui-bg-elevated);
  border-radius: 0.375rem;
}

.mm-drop-indicator::before {
  content: '';
  position: absolute;
  inset-inline: 0;
  top: -1px;
  height: 2px;
  border-radius: 1px;
  background: var(--ui-primary);
  pointer-events: none;
}

/* Multi-drag ghost. Stamped by `onChoose` (before the browser snapshots the drag image) and
   removed on unchoose/end, so the thing following the pointer says how many rows are coming. */
.mm-tree-node[data-drag-count]::after {
  content: attr(data-drag-count);
  position: absolute;
  right: 0.5rem;
  top: 50%;
  transform: translateY(-50%);
  padding: 0 0.4rem;
  border-radius: 9999px;
  font-size: 0.625rem;
  line-height: 1.1rem;
  font-weight: 600;
  color: var(--ui-bg);
  background: var(--ui-primary);
  pointer-events: none;
}
</style>
