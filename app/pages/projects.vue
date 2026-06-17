<script setup lang="ts">
import type { ProjectDTO } from '~~/shared/types/tasks'
import { projectColor, PROJECT_PALETTE } from '~/utils/project-color'

definePageMeta({ title: 'Projects' })

const { create: createProject, update: updateProject, remove: removeProject, useProjectList } = useProjects()
const toast = useToast()

// ── Data ──────────────────────────────────────────────────────────────────────
const { data, refetch, isPending, error } = useProjectList()
const projects = computed(() => data.value ?? [])

watch(error, (err) => {
  if (!err) return
  const e = err as { data?: { statusMessage?: string }, message?: string }
  toast.add({ color: 'error', title: 'Failed to load projects', description: e.data?.statusMessage ?? e.message })
})

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// The palette swatch highlighted as "auto" when no override is set.
const autoColor = computed(() =>
  editingProject.value ? projectColor(editingProject.value.slug, null) : null
)

// ── Toggle active inline ───────────────────────────────────────────────────────
async function toggleActive(project: { slug: string }, active: boolean) {
  try {
    await updateProject(project.slug, { active })
    await refetch()
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
    await refetch()
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

interface EditForm {
  name: string
  description: string
  active: boolean
  color: string | null
  repositoryUrl: string | null
  productionUrl: string | null
  stagingUrl: string | null
  aliases: string[]
}

const emptyEditForm = (): EditForm => ({
  name: '',
  description: '',
  active: true,
  color: null,
  repositoryUrl: null,
  productionUrl: null,
  stagingUrl: null,
  aliases: []
})
const editForm = ref<EditForm>(emptyEditForm())

function openEditModal(project: ProjectDTO) {
  editingProject.value = project
  editForm.value = {
    name: project.name,
    description: project.description ?? '',
    active: project.active,
    color: project.color,
    repositoryUrl: project.repositoryUrl,
    productionUrl: project.productionUrl,
    stagingUrl: project.stagingUrl,
    aliases: [...project.aliases]
  }
  showEditModal.value = true
}

// Empty string in a URL field means "clear it" → send null.
function urlOrNull(v: string | null): string | null {
  const t = (v ?? '').trim()
  return t ? t : null
}

async function submitEdit() {
  if (!editingProject.value || !editForm.value.name.trim()) return
  editSaving.value = true
  try {
    await updateProject(editingProject.value.slug, {
      name: editForm.value.name.trim(),
      description: editForm.value.description.trim() || undefined,
      active: editForm.value.active,
      color: editForm.value.color,
      repositoryUrl: urlOrNull(editForm.value.repositoryUrl),
      productionUrl: urlOrNull(editForm.value.productionUrl),
      stagingUrl: urlOrNull(editForm.value.stagingUrl),
      aliases: editForm.value.aliases.map(a => a.trim()).filter(Boolean)
    })
    showEditModal.value = false
    await refetch()
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
    await refetch()
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
        v-if="isPending"
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
            <ProjectBadge
              :slug="project.slug"
              :name="project.name"
              :color="project.color"
              :to="false"
            />
            <p
              v-if="project.description"
              class="text-xs text-muted truncate mt-1"
            >
              {{ project.description }}
            </p>
            <div class="flex items-center gap-2 text-xs text-dimmed mt-1 min-w-0">
              <span
                v-if="project.gitRemoteKey"
                class="flex items-center gap-1 font-mono truncate min-w-0 max-w-[40%]"
              >
                <UIcon
                  name="i-lucide-git-branch"
                  class="size-3 shrink-0"
                />
                <span class="truncate">{{ project.gitRemoteKey }}</span>
              </span>
              <span class="shrink-0">{{ project.sessionCount }} sessions · {{ project.memoryCount }} memories</span>
              <span
                v-if="project.lastActivityAt"
                class="shrink-0"
              >Active {{ formatDate(project.lastActivityAt) }}</span>
            </div>
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

          <UFormField label="Repository URL">
            <UInput
              :model-value="editForm.repositoryUrl ?? ''"
              placeholder="https://github.com/owner/repo"
              class="w-full"
              @update:model-value="editForm.repositoryUrl = String($event)"
            />
          </UFormField>

          <UFormField label="Production URL">
            <UInput
              :model-value="editForm.productionUrl ?? ''"
              placeholder="https://example.com"
              class="w-full"
              @update:model-value="editForm.productionUrl = String($event)"
            />
          </UFormField>

          <UFormField label="Staging URL">
            <UInput
              :model-value="editForm.stagingUrl ?? ''"
              placeholder="https://staging.example.com"
              class="w-full"
              @update:model-value="editForm.stagingUrl = String($event)"
            />
          </UFormField>

          <UFormField
            label="Aliases"
            hint="Press enter to add"
          >
            <UInputTags
              v-model="editForm.aliases"
              placeholder="Add an alias…"
              class="w-full"
            />
          </UFormField>

          <UFormField label="Color">
            <div class="flex flex-col gap-3">
              <div class="flex flex-wrap items-center gap-2">
                <button
                  v-for="hex in PROJECT_PALETTE"
                  :key="hex"
                  type="button"
                  class="size-6 rounded-full ring-offset-2 ring-offset-default transition-all"
                  :class="(editForm.color === hex || (editForm.color === null && autoColor === hex)) ? 'ring-2 ring-inverted' : 'hover:scale-110'"
                  :style="{ backgroundColor: hex }"
                  :aria-label="`Set color ${hex}`"
                  @click="editForm.color = hex"
                >
                  <UIcon
                    v-if="editForm.color === hex || (editForm.color === null && autoColor === hex)"
                    name="i-lucide-check"
                    class="size-4 text-white"
                  />
                </button>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-rotate-ccw"
                  label="Reset to auto"
                  @click="editForm.color = null"
                />
              </div>
              <ProjectBadge
                :slug="editingProject?.slug ?? ''"
                :name="editForm.name"
                :color="editForm.color"
                :to="false"
              />
            </div>
          </UFormField>

          <div
            v-if="editingProject"
            class="flex flex-col gap-1.5 text-xs text-dimmed border-t border-default pt-3"
          >
            <div class="flex gap-2">
              <span class="font-medium shrink-0">git_remote_key:</span>
              <span class="font-mono truncate">{{ editingProject.gitRemoteKey ?? '—' }}</span>
            </div>
            <div class="flex gap-2">
              <span class="font-medium shrink-0">local_paths:</span>
              <span class="font-mono truncate">{{ editingProject.localPaths.length ? editingProject.localPaths.join(', ') : '—' }}</span>
            </div>
          </div>
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
