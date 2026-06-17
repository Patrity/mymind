<script setup lang="ts">
import { useSortable } from '@vueuse/integrations/useSortable'
import type Sortable from 'sortablejs'
import type { ComponentPublicInstance } from 'vue'
import type { TaskDTO, TaskStatus, TaskPriority, ProjectDTO } from '~~/shared/types/tasks'

definePageMeta({ title: 'Tasks' })

const { useTaskList, create: createTask, update: updateTask, move: moveTask, remove: removeTask } = useTasks()
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
// Show the skeleton only on the very first fetch (no data yet).
const loading = computed(() => isPending.value && !taskData.value)

// ── Column definitions ────────────────────────────────────────────────────────
const COLUMNS: { key: TaskStatus, label: string }[] = [
  { key: 'todo', label: 'Todo' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'completed', label: 'Completed' },
  { key: 'blocked', label: 'Blocked' }
]

// Priority filter is client-side only (project is handled server-side by the query).
const filteredTasks = computed(() => {
  return tasks.value.filter(t => {
    return filterPriority.value === FILTER_ALL || t.priority === filterPriority.value
  })
})

// Mutable per-column arrays that useSortable splices in place. Each column binds
// to its OWN array so Sortable's in-place mutation doesn't fight a shared list.
// Rebuilt from server truth via the drag-guarded watcher below.
const columnsTasks = reactive(
  Object.fromEntries(COLUMNS.map(c => [c.key, [] as TaskDTO[]]))
) as Record<TaskStatus, TaskDTO[]>

// True while a card is held. A live refetch (SSE invalidation) that lands mid-drag
// must NOT rebuild the columns — that would yank the card out of the user's hand.
// onStart sets this true; onCardMoved clears it in a finally after persisting.
const isDragging = ref(false)

function rebuildColumns(list: TaskDTO[]) {
  const byStatus = Object.fromEntries(COLUMNS.map(c => [c.key, [] as TaskDTO[]])) as Record<TaskStatus, TaskDTO[]>
  for (const t of list) {
    if (byStatus[t.status]) byStatus[t.status].push(t)
  }
  for (const col of COLUMNS) {
    // Rebuild in place so the reactive proxy + Sortable observe the same array.
    columnsTasks[col.key].splice(0, columnsTasks[col.key].length, ...byStatus[col.key])
  }
}

// Rebuild whenever the (priority-filtered) data changes — but never mid-drag.
watch(filteredTasks, (list) => {
  if (!isDragging.value) rebuildColumns(list)
}, { immediate: true })

// ── Drag-and-drop (useSortable, shared-group columns) ──────────────────────────
// One sortable per column, all in group 'tasks' so cards drag between columns.
// We read the move from DOM dataset (evt.item.dataset.id, evt.to/from.dataset.status)
// — reliable during onEnd — NOT from the bound arrays (which Sortable mutates after
// the drop, racing any read). On a cross-column move we persist + refetch() to
// reconcile; a same-column reorder is a no-op FOR PERSISTENCE only (no order
// field to save) — vueuse's default onUpdate still splices the local column
// array to match the DOM, since we override onEnd, not onUpdate.
const colRefs = shallowReactive(
  Object.fromEntries(COLUMNS.map(c => [c.key, null])) as Record<TaskStatus, HTMLElement | null>
)

function setColRef(key: TaskStatus, el: Element | ComponentPublicInstance | null) {
  // Vue function refs must return void — wrap the assignment in a block statement.
  colRefs[key] = (el as HTMLElement | null) ?? null
  return
}

async function onCardMoved(evt: Sortable.SortableEvent) {
  const id = evt.item.dataset.id
  const toStatus = evt.to.dataset.status as TaskStatus | undefined
  const fromStatus = evt.from.dataset.status as TaskStatus | undefined
  // Same-column reorder: no status change to persist (no order field). This is a
  // no-op for persistence only — vueuse's default onUpdate already spliced the
  // local column array to match the DOM (we override onEnd, not onUpdate). We
  // still clear the drag guard, and skip the refetch to preserve the current
  // "visual reorder not persisted" behavior (an SSE-driven refetch would snap
  // the DOM order back to server truth anyway).
  if (!id || !toStatus || toStatus === fromStatus) {
    isDragging.value = false
    return
  }
  try {
    await moveTask(id, { status: toStatus })
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Failed to move task', description: err.data?.statusMessage ?? err.message })
  } finally {
    // Re-open the watcher BEFORE refetch so the rebuild from server truth lands.
    isDragging.value = false
    // Explicit local reconcile (the move's own SSE emit also invalidates).
    await refetch()
  }
}

onMounted(() => {
  for (const col of COLUMNS) {
    useSortable(() => colRefs[col.key], columnsTasks[col.key], {
      // Re-watch the element ref so Sortable (re)initializes whenever the column
      // mounts. The board is gated behind v-else (loading skeleton is the v-if);
      // on first mount the query is pending so `loading` is true and colRefs are
      // null at the single tryOnMounted(start) tick. With watchElement we rebind
      // once the v-else board renders, and again on every loading toggle.
      watchElement: true,
      group: 'tasks',
      animation: 150,
      handle: '.task-card',
      ghostClass: 'opacity-40',
      dragClass: 'ring-2',
      // Guard the drag window: while a card is held, a live refetch must not
      // rebuild the columns (see isDragging + the filteredTasks watcher).
      onStart: () => { isDragging.value = true },
      onEnd: onCardMoved
    })
  }
})

// ── New task modal ────────────────────────────────────────────────────────────
const showNewModal = ref(false)
const saving = ref(false)

const emptyForm = () => ({
  title: '',
  description: '',
  status: 'todo' as TaskStatus,
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
      status: newForm.value.status,
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
    status: task.status,
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
      status: editForm.value.status,
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

const statusItems = COLUMNS.map(c => ({ label: c.label, value: c.key }))

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
          v-for="col in COLUMNS"
          :key="col.key"
          class="flex flex-col gap-3 min-w-64 w-64 shrink-0"
        >
          <USkeleton class="h-7 w-full" />
          <USkeleton
            v-for="i in 3"
            :key="i"
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
          v-for="col in COLUMNS"
          :key="col.key"
          class="flex flex-col gap-3 min-w-64 w-64 shrink-0 rounded-lg"
        >
          <!-- Column header -->
          <div class="flex items-center gap-2 px-1">
            <span class="text-sm font-semibold text-highlighted">{{ col.label }}</span>
            <UBadge
              :label="String(columnsTasks[col.key].length)"
              color="neutral"
              variant="soft"
              size="xs"
            />
          </div>

          <!-- Card list (sortable container; group 'tasks'). Keeps a min height
               so empty columns remain a valid drop target; dashed border + hint
               act as the empty affordance. -->
          <div
            :ref="(el: Element | ComponentPublicInstance | null) => setColRef(col.key, el)"
            :data-status="col.key"
            class="flex flex-col gap-3 min-h-20 rounded-lg"
            :class="columnsTasks[col.key].length === 0
              ? 'items-center justify-center border border-dashed border-muted text-muted'
              : ''"
          >
            <!-- Empty hint (non-sortable: only rendered when no cards) -->
            <span
              v-if="columnsTasks[col.key].length === 0"
              class="text-sm pointer-events-none"
            >No tasks</span>

            <!-- Task cards -->
            <div
              v-for="task in columnsTasks[col.key]"
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
              :rows="2"
              class="w-full"
            />
          </UFormField>

          <div class="grid grid-cols-2 gap-3">
            <UFormField label="Status">
              <USelect
                v-model="newForm.status"
                :items="statusItems"
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
              :rows="2"
              class="w-full"
            />
          </UFormField>

          <div class="grid grid-cols-2 gap-3">
            <UFormField label="Status">
              <USelect
                v-model="editForm.status"
                :items="statusItems"
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
