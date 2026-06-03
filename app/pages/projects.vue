<script setup lang="ts">
import type { ProjectDTO } from '~~/shared/types/tasks'

definePageMeta({ title: 'Projects' })

const { list: listProjects, create: createProject, update: updateProject, remove: removeProject } = useProjects()
const toast = useToast()

// ── Data ──────────────────────────────────────────────────────────────────────
const projects = ref<ProjectDTO[]>([])
const loading = ref(false)

async function loadProjects() {
  loading.value = true
  try {
    projects.value = await listProjects()
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Failed to load projects', description: err.data?.statusMessage ?? err.message })
  } finally {
    loading.value = false
  }
}

onMounted(loadProjects)

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Toggle active inline ───────────────────────────────────────────────────────
async function toggleActive(project: ProjectDTO, active: boolean) {
  try {
    await updateProject(project.slug, { active })
    project.active = active
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Failed to update project', description: err.data?.statusMessage ?? err.message })
  }
}

// ── New project modal ─────────────────────────────────────────────────────────
const showNewModal = ref(false)
const newSaving = ref(false)
const newSlugError = ref('')

const emptyNewForm = () => ({ name: '', description: '', slug: '' })
const newForm = ref(emptyNewForm())

function openNewModal() {
  newForm.value = emptyNewForm()
  newSlugError.value = ''
  showNewModal.value = true
}

async function submitNew() {
  if (!newForm.value.name.trim()) return
  newSaving.value = true
  newSlugError.value = ''
  try {
    await createProject({
      name: newForm.value.name.trim(),
      description: newForm.value.description.trim() || undefined,
      ...(newForm.value.slug.trim() ? { slug: newForm.value.slug.trim() } : {})
    })
    showNewModal.value = false
    await loadProjects()
    toast.add({ color: 'success', title: 'Project created' })
  } catch (e: unknown) {
    const err = e as { status?: number, statusCode?: number, data?: { statusMessage?: string }, message?: string }
    const status = err.status ?? err.statusCode
    if (status === 409) {
      newSlugError.value = 'A project with this slug already exists.'
    } else {
      toast.add({ color: 'error', title: 'Failed to create project', description: err.data?.statusMessage ?? err.message })
    }
  } finally {
    newSaving.value = false
  }
}

// ── Edit project modal ────────────────────────────────────────────────────────
const showEditModal = ref(false)
const editingProject = ref<ProjectDTO | null>(null)
const editSaving = ref(false)
const deleting = ref(false)
const showDeleteConfirm = ref(false)

const emptyEditForm = () => ({ name: '', description: '', active: true })
const editForm = ref(emptyEditForm())

function openEditModal(project: ProjectDTO) {
  editingProject.value = project
  editForm.value = {
    name: project.name,
    description: project.description ?? '',
    active: project.active
  }
  showEditModal.value = true
}

async function submitEdit() {
  if (!editingProject.value || !editForm.value.name.trim()) return
  editSaving.value = true
  try {
    await updateProject(editingProject.value.slug, {
      name: editForm.value.name.trim(),
      description: editForm.value.description.trim() || undefined,
      active: editForm.value.active
    })
    showEditModal.value = false
    await loadProjects()
    toast.add({ color: 'success', title: 'Project updated' })
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Failed to update project', description: err.data?.statusMessage ?? err.message })
  } finally {
    editSaving.value = false
  }
}

function openDeleteConfirm(project: ProjectDTO) {
  editingProject.value = project
  showDeleteConfirm.value = true
}

async function confirmDelete() {
  if (!editingProject.value) return
  deleting.value = true
  try {
    await removeProject(editingProject.value.slug)
    showDeleteConfirm.value = false
    showEditModal.value = false
    editingProject.value = null
    await loadProjects()
    toast.add({ color: 'success', title: 'Project deleted' })
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Failed to delete project', description: err.data?.statusMessage ?? err.message })
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <UDashboardPanel
    id="projects-panel"
    grow
  >
    <template #header>
      <UDashboardNavbar title="Projects">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            icon="i-lucide-plus"
            size="xs"
            color="primary"
            label="New project"
            @click="openNewModal"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- Loading -->
      <div
        v-if="loading"
        class="flex flex-col gap-3 p-6"
      >
        <USkeleton
          v-for="i in 3"
          :key="i"
          class="h-16 w-full"
        />
      </div>

      <!-- Empty state -->
      <div
        v-else-if="projects.length === 0"
        class="flex flex-col items-center justify-center h-full gap-3 text-muted"
      >
        <UIcon
          name="i-lucide-folder-kanban"
          class="size-12 text-dimmed"
        />
        <p class="text-sm">
          No projects yet.
        </p>
        <UButton
          size="sm"
          variant="outline"
          color="neutral"
          label="Create your first project"
          @click="openNewModal"
        />
      </div>

      <!-- Project list -->
      <div
        v-else
        class="flex flex-col divide-y divide-default"
      >
        <div
          v-for="project in projects"
          :key="project.slug"
          class="flex items-center gap-4 px-6 py-4 hover:bg-elevated/40 transition-colors group"
        >
          <!-- Icon -->
          <UIcon
            name="i-lucide-folder-kanban"
            class="size-5 text-muted shrink-0"
          />

          <!-- Name + description -->
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium text-highlighted truncate">
              {{ project.name }}
            </p>
            <p
              v-if="project.description"
              class="text-xs text-muted truncate mt-0.5"
            >
              {{ project.description }}
            </p>
            <p class="text-xs text-dimmed mt-0.5">
              {{ project.slug }} · Created {{ formatDate(project.createdAt) }}
            </p>
          </div>

          <!-- Active toggle -->
          <USwitch
            :model-value="project.active"
            size="sm"
            @update:model-value="toggleActive(project, $event)"
          />

          <!-- Actions -->
          <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <UButton
              icon="i-lucide-pencil"
              size="xs"
              color="neutral"
              variant="ghost"
              @click="openEditModal(project)"
            />
            <UButton
              icon="i-lucide-trash-2"
              size="xs"
              color="error"
              variant="ghost"
              @click="openDeleteConfirm(project)"
            />
          </div>
        </div>
      </div>
    </template>
  </UDashboardPanel>

  <!-- ── New project modal ──────────────────────────────────────────────────── -->
  <UModal v-model:open="showNewModal">
    <template #content>
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-folder-plus"
              class="size-5"
            />
            <span class="font-semibold">New project</span>
          </div>
        </template>

        <div class="flex flex-col gap-4">
          <UFormField
            label="Name"
            required
          >
            <UInput
              v-model="newForm.name"
              placeholder="Project name"
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

          <UFormField
            label="Slug"
            :error="newSlugError || undefined"
            hint="Optional — auto-generated from name"
          >
            <UInput
              v-model="newForm.slug"
              placeholder="my-project"
              class="w-full"
              @keyup.enter="submitNew"
            />
          </UFormField>
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
              :loading="newSaving"
              :disabled="!newForm.name.trim()"
              @click="submitNew"
            >
              Create
            </UButton>
          </div>
        </template>
      </UCard>
    </template>
  </UModal>

  <!-- ── Edit project modal ─────────────────────────────────────────────────── -->
  <UModal v-model:open="showEditModal">
    <template #content>
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-folder-pen"
              class="size-5"
            />
            <span class="font-semibold">Edit project</span>
          </div>
        </template>

        <div class="flex flex-col gap-4">
          <UFormField
            label="Name"
            required
          >
            <UInput
              v-model="editForm.name"
              placeholder="Project name"
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

          <UFormField label="Active">
            <USwitch
              v-model="editForm.active"
              label="Project is active"
            />
          </UFormField>
        </div>

        <template #footer>
          <div class="flex justify-between gap-2">
            <UButton
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              @click="editingProject && openDeleteConfirm(editingProject)"
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
                :disabled="!editForm.name.trim()"
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

  <!-- ── Delete confirm modal ───────────────────────────────────────────────── -->
  <UModal v-model:open="showDeleteConfirm">
    <template #content>
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-trash-2"
              class="size-5 text-error"
            />
            <span class="font-semibold">Delete project?</span>
          </div>
        </template>

        <p class="text-sm text-muted">
          Are you sure you want to delete
          <span class="font-medium text-highlighted">{{ editingProject?.name }}</span>?
          This cannot be undone.
        </p>

        <template #footer>
          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              @click="showDeleteConfirm = false"
            >
              Cancel
            </UButton>
            <UButton
              color="error"
              :loading="deleting"
              @click="confirmDelete"
            >
              Delete
            </UButton>
          </div>
        </template>
      </UCard>
    </template>
  </UModal>
</template>
