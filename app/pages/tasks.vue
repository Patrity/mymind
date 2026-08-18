<script setup lang="ts">
import { useSortable, insertNodeAt, removeNode } from '@vueuse/integrations/useSortable'
import type Sortable from 'sortablejs'
import type { ComponentPublicInstance } from 'vue'
import type { TaskDTO, TaskPriority, ProjectDTO } from '~~/shared/types/tasks'
import type { TaskColumnDTO, TaskColumnColor } from '~~/shared/types/task-columns'

definePageMeta({ title: 'Tasks' })

const { useTaskList, create: createTask, update: updateTask, move: moveTask, remove: removeTask } = useTasks()
const { useColumnList } = useTaskColumns()
const { useProjectList } = useProjects()
const toast = useToast()

// ── Data ──────────────────────────────────────────────────────────────────────
const { data: projectsData } = useProjectList(true)
const projects = computed<ProjectDTO[]>(() => projectsData.value ?? [])

// ── Filters ───────────────────────────────────────────────────────────────────
const FILTER_ALL = '__all__'
const filterProject = ref<string>(FILTER_ALL)
const filterPriority = ref<string>(FILTER_ALL)

// ── Live task list (vue-query) ─────────────────────────────────────────────────
// Project filter is applied server-side via the query key (slug or undefined for
// "all"); changing it refetches and the watcher below rebuilds the columns.
// Priority filter is client-side (see filteredTasks). SSE 'task' events invalidate
// ['task','list'] → refetch → watcher rebuilds (drag-guarded).
const { data: taskData, refetch, isPending } = useTaskList(
  () => (filterProject.value !== FILTER_ALL ? filterProject.value : undefined)
)
const tasks = computed<TaskDTO[]>(() => taskData.value ?? [])

// ── Column definitions (server data, NOT hardcoded) ─────────────────────────────
// GET /api/task-columns already returns rows ordered by `position` — render that
// order as-is, never re-sort or re-cap it client-side.
const { data: columnsData, isPending: isColumnsPending } = useColumnList()
const columns = computed<TaskColumnDTO[]>(() => columnsData.value ?? [])

// Show the skeleton until BOTH the tasks and the columns have loaded at least once.
const loading = computed(() =>
  (isPending.value && !taskData.value) || (isColumnsPending.value && !columnsData.value)
)
// A fixed placeholder count for the loading skeleton — the real column count isn't known
// until the columns query resolves (which is exactly what `loading` is gating on).
const SKELETON_COLUMN_COUNT = 4

// Column colour arrives as DATA (column.color), so the tint can't be a constructed class
// like `bg-${column.color}/5` — Tailwind's scanner only emits classes it can see literally
// in source, so an interpolated name gets purged from the build and the column renders with
// no background at all. This static map keeps every class string literal so the scanner
// picks it up.
const TINT: Record<TaskColumnColor, string> = {
  primary: 'bg-primary/5',
  secondary: 'bg-secondary/5',
  success: 'bg-success/5',
  info: 'bg-info/5',
  warning: 'bg-warning/5',
  error: 'bg-error/5',
  neutral: 'bg-elevated'
}

// Priority filter is client-side only (project is handled server-side by the query).
const filteredTasks = computed(() => {
  return tasks.value.filter(t => {
    return filterPriority.value === FILTER_ALL || t.priority === filterPriority.value
  })
})

// Mutable per-column arrays that useSortable splices in place, keyed by column id
// (not status — a board can carry several columns of the same kind). Each column
// binds to its OWN array so Sortable's in-place mutation doesn't fight a shared
// list. Rebuilt from server truth via the drag-guarded watcher below. Populated
// lazily as columns arrive (the columns query is async), not from a static list.
const columnsTasks = reactive<Record<string, TaskDTO[]>>({})

// True while a card is held. A live refetch (SSE invalidation) that lands mid-drag
// must NOT rebuild the columns — that would yank the card out of the user's hand.
// onStart sets this true; onCardMoved clears it synchronously (see onCardMoved).
const isDragging = ref(false)

// True while rebuildColumns is writing server truth into columnsTasks. The drag-persistence
// watch below (watch(columnsTasks, ...)) must NOT treat that as a user edit to re-persist —
// same "which direction did this change come from" problem AssignmentChain.vue solves with
// `syncingFromProps`. Reset via nextTick (not synchronously) so it's still true when the watch's
// own flush runs for this mutation, mirroring AssignmentChain.vue:24-26.
let syncingFromServer = false

function rebuildColumns(cols: TaskColumnDTO[], list: TaskDTO[]) {
  const byColumn: Record<string, TaskDTO[]> = Object.fromEntries(cols.map(c => [c.id, [] as TaskDTO[]]))
  for (const t of list) {
    if (byColumn[t.columnId]) byColumn[t.columnId]!.push(t)
  }
  syncingFromServer = true
  for (const col of cols) {
    if (!columnsTasks[col.id]) columnsTasks[col.id] = []
    // Rebuild in place so the reactive proxy + Sortable observe the same array.
    columnsTasks[col.id]!.splice(0, columnsTasks[col.id]!.length, ...byColumn[col.id]!)
  }
  nextTick(() => { syncingFromServer = false })
}

// Rebuild whenever the columns or the (priority-filtered) task data change — but
// never mid-drag.
watch([columns, filteredTasks], ([cols, list]) => {
  if (!isDragging.value) rebuildColumns(cols, list)
}, { immediate: true })

// ── Drag-and-drop (useSortable, shared-group columns) ──────────────────────────
// One sortable per column, all in group 'tasks' so cards drag between columns.
//
// THE TRAP (see AssignmentChain.vue:9-14 for the canonical writeup): useSortable's default
// onUpdate (same-column reorder) splices the bound array only after a nextTick — reading that
// array inside onEnd races the splice and persists the PRE-drop order (the row "snaps back"
// after refetch). So persistence here is driven by a deep watch on columnsTasks, never by
// reading list state inside onEnd. onEnd is used ONLY for the one thing it's safe to read
// synchronously — stable DOM attributes (evt.item.dataset.id, evt.to/from.dataset.columnId) —
// and, for a cross-column move, to make the column-array mutation happen at all (vueuse's
// default onUpdate only wires same-list reorders; a drag between two different useSortable
// instances/arrays isn't handled unless we do it ourselves).
const colRefs = shallowReactive<Record<string, HTMLElement | null>>({})

function setColRef(id: string, el: Element | ComponentPublicInstance | null) {
  // Vue function refs must return void — wrap the assignment in a block statement.
  colRefs[id] = (el as HTMLElement | null) ?? null
  return
}

// Columns touched by the most recent drag(s) — set from onCardMoved's stable DOM attributes,
// drained by persistTouchedColumns below. Scoping to just the touched column(s) (rather than
// re-diffing every column on every change) means a drag inside one column never rewrites order
// on tasks in a column the user never touched (see "don't re-sort/re-cap server data beyond the
// drag's own reordering").
const touchedColumnIds = new Set<string>()

function onCardMoved(evt: Sortable.SortableEvent) {
  // Clear the drag guard synchronously (same timing the pre-existing same-column branch already
  // relied on): the model mutation below (same-column via vueuse, cross-column via the nextTick
  // splice) lands on the microtask queue well before any SSE-driven refetch could arrive over
  // the network, so re-opening the rebuild watcher here doesn't race it.
  isDragging.value = false

  const fromColumnId = evt.from.dataset.columnId
  const toColumnId = evt.to.dataset.columnId
  if (!fromColumnId || !toColumnId) return
  // Recorded synchronously, BEFORE the watch below's (deferred) callback ever runs — whichever
  // mutation path fires it (vueuse's default onUpdate for same-column, or the splice below for
  // cross-column) always triggers watch(columnsTasks) on its own, so this only needs to record
  // WHICH column(s), not schedule anything itself.
  touchedColumnIds.add(fromColumnId)
  touchedColumnIds.add(toColumnId)
  if (fromColumnId === toColumnId) return // same-column: vueuse's default onUpdate already handles the splice

  const fromList = columnsTasks[fromColumnId]
  const toList = columnsTasks[toColumnId]
  const { oldIndex, newIndex } = evt
  if (!fromList || !toList || oldIndex == null || newIndex == null) return

  // Cross-column move: replicate vueuse's own moveArrayElement dance (see useSortable.js) across
  // TWO arrays instead of one. Sortable has already physically moved evt.item into the
  // destination container's DOM — undo that (removeNode + insertNodeAt back at its ORIGINAL
  // position) so the DOM matches what Vue last rendered, then let Vue perform the actual visual
  // move itself by splicing the bound arrays a tick later. Skipping the undo would leave the DOM
  // and Vue's vnode model disagreeing about which container owns the node.
  removeNode(evt.item)
  insertNodeAt(evt.from, evt.item, oldIndex)
  nextTick(() => {
    const [moved] = fromList.splice(oldIndex, 1)
    if (moved) toList.splice(newIndex, 0, moved)
  })
}

// The actual persistence — reads touchedColumnIds (not the raw watch trigger) and only fires from
// a SETTLED array state, never from onEnd itself (the trap, see onCardMoved above and
// AssignmentChain.vue:9-14). "Settled" matters because useSortable's default onUpdate (same-
// column reorder) — and our own cross-column splice above — both mutate the bound array in TWO
// steps: a synchronous removal, then a Vue `nextTick`-deferred re-insertion. A deep watch on
// columnsTasks fires on EACH step, so reading state on the FIRST fire (item removed, not yet
// re-inserted) computes a wrong diff from a half-settled array — confirmed by instrumenting this
// watch during browser validation: dragging a card to the top of its column right past a task
// that has the same stored `order` produced a diff that skipped the dragged card entirely.
// Debouncing past the mutation via a macrotask (setTimeout 0, which always runs after every
// currently-queued microtask/nextTick has drained) guarantees we only ever read the fully-settled
// array. `while (touchedColumnIds.size)` inside persistTouchedColumns re-drains anything a NEW
// drag adds while a previous persist's network calls are still in flight, so a rapid second drag
// can't get silently dropped.
let persisting = false
let debounceHandle: ReturnType<typeof setTimeout> | null = null

function schedulePersist() {
  if (debounceHandle != null) clearTimeout(debounceHandle)
  debounceHandle = setTimeout(() => {
    debounceHandle = null
    persistTouchedColumns()
  }, 0)
}

async function persistTouchedColumns() {
  if (persisting) return
  persisting = true
  try {
    while (touchedColumnIds.size > 0) {
      const colIds = [...touchedColumnIds]
      touchedColumnIds.clear()
      for (const colId of colIds) {
        const list = [...(columnsTasks[colId] ?? [])]
        for (const [order, task] of list.entries()) {
          const patch: { columnId?: string, order?: number } = {}
          if (task.columnId !== colId) patch.columnId = colId
          if (task.order !== order) patch.order = order
          if (Object.keys(patch).length === 0) continue
          await moveTask(task.id, patch)
        }
      }
    }
    // Explicit local reconcile (each move's own SSE emit also invalidates).
    await refetch()
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Failed to save card order', description: err.data?.statusMessage ?? err.message })
  } finally {
    persisting = false
  }
}

// Deep watch on columnsTasks is what tells us a drag's mutation actually landed (see the trap
// writeup above) — it only drives WHEN to check, never what to persist (that's touchedColumnIds).
watch(columnsTasks, () => {
  if (syncingFromServer) return
  schedulePersist()
}, { deep: true })

// The column set isn't known until the (async) columns query resolves, so sortables
// are set up lazily per column the first time it's seen, rather than in one static
// onMounted loop. `watchElement: true` still handles late DOM binding for the loading
// skeleton -> board swap, same as before.
const sortableInitialized = new Set<string>()

function ensureSortable(col: TaskColumnDTO) {
  if (sortableInitialized.has(col.id)) return
  sortableInitialized.add(col.id)
  if (!columnsTasks[col.id]) columnsTasks[col.id] = []
  useSortable(() => colRefs[col.id], columnsTasks[col.id]!, {
    watchElement: true,
    group: 'tasks',
    animation: 150,
    handle: '.task-card',
    ghostClass: 'opacity-40',
    dragClass: 'ring-2',
    // Guard the drag window: while a card is held, a live refetch must not
    // rebuild the columns (see isDragging + the watcher above).
    onStart: () => { isDragging.value = true },
    onEnd: onCardMoved
  })
}

onMounted(() => {
  watch(columns, (cols) => {
    for (const col of cols) ensureSortable(col)
  }, { immediate: true })
})

// ── New task modal ────────────────────────────────────────────────────────────
const showNewModal = ref(false)
const saving = ref(false)

const emptyForm = () => ({
  title: '',
  description: '',
  columnId: columns.value[0]?.id ?? '',
  priority: 'medium' as TaskPriority,
  dueDate: '',
  project: null as string | null
})

const newForm = ref(emptyForm())

function openNewModal() {
  newForm.value = emptyForm()
  showNewModal.value = true
}

async function submitNew() {
  if (!newForm.value.title.trim()) return
  saving.value = true
  try {
    await createTask({
      title: newForm.value.title.trim(),
      description: newForm.value.description || undefined,
      columnId: newForm.value.columnId || undefined,
      priority: newForm.value.priority,
      dueDate: newForm.value.dueDate || null,
      project: newForm.value.project || null
    })
    showNewModal.value = false
    await refetch()
    toast.add({ color: 'success', title: 'Task created' })
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Failed to create task', description: err.data?.statusMessage ?? err.message })
  } finally {
    saving.value = false
  }
}

// ── Edit task modal ───────────────────────────────────────────────────────────
const showEditModal = ref(false)
const editingTask = ref<TaskDTO | null>(null)
const editForm = ref(emptyForm())
const editSaving = ref(false)
const deleting = ref(false)

function openEditModal(task: TaskDTO) {
  editingTask.value = task
  editForm.value = {
    title: task.title,
    description: task.description ?? '',
    columnId: task.columnId,
    priority: task.priority,
    dueDate: task.dueDate ? task.dueDate.slice(0, 10) : '',
    project: task.project
  }
  showEditModal.value = true
}

async function submitEdit() {
  if (!editingTask.value || !editForm.value.title.trim()) return
  editSaving.value = true
  try {
    await updateTask(editingTask.value.id, {
      title: editForm.value.title.trim(),
      description: editForm.value.description || undefined,
      columnId: editForm.value.columnId || undefined,
      priority: editForm.value.priority,
      dueDate: editForm.value.dueDate || null,
      project: editForm.value.project || null
    })
    showEditModal.value = false
    await refetch()
    toast.add({ color: 'success', title: 'Task updated' })
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Failed to update task', description: err.data?.statusMessage ?? err.message })
  } finally {
    editSaving.value = false
  }
}

async function deleteTask() {
  if (!editingTask.value) return
  if (!confirm(`Delete "${editingTask.value.title}"?`)) return
  deleting.value = true
  try {
    await removeTask(editingTask.value.id)
    showEditModal.value = false
    await refetch()
    toast.add({ color: 'success', title: 'Task deleted' })
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Failed to delete task', description: err.data?.statusMessage ?? err.message })
  } finally {
    deleting.value = false
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const priorityColor: Record<TaskPriority, 'neutral' | 'warning' | 'error'> = {
  low: 'neutral',
  medium: 'warning',
  high: 'error'
}

function isOverdue(task: TaskDTO): boolean {
  if (!task.dueDate || task.status === 'completed') return false
  return new Date(task.dueDate) < new Date()
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const columnItems = computed(() => columns.value.map(c => ({ label: c.name, value: c.id })))

const priorityItems = [
  { label: 'Low', value: 'low' as TaskPriority },
  { label: 'Medium', value: 'medium' as TaskPriority },
  { label: 'High', value: 'high' as TaskPriority }
]

const filterPriorityItems = [
  { label: 'All priorities', value: FILTER_ALL },
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' }
]

const PROJECT_NONE = '__none__'

const projectItems = computed(() => [
  { label: '— none —', value: PROJECT_NONE },
  ...projects.value.map(p => ({ label: p.name, value: p.slug }))
])

const filterProjectItems = computed(() => [
  { label: 'All projects', value: FILTER_ALL },
  ...projects.value.map(p => ({ label: p.name, value: p.slug }))
])
</script>

<template>
  <UDashboardPanel
    id="tasks-board"
    grow
    :ui="{ body: '!p-0' }"
  >
    <template #header>
      <UDashboardNavbar title="Tasks">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <!-- Priority filter -->
          <USelect
            v-model="filterPriority"
            :items="filterPriorityItems"
            size="xs"
            class="w-36"
          />
          <!-- Project filter -->
          <USelect
            v-model="filterProject"
            :items="filterProjectItems"
            size="xs"
            class="w-36"
          />
          <UButton
            icon="i-lucide-plus"
            size="xs"
            color="primary"
            label="New task"
            @click="openNewModal"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- Loading skeleton -->
      <div
        v-if="loading"
        class="flex gap-4 p-4 h-full overflow-x-auto"
      >
        <div
          v-for="i in SKELETON_COLUMN_COUNT"
          :key="i"
          class="flex flex-col gap-3 min-w-64 w-64 shrink-0"
        >
          <USkeleton class="h-7 w-full" />
          <USkeleton
            v-for="j in 3"
            :key="j"
            class="h-28 w-full"
          />
        </div>
      </div>

      <!-- Kanban board -->
      <div
        v-else
        class="flex gap-4 p-4 h-full overflow-x-auto"
      >
        <div
          v-for="col in columns"
          :key="col.id"
          class="flex flex-col gap-3 min-w-64 w-64 shrink-0 rounded-lg p-2"
          :class="TINT[col.color]"
        >
          <!-- Column header -->
          <div class="flex items-center gap-2 px-1">
            <span class="text-sm font-semibold text-highlighted">{{ col.name }}</span>
            <UBadge
              :label="String(columnsTasks[col.id]?.length ?? 0)"
              color="neutral"
              variant="soft"
              size="xs"
            />
          </div>

          <!-- Card list (sortable container; group 'tasks'). Keeps a min height
               so empty columns remain a valid drop target; dashed border + hint
               act as the empty affordance. -->
          <div
            :ref="(el: Element | ComponentPublicInstance | null) => setColRef(col.id, el)"
            :data-column-id="col.id"
            class="flex flex-col gap-3 min-h-20 rounded-lg"
            :class="(columnsTasks[col.id]?.length ?? 0) === 0
              ? 'items-center justify-center border border-dashed border-muted text-muted'
              : ''"
          >
            <!-- Empty hint (non-sortable: only rendered when no cards) -->
            <span
              v-if="(columnsTasks[col.id]?.length ?? 0) === 0"
              class="text-sm pointer-events-none"
            >No tasks</span>

            <!-- Task cards -->
            <div
              v-for="task in columnsTasks[col.id]"
              :key="task.id"
              :data-id="task.id"
              class="task-card w-full rounded-lg border border-default bg-elevated/50 p-3 flex flex-col gap-2 cursor-grab active:cursor-grabbing hover:bg-elevated transition-colors select-none"
              @click="openEditModal(task)"
            >
              <!-- Title -->
              <p class="text-sm font-medium text-highlighted leading-snug">
                {{ task.title }}
              </p>

              <!-- Badges row -->
              <div class="flex flex-wrap items-center gap-1.5">
                <UBadge
                  :label="task.priority"
                  :color="priorityColor[task.priority]"
                  variant="subtle"
                  size="xs"
                />
                <span
                  v-if="task.dueDate"
                  :class="['text-xs font-medium', isOverdue(task) ? 'text-error' : 'text-muted']"
                >
                  {{ formatDate(task.dueDate) }}
                </span>
                <ProjectBadge
                  v-if="task.project"
                  :slug="task.project"
                  :to="null"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </UDashboardPanel>

  <!-- ── New task modal ─────────────────────────────────────────────────────── -->
  <UModal v-model:open="showNewModal">
    <template #content>
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-square-plus"
              class="size-5"
            />
            <span class="font-semibold">New task</span>
          </div>
        </template>

        <div class="flex flex-col gap-4">
          <UFormField
            label="Title"
            required
          >
            <UInput
              v-model="newForm.title"
              placeholder="Task title"
              autofocus
              class="w-full"
              @keyup.enter="submitNew"
            />
          </UFormField>

          <UFormField label="Description">
            <UTextarea
              v-model="newForm.description"
              placeholder="Optional description…"
              :rows="5"
              class="w-full"
            />
          </UFormField>

          <div class="grid grid-cols-2 gap-3">
            <UFormField label="Column">
              <USelect
                v-model="newForm.columnId"
                :items="columnItems"
                class="w-full"
              />
            </UFormField>

            <UFormField label="Priority">
              <USelect
                v-model="newForm.priority"
                :items="priorityItems"
                class="w-full"
              />
            </UFormField>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <UFormField label="Due date">
              <UInput
                v-model="newForm.dueDate"
                type="date"
                class="w-full"
              />
            </UFormField>

            <UFormField label="Project">
              <USelect
                :model-value="newForm.project ?? PROJECT_NONE"
                :items="projectItems"
                class="w-full"
                @update:model-value="newForm.project = ($event as string) === PROJECT_NONE ? null : ($event as string) || null"
              />
            </UFormField>
          </div>
        </div>

        <template #footer>
          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              @click="showNewModal = false"
            >
              Cancel
            </UButton>
            <UButton
              :loading="saving"
              :disabled="!newForm.title.trim()"
              @click="submitNew"
            >
              Create
            </UButton>
          </div>
        </template>
      </UCard>
    </template>
  </UModal>

  <!-- ── Edit task modal ────────────────────────────────────────────────────── -->
  <UModal v-model:open="showEditModal">
    <template #content>
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-square-pen"
              class="size-5"
            />
            <span class="font-semibold">Edit task</span>
          </div>
        </template>

        <div class="flex flex-col gap-4">
          <UFormField
            label="Title"
            required
          >
            <UInput
              v-model="editForm.title"
              placeholder="Task title"
              autofocus
              class="w-full"
              @keyup.enter="submitEdit"
            />
          </UFormField>

          <UFormField label="Description">
            <UTextarea
              v-model="editForm.description"
              placeholder="Optional description…"
              :rows="5"
              class="w-full"
            />
          </UFormField>

          <div class="grid grid-cols-2 gap-3">
            <UFormField label="Column">
              <USelect
                v-model="editForm.columnId"
                :items="columnItems"
                class="w-full"
              />
            </UFormField>

            <UFormField label="Priority">
              <USelect
                v-model="editForm.priority"
                :items="priorityItems"
                class="w-full"
              />
            </UFormField>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <UFormField label="Due date">
              <UInput
                v-model="editForm.dueDate"
                type="date"
                class="w-full"
              />
            </UFormField>

            <UFormField label="Project">
              <USelect
                :model-value="editForm.project ?? PROJECT_NONE"
                :items="projectItems"
                class="w-full"
                @update:model-value="editForm.project = ($event as string) === PROJECT_NONE ? null : ($event as string) || null"
              />
            </UFormField>
          </div>
        </div>

        <template #footer>
          <div class="flex justify-between gap-2">
            <UButton
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              :loading="deleting"
              @click="deleteTask"
            >
              Delete
            </UButton>
            <div class="flex gap-2">
              <UButton
                color="neutral"
                variant="ghost"
                @click="showEditModal = false"
              >
                Cancel
              </UButton>
              <UButton
                :loading="editSaving"
                :disabled="!editForm.title.trim()"
                @click="submitEdit"
              >
                Save
              </UButton>
            </div>
          </div>
        </template>
      </UCard>
    </template>
  </UModal>
</template>
