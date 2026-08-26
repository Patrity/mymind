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
  projectSlugOfPath,
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

/**
 * Every READ of the cookie goes through here.
 *
 * `useCookie`'s `default` only applies when the cookie is absent at init — a cookie that is
 * cleared, emptied or corrupted *later* (by hand, by an older build, or by another tab) leaves
 * `expandedKeys.value` null, and the render path dereferences it on every row. Left unguarded
 * that is not a degraded tree, it is a `Cannot read properties of null` that takes the whole
 * component down. Found exactly that way: clearing the cookie in a browser session blanked the
 * panel. Writes still go to `expandedKeys` so the cookie is repaired on the next change.
 */
const expandedPaths = computed<string[]>(() =>
  Array.isArray(expandedKeys.value) ? expandedKeys.value : []
)

// Seed top-level folders as expanded on first visit
const topLevelFolders = computed(() =>
  props.tree.filter(n => n.type === 'folder').map(n => n.path)
)
watch(topLevelFolders, (dirs) => {
  if (expandedPaths.value.length === 0 && dirs.length) {
    expandedKeys.value = [...dirs]
  }
}, { immediate: true })

function isExpanded(path: string): boolean {
  return expandedPaths.value.includes(path)
}

function expand(path: string) {
  if (!isExpanded(path)) expandedKeys.value = [...expandedPaths.value, path]
}

function collapse(path: string) {
  if (isExpanded(path)) expandedKeys.value = expandedPaths.value.filter(p => p !== path)
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
  expandedKeys.value = expandedPaths.value.filter(p => p !== path && !p.startsWith(path + '/'))
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

/**
 * A click anywhere inside a row.
 *
 * The handler lives on the `<li role="treeitem">` (that is the element that carries the row's
 * identity to assistive tech, so it is the element that must be focusable and interactive), which
 * means a click on a NESTED row bubbles through every ancestor folder's `<li>` too. Both guards
 * below exist to stop that: the event is only ours when it landed inside THIS row's own
 * `.mm-tree-row` — which also rules out clicks on the indented strip of a folder's child list.
 */
function onRowPointer(e: MouseEvent, item: TreeItem) {
  const row = (e.target as HTMLElement | null)?.closest('.mm-tree-row')
  if (!row || row.parentElement !== e.currentTarget) return
  // The grip is a drag handle, not a button — a click that lands on it must not also toggle
  // the folder it belongs to.
  if ((e.target as HTMLElement | null)?.closest('.drag-handle')) return
  activateRow(e, item)
}

/** Enter on a focused row. Keyed events target the focused `<li>` itself, so the ownership test
 *  is a plain identity check rather than `onRowPointer`'s row lookup. */
function onRowKey(e: KeyboardEvent, item: TreeItem) {
  if (e.target !== e.currentTarget) return
  activateRow(e, item)
}

function activateRow(e: MouseEvent | KeyboardEvent, item: TreeItem) {
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
  draggingPath = path ?? null
  draggingType = (evt.item.dataset.nodeType as 'file' | 'folder' | undefined) ?? null
  startPointerTracking()
}

/**
 * The folder whose ROW the pointer is directly over, which overrides `evt.to` when the drop lands.
 *
 * Why this exists: a folder's row `<li>` lives in its PARENT's `<ul>`, and the folder's own `<ul>`
 * renders below the row, inside that `<li>`. So while the pointer sits on a folder's row, `evt.to`
 * is the parent list — and a drop there would file the document into the folder's parent, silently
 * and with no error. For a COLLAPSED folder there is no child list to aim at at all until
 * hover-to-expand fires 600ms later, and even then it appears below the row, so a quick drop still
 * lands in the parent. That is the gesture the original HTML5 code got right (its `@drop` was on
 * the folder row) and it is the gesture both user complaints are about, so the nested-list model
 * has to be corrected at the edges rather than taken literally.
 */
let dropOverrideFolder: string | null = null

/** What is being dragged, captured at `onStart` for the pointer tracker below. */
let draggingPath: string | null = null
let draggingType: 'file' | 'folder' | null = null

/**
 * Track the pointer for the whole drag and derive the destination from what is UNDER it.
 *
 * Deliberately not driven off Sortable's `onMove`. `sort: false` makes `_onDragOver` bail at its
 * `isOwner ? canSort …` gate *before* it ever calls `onMove`, so Sortable reports nothing at all
 * while the pointer is inside the list the row came from — which would leave "drop this onto that
 * sibling folder" silently doing nothing, the same class of bug as the parent-folder one above.
 * It also reports the LAST row as `related` when the pointer is in the empty space below a list
 * (the `_ghostIsLast` branch), which must keep meaning "the containing folder", not "the last
 * folder in it". Hit-testing the pointer answers both cases the same way, and answers them for the
 * cue and the outcome at once — so what lights up and where the row lands cannot disagree.
 */
function trackDragPointer(e: MouseEvent) {
  if (!draggingPath || !draggingType) return
  const dragged = { path: draggingPath, nodeType: draggingType }
  const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null

  // A row, and the <li> that owns it — the row div is UContextMenu's `as-child` trigger, so it is
  // always the <li>'s direct child.
  const row = under?.closest<HTMLElement>('.mm-tree-row')
  const li = row?.parentElement as HTMLElement | null
  const folderPath = li?.dataset.nodeType === 'folder' ? li.dataset.path : undefined

  // An override that would be an illegal drop (a folder onto itself or into its own subtree) is
  // discarded rather than honoured — it must not become a back door around `canDropInto`.
  dropOverrideFolder = folderPath && canDropInto(dragged, folderPath) ? folderPath : null

  if (dropOverrideFolder) {
    activeDropPath.value = dropOverrideFolder
  } else {
    // Not on a folder row: the destination is whichever list the pointer is inside.
    const listPath = under?.closest<HTMLElement>('[data-folder-path]')?.dataset.folderPath
    activeDropPath.value = listPath && canDropInto(dragged, listPath) ? listPath : null
  }

  scheduleHoverExpand(li ?? undefined)
}

function startPointerTracking() {
  // CAPTURE phase, not bubble. SortableJS's `_onDragOver` ends every handled event with
  // `evt.stopPropagation()` (that is how nested lists claim a drop — see the group notes above),
  // so a bubble-phase listener on window hears nothing at all while the pointer is over the tree,
  // which is the only place it matters. Capture runs top-down before any of that.
  //
  // `dragover` covers Sortable's native-draggable path; `mousemove` covers its fallback. Read-only
  // — neither handler calls preventDefault, so drop semantics are untouched.
  window.addEventListener('dragover', trackDragPointer, true)
  window.addEventListener('mousemove', trackDragPointer, true)
}

function stopPointerTracking() {
  window.removeEventListener('dragover', trackDragPointer, true)
  window.removeEventListener('mousemove', trackDragPointer, true)
}

/**
 * Sortable's own veto, narrowed to one job: deciding whether the row may be PHYSICALLY inserted
 * where Sortable wants to put it. The destination and the cue are the pointer tracker's business.
 *
 * Ordering note: the tracker listens on `dragover` in the capture phase, so `dropOverrideFolder`
 * is always up to date by the time this runs for the same event (capture on window precedes the
 * list element's own handler, which is what invokes `onMove`).
 */
function onNodeDragMove(evt: Sortable.MoveEvent): boolean | void {
  const dragged = evt.dragged as HTMLElement
  const to = evt.to as HTMLElement
  const draggedPath = dragged?.dataset.path
  const nodeType = dragged?.dataset.nodeType as 'file' | 'folder' | undefined
  const toPath = to?.dataset.folderPath
  if (!draggedPath || !nodeType || !toPath) return false

  // Pointer is on a folder ROW: the drop is already decided (into that folder) and needs no
  // insertion. Refusing it is not merely an optimisation — Sortable inserts the placeholder AT
  // the pointer, which pushes the very row being aimed at out from under it, so the next dragover
  // reports the placeholder instead of the folder and the drop lands somewhere else entirely.
  // Confirmed by hit-testing mid-drag: aiming at a folder's row put the dragged row in its place.
  // Declining the insertion keeps the tree still while the user aims, which is also how it should
  // feel: the ring on the destination folder says where it will go, and nothing else moves.
  if (dropOverrideFolder) return false

  // Belt and braces alongside the path check: moving a node into a list it physically contains
  // is a DOM error, not just an invalid move.
  if (dragged.contains(to)) return false
  if (!canDropInto({ path: draggedPath, nodeType }, toPath)) return false
}

/**
 * Moves recorded by `onEnd` and drained by `persistPendingMoves`.
 *
 * Every field comes from a DOM attribute read while it was stable, never from list state — see
 * the trap write-up above. The deep watch below decides WHEN to drain this; it never decides
 * what is in it.
 */
interface PendingMove {
  paths: string[]
  toFolder: string
  /** Set once the user has acknowledged a multi-document project change (see `bulkConfirm`), so
   *  re-queueing the move after the dialog doesn't re-open the same dialog forever. */
  confirmed?: boolean
}

const pendingMoves: PendingMove[] = []

function onNodeDragEnd(evt: Sortable.SortableEvent) {
  // Cleared synchronously, exactly as tasks.vue's onCardMoved does: the model mutation below
  // lands on the microtask queue long before any SSE-driven refetch could arrive, so re-opening
  // the rebuild watch here doesn't race it.
  isDragging.value = false
  stopPointerTracking()
  draggingPath = null
  draggingType = null
  clearHoverExpand()
  activeDropPath.value = null
  evt.item.removeAttribute('data-drag-count')

  const fromFolder = (evt.from as HTMLElement).dataset.folderPath
  const itemPath = evt.item.dataset.path
  const paths = dragPaths.length ? dragPaths : (itemPath ? [itemPath] : [])
  dragPaths = []

  // The folder row under the pointer wins over the list the node was physically dropped in —
  // see `dropOverrideFolder`. Read and cleared here so a later drag can never inherit it.
  const override = dropOverrideFolder
  dropOverrideFolder = null

  // Sortable has physically moved the row into whichever <ul> it decided on. Undo that FIRST and
  // unconditionally — Vue owns this DOM, and it must be put back where Vue last rendered it
  // before any early return below, or the DOM and the vnode model disagree about which list owns
  // the node. Same dance as tasks.vue's cross-column branch, but it can no longer be skipped: an
  // override means the logical destination and the physical one legitimately differ, so
  // "nothing to persist" no longer implies "nothing was physically moved".
  const { oldIndex } = evt
  if (evt.from !== evt.to && oldIndex != null) {
    removeNode(evt.item)
    insertNodeAt(evt.from, evt.item, oldIndex)
  }

  const toFolder = override ?? (evt.to as HTMLElement).dataset.folderPath
  // `sort: false` means a same-folder drop moved nothing.
  if (!fromFolder || !toFolder || !paths.length || fromFolder === toFolder) return

  const toList = childrenByPath[toFolder]
  if (!toList) return

  // Dropping onto a collapsed folder's row would otherwise make the row simply vanish, with the
  // destination given no chance to show what it received. Open it.
  if (override) expand(override)

  // Record BEFORE the deferred splice: whichever array mutation fires the watch below, this is
  // already sitting there waiting to be drained.
  pendingMoves.push({ paths, toFolder })

  // Let Vue perform the real move by re-rendering from the spliced arrays a tick later.
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

/**
 * Does this drag re-file several documents across a project boundary?
 *
 * `documents.path` decides project membership, so filing a document into `/projects/<slug>/…`
 * re-associates it. Doing that to ONE document is the intended way to associate it and stays
 * ungated, exactly as it always has been. Doing it to fourteen in a single gesture is new in this
 * task — multi-select is — and it is the same "a drag must not re-associate 14 documents with no
 * dialog" principle the folder gate exists for, so it gets a confirm of its own. A count, not the
 * full `impact` round-trip: both paths and the count are already known here, and a FOLDER in the
 * selection still goes through the real `impact` check in `moveFolder`.
 */
function crossProjectFiles(mv: PendingMove): string[] {
  if (mv.paths.length < 2) return []
  const toProject = projectSlugOfPath(mv.toFolder)
  return mv.paths.filter((p) => {
    const item = itemByPath.value.get(p)
    if (!item || item.nodeType !== 'file') return false
    if (isNoOpDrop(p, mv.toFolder)) return false
    return projectSlugOfPath(dirnameOf(p)) !== toProject
  })
}

/** A multi-document drag parked on the count confirm above. */
const bulkConfirm = reactive<{ open: boolean, count: number, toProject: string | null, toFolder: string }>({
  open: false, count: 0, toProject: null, toFolder: '/'
})
let bulkPending: PendingMove | null = null

function acceptBulkMove() {
  bulkConfirm.open = false
  const mv = bulkPending
  bulkPending = null
  if (!mv) return
  pendingMoves.push({ ...mv, confirmed: true })
  schedulePersist()
}

function cancelBulkMove() {
  bulkConfirm.open = false
  bulkPending = null
  // Nothing was written, so the optimistic splice must not be left standing as if it had.
  revertOptimistic()
  emit('refresh')
}

function onBulkConfirmOpenChange(open: boolean) {
  // Dismissing the dialog any other way (Escape, the overlay) is a cancel, not a silent accept.
  if (!open && bulkPending) cancelBulkMove()
  else bulkConfirm.open = open
}

/**
 * Is a move already waiting on an answer from the user?
 *
 * BOTH confirmation surfaces are component-scoped singletons — `moveState` (the folder gate's
 * MoveModal, shared with the context menu's own Move) and `bulkPending`/`bulkConfirm` (the
 * multi-document confirm). They outlive any single `persistPendingMoves()` call, so a call-local
 * flag cannot protect them: a second qualifying drag would overwrite the pending move, and the
 * first would vanish with no write, no toast and no error while the dialog quietly started
 * describing the second one instead. One move conversation at a time; the rest are refused out
 * loud. (Deliberately stricter than "same kind clobbers same kind" — stacking two dialogs over
 * each other is not an improvement on replacing one.)
 *
 * A plain function, NOT a computed: `bulkPending` is a non-reactive `let`, so a computed would
 * cache against `moveState.open`/`bulkConfirm.open` alone and could answer from a stale cache.
 * Nothing renders from this, so there is nothing to memoise anyway.
 */
function awaitingConfirmation(): boolean {
  return moveState.open || bulkConfirm.open || bulkPending !== null
}

async function persistPendingMoves() {
  if (persisting) return
  persisting = true
  const failures: string[] = []
  const moved: { label: string, nodeType: 'file' | 'folder', toFolder: string }[] = []
  let gated = false
  try {
    // `while` rather than a single pass: a second drag landing while the first one's network
    // calls are in flight must not be silently dropped.
    while (pendingMoves.length > 0) {
      const batch = pendingMoves.splice(0, pendingMoves.length)
      for (const mv of batch) {
        // Ask once for the whole drag, BEFORE writing any of it — a confirm that arrived after
        // the third of fourteen documents had already moved would not be a confirm.
        if (!mv.confirmed) {
          const crossing = crossProjectFiles(mv)
          if (crossing.length) {
            if (awaitingConfirmation()) {
              const n = mv.paths.length
              failures.push(`${n} ${n === 1 ? 'item' : 'items'}: not moved — answer the move already waiting first`)
              gated = true
              continue
            }
            bulkPending = mv
            bulkConfirm.count = crossing.length
            bulkConfirm.toProject = projectSlugOfPath(mv.toFolder)
            bulkConfirm.toFolder = mv.toFolder
            bulkConfirm.open = true
            gated = true
            continue
          }
        }
        for (const path of mv.paths) {
          const item = itemByPath.value.get(path)
          if (!item) continue
          if (isNoOpDrop(path, mv.toFolder)) continue
          const dest = destinationPathFor(path, mv.toFolder)
          try {
            if (item.nodeType === 'folder') {
              // Same singleton problem as the bulk confirm above, and the same answer.
              if (awaitingConfirmation()) {
                failures.push(`${item.label}: not moved — answer the move already waiting first`)
                gated = true
                continue
              }
              const handedOff = await moveFolder(item, mv.toFolder, dest)
              gated = handedOff || gated
              if (!handedOff) moved.push({ label: item.label, nodeType: 'folder', toFolder: mv.toFolder })
            } else {
              await move(item.id, dest)
              moved.push({ label: item.label, nodeType: 'file', toFolder: mv.toFolder })
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
  // A drag can move several rows at once now, and the destination is often scrolled away or
  // collapsed — so unlike a rename there is nothing to watch happen. Say what landed where.
  if (moved.length) {
    const allFiles = moved.every(m => m.nodeType === 'file')
    const noun = allFiles ? (moved.length === 1 ? 'document' : 'documents') : (moved.length === 1 ? 'item' : 'items')
    // One pass can drain two drags (see the `while` above), and they need not share a
    // destination — naming the last one would attribute every row to a folder some never went to.
    const destinations = new Set(moved.map(m => m.toFolder))
    toast.add({
      color: 'success',
      title: moved.length === 1 ? `Moved "${moved[0]!.label}"` : `Moved ${moved.length} ${noun}`,
      description: destinations.size === 1 ? `→ ${[...destinations][0]}` : undefined
    })
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
  stopPointerTracking()
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
        :aria-multiselectable="level === 1 ? 'true' : undefined"
        :class="[
          level === 1 ? 'min-h-full' : 'border-s border-default ms-5',
          // A hairline so an expanded empty folder's list is not literally zero-height (which is
          // what `emptyInsertThreshold` needs something to widen). It is deliberately NOT grown
          // during a drag: an earlier pass expanded every empty list to 1.5rem while dragging,
          // which moved every row below it the instant the drag began — so the folder you had
          // aimed at was no longer under the pointer. An empty folder is reached by dropping on
          // its ROW instead (see `dropOverrideFolder`), which needs no layout change at all.
          level === 1 ? '' : 'min-h-2'
        ]"
      >
        <!-- Interactivity lives on the <li>, NOT on the row <div> inside it: this is the element
             that carries role="treeitem" and the row's state, so it has to be the one that takes
             focus — otherwise focus lands on a generic div and a screen reader announces no item
             at all. `onRowPointer` filters out clicks bubbling up from nested rows. -->
        <li
          v-for="(item, index) in childrenByPath[path] ?? []"
          :key="item.id"
          class="mm-tree-node relative w-full focus:outline-none"
          :class="level > 1 ? 'ps-1.5 -ms-px' : ''"
          :data-path="item.path"
          :data-node-type="item.nodeType"
          role="treeitem"
          tabindex="0"
          :aria-level="level"
          :aria-setsize="(childrenByPath[path] ?? []).length"
          :aria-posinset="index + 1"
          :aria-expanded="item.nodeType === 'folder' ? isExpanded(item.path) : undefined"
          :aria-selected="selectedId === item.id || marked.includes(item.path)"
          @click="onRowPointer($event, item)"
          @keydown.enter.prevent="onRowKey($event, item)"
        >
          <UContextMenu :items="item.nodeType === 'file' ? fileMenuItems(item) : folderMenuItems(item)">
            <div class="mm-tree-row w-full flex items-center rounded-md px-2.5 py-1.5 text-sm select-none cursor-pointer">
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

    <!-- Multi-document project-change confirm. A single-file drag into a project folder is the
         intended way to associate a document and stays ungated; doing it to a whole selection in
         one gesture is what this stops from happening silently. Folders in the selection are
         gated separately by the real `impact` check (see `moveFolder`). -->
    <UModal
      :open="bulkConfirm.open"
      @update:open="onBulkConfirmOpenChange"
    >
      <template #content>
        <UCard>
          <template #header>
            <div class="flex items-center gap-2 text-warning">
              <UIcon
                name="i-lucide-triangle-alert"
                class="size-5"
              />
              <span class="font-semibold">This changes project membership</span>
            </div>
          </template>

          <p class="text-sm">
            <template v-if="bulkConfirm.toProject">
              Move <strong>{{ bulkConfirm.count }}</strong>
              document{{ bulkConfirm.count === 1 ? '' : 's' }} into project
              <strong class="font-mono">{{ bulkConfirm.toProject }}</strong>?
            </template>
            <template v-else>
              Move <strong>{{ bulkConfirm.count }}</strong>
              document{{ bulkConfirm.count === 1 ? '' : 's' }} out of their project?
            </template>
          </p>
          <p class="text-xs text-muted mt-2">
            A document's project follows its path, so filing
            {{ bulkConfirm.count === 1 ? 'it' : 'them' }} under
            <span class="font-mono">{{ bulkConfirm.toFolder }}</span> re-associates
            {{ bulkConfirm.count === 1 ? 'it' : 'them' }}.
          </p>

          <template #footer>
            <div class="flex justify-end gap-2">
              <UButton
                color="neutral"
                variant="ghost"
                @click="cancelBulkMove"
              >
                Cancel
              </UButton>
              <UButton
                color="warning"
                @click="acceptBulkMove"
              >
                Move {{ bulkConfirm.count }} document{{ bulkConfirm.count === 1 ? '' : 's' }}
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

/* Focus lives on the <li role="treeitem">, but that element encloses the folder's whole open
   subtree — a ring on it would draw a box around every descendant. Paint the ring on the row it
   owns instead, so keyboard focus reads as one row. */
.mm-tree-node:focus-visible > .mm-tree-row {
  outline: 2px solid var(--ui-primary);
  outline-offset: -2px;
  border-radius: 0.375rem;
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
