<script setup lang="ts">
import type { ProjectDTO } from '~~/shared/types/tasks'

definePageMeta({ title: 'Projects' })

const { create: createProject, update: updateProject, useProjectList } = useProjects()
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

// ── Edit / Delete (delegated to ProjectEditModal) ─────────────────────────────
const showEditModal = ref(false)
const editingProject = ref<ProjectDTO | null>(null)

function openEditModal(project: ProjectDTO) {
  editingProject.value = project
  showEditModal.value = true
}

function onSaved() {
  refetch()
}

function onDeleted() {
  refetch()
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
              @click="openEditModal(project)"
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

  <!-- ── Edit + Delete modal (reusable component) ─────────────────────────── -->
  <ProjectEditModal
    v-model:open="showEditModal"
    :project="editingProject"
    @saved="onSaved"
    @deleted="onDeleted"
  />
</template>
