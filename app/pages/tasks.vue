<script setup lang="ts">
import type { TaskDTO, TaskStatus, TaskPriority, ProjectDTO } from '~~/shared/types/tasks'

definePageMeta({ title: 'Tasks' })

const { list: listTasks, create: createTask, update: updateTask, move: moveTask, remove: removeTask } = useTasks()
const { list: listProjects } = useProjects()
const toast = useToast()

// ── Data ──────────────────────────────────────────────────────────────────────
const tasks = ref<TaskDTO[]>([])
const projects = ref<ProjectDTO[]>([])
const loading = ref(false)

// ── Filters ───────────────────────────────────────────────────────────────────
const FILTER_ALL = '__all__'
const filterProject = ref<string>(FILTER_ALL)
const filterPriority = ref<string>(FILTER_ALL)

// ── Column definitions ────────────────────────────────────────────────────────
const COLUMNS: { key: TaskStatus, label: string }[] = [
  { key: 'todo', label: 'Todo' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'completed', label: 'Completed' },
  { key: 'blocked', label: 'Blocked' }
]

const filteredTasks = computed(() => {
  return tasks.value.filter(t => {
    const projectMatch = filterProject.value === FILTER_ALL || t.project === filterProject.value
    const priorityMatch = filterPriority.value === FILTER_ALL || t.priority === filterPriority.value
    return projectMatch && priorityMatch
  })
})

const tasksByStatus = computed(() => {
  const map = Object.fromEntries(COLUMNS.map(c => [c.key, [] as TaskDTO[]])) as Record<TaskStatus, TaskDTO[]>
  for (const t of filteredTasks.value) {
    if (map[t.status]) map[t.status].push(t)
  }
  return map
})

// ── Load data ─────────────────────────────────────────────────────────────────
async function loadTasks() {
  loading.value = true
  try {
    // Pass project server-side if filtered; priority is client-side only
    const projectParam = filterProject.value !== FILTER_ALL ? filterProject.value : undefined
    tasks.value = await listTasks(projectParam ? { project: projectParam } : undefined)
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Failed to load tasks', description: err.data?.statusMessage ?? err.message })
  } finally {
    loading.value = false
  }
}

async function loadProjects() {
  try {
    projects.value = await listProjects(true)
  } catch {
    // non-fatal; projects just won't appear in selects
  }
}

onMounted(() => {
  loadTasks()
  loadProjects()
})

// Re-fetch when project filter changes (server-side); priority is client-side
watch(filterProject, loadTasks)

// ── Drag-and-drop state ───────────────────────────────────────────────────────
const dragTaskId = ref<string | null>(null)
const dragTaskStatus = ref<TaskStatus | null>(null)
const dragOverColumn = ref<TaskStatus | null>(null)

function onDragStart(event: DragEvent, task: TaskDTO) {
  dragTaskId.value = task.id
  dragTaskStatus.value = task.status
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', task.id)
  }
}

function onDragEnd() {
  dragTaskId.value = null
  dragTaskStatus.value = null
  dragOverColumn.value = null
}

function onDragOver(event: DragEvent, colStatus: TaskStatus) {
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragOverColumn.value = colStatus
}

function onDragLeave(colStatus: TaskStatus) {
  if (dragOverColumn.value === colStatus) dragOverColumn.value = null
}

async function onDrop(event: DragEvent, colStatus: TaskStatus) {
  event.stopPropagation()
  dragOverColumn.value = null
  const id = dragTaskId.value
  const fromStatus = dragTaskStatus.value
  dragTaskId.value = null
  dragTaskStatus.value = null
  if (!id || fromStatus === colStatus) return
  try {
    await moveTask(id, { status: colStatus })
    await loadTasks()
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Failed to move task', description: err.data?.statusMessage ?? err.message })
  }
}

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
    await loadTasks()
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
    await loadTasks()
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
    await loadTasks()
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
          class="flex flex-col gap-3 min-w-64 w-64 shrink-0 rounded-lg transition-colors"
          :class="dragOverColumn === col.key ? 'bg-primary/5 ring-2 ring-primary/30' : ''"
          @dragover="onDragOver($event, col.key)"
          @dragleave="onDragLeave(col.key)"
          @drop="onDrop($event, col.key)"
        >
          <!-- Column header -->
          <div class="flex items-center gap-2 px-1">
            <span class="text-sm font-semibold text-highlighted">{{ col.label }}</span>
            <UBadge
              :label="String(tasksByStatus[col.key].length)"
              color="neutral"
              variant="soft"
              size="xs"
            />
          </div>

          <!-- Empty state / drop zone -->
          <div
            v-if="tasksByStatus[col.key].length === 0"
            class="flex items-center justify-center h-20 rounded-lg border border-dashed transition-colors"
            :class="dragOverColumn === col.key ? 'border-primary/50 text-primary' : 'border-muted text-muted'"
          >
            <span class="text-sm">{{ dragTaskId ? 'Drop here' : 'No tasks' }}</span>
          </div>

          <!-- Task cards -->
          <div
            v-for="task in tasksByStatus[col.key]"
            :key="task.id"
            draggable="true"
            class="rounded-lg border border-default bg-elevated/50 p-3 flex flex-col gap-2 cursor-grab active:cursor-grabbing hover:bg-elevated transition-all select-none"
            :class="dragTaskId === task.id ? 'opacity-40 ring-2 ring-primary/50' : ''"
            @dragstart="onDragStart($event, task)"
            @dragend="onDragEnd"
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
              <UBadge
                v-if="task.project"
                :label="projects.find(p => p.slug === task.project)?.name ?? task.project"
                color="neutral"
                variant="outline"
                size="xs"
              />
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
