<script setup lang="ts">
import type { ProjectDTO } from '~~/shared/types/tasks'
import { PROJECT_PALETTE, NEUTRAL_COLOR } from '~/utils/project-color'

// ── Props / model / emits ────────────────────────────────────────────────────
const props = defineProps<{
  project: ProjectDTO | null
}>()

const open = defineModel<boolean>('open')

const emit = defineEmits<{
  saved: [ProjectDTO]
  deleted: [string]
}>()

// ── Composables ──────────────────────────────────────────────────────────────
const { update: updateProject, remove: removeProject } = useProjects()
const toast = useToast()

// ── Edit form ────────────────────────────────────────────────────────────────
interface EditForm {
  name: string
  description: string
  active: boolean
  slug: string
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
  slug: '',
  color: null,
  repositoryUrl: null,
  productionUrl: null,
  stagingUrl: null,
  aliases: []
})

const editForm = ref<EditForm>(emptyEditForm())
const editSaving = ref(false)
const slugError = ref('')

// Seed form when modal opens or project changes
watch(
  () => [open.value, props.project] as const,
  ([isOpen, project]) => {
    if (isOpen && project) {
      editForm.value = {
        name: project.name,
        description: project.description ?? '',
        active: project.active,
        slug: project.slug,
        color: project.color,
        repositoryUrl: project.repositoryUrl,
        productionUrl: project.productionUrl,
        stagingUrl: project.stagingUrl,
        aliases: [...project.aliases]
      }
      slugError.value = ''
    }
  },
  { immediate: true }
)

// Empty string in a URL field means "clear it" → send null.
function urlOrNull(v: string | null): string | null {
  const t = (v ?? '').trim()
  return t ? t : null
}

async function submitEdit() {
  if (!props.project || !editForm.value.name.trim()) return
  editSaving.value = true
  slugError.value = ''
  try {
    const body: Parameters<typeof updateProject>[1] = {
      name: editForm.value.name.trim(),
      description: editForm.value.description.trim() || undefined,
      active: editForm.value.active,
      color: editForm.value.color,
      repositoryUrl: urlOrNull(editForm.value.repositoryUrl),
      productionUrl: urlOrNull(editForm.value.productionUrl),
      stagingUrl: urlOrNull(editForm.value.stagingUrl),
      aliases: editForm.value.aliases.map(a => a.trim()).filter(Boolean)
    }
    // Only include slug in PATCH body if it changed
    if (editForm.value.slug.trim() !== props.project.slug) {
      body.slug = editForm.value.slug.trim()
    }
    const updated = await updateProject(props.project.slug, body)
    open.value = false
    toast.add({ color: 'success', title: 'Project updated' })
    emit('saved', updated)
  } catch (e: unknown) {
    const err = e as { status?: number, statusCode?: number, data?: { statusMessage?: string }, message?: string }
    const status = err.status ?? err.statusCode
    if (status === 409) {
      slugError.value = 'A project with this slug already exists.'
    } else {
      toast.add({ color: 'error', title: 'Failed to update project', description: err.data?.statusMessage ?? err.message })
    }
  } finally {
    editSaving.value = false
  }
}

// ── Delete flow ──────────────────────────────────────────────────────────────
const showDeleteConfirm = ref(false)
const deleting = ref(false)

async function confirmDelete() {
  if (!props.project) return
  deleting.value = true
  const slug = props.project.slug
  try {
    await removeProject(slug)
    showDeleteConfirm.value = false
    open.value = false
    toast.add({ color: 'success', title: 'Project deleted' })
    emit('deleted', slug)
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Failed to delete project', description: err.data?.statusMessage ?? err.message })
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <!-- ── Edit project modal ─────────────────────────────────────────────────── -->
  <UModal v-model:open="open">
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

          <UFormField
            label="Slug"
            :error="slugError || undefined"
            hint="Changing the slug updates its URL and re-points its sessions, tasks, and memories."
          >
            <UInput
              v-model="editForm.slug"
              placeholder="my-project"
              class="w-full"
              @keyup.enter="submitEdit"
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
                  type="button"
                  class="size-6 rounded-full ring-offset-2 ring-offset-default transition-all"
                  :class="editForm.color === null ? 'ring-2 ring-inverted' : 'hover:scale-110'"
                  :style="{ backgroundColor: NEUTRAL_COLOR }"
                  aria-label="Default color"
                  @click="editForm.color = null"
                >
                  <UIcon
                    v-if="editForm.color === null"
                    name="i-lucide-check"
                    class="size-4 text-white"
                  />
                </button>
                <button
                  v-for="hex in PROJECT_PALETTE"
                  :key="hex"
                  type="button"
                  class="size-6 rounded-full ring-offset-2 ring-offset-default transition-all"
                  :class="editForm.color === hex ? 'ring-2 ring-inverted' : 'hover:scale-110'"
                  :style="{ backgroundColor: hex }"
                  :aria-label="`Set color ${hex}`"
                  @click="editForm.color = hex"
                >
                  <UIcon
                    v-if="editForm.color === hex"
                    name="i-lucide-check"
                    class="size-4 text-white"
                  />
                </button>
              </div>
              <ProjectBadge
                :slug="editForm.slug || (project?.slug ?? '')"
                :name="editForm.name"
                :color="editForm.color"
                :to="false"
              />
            </div>
          </UFormField>

          <div
            v-if="project"
            class="flex flex-col gap-1.5 text-xs text-dimmed border-t border-default pt-3"
          >
            <div class="flex gap-2">
              <span class="font-medium shrink-0">git_remote_key:</span>
              <span class="font-mono truncate">{{ project.gitRemoteKey ?? '—' }}</span>
            </div>
            <div class="flex gap-2">
              <span class="font-medium shrink-0">local_paths:</span>
              <span class="font-mono truncate">{{ project.localPaths.length ? project.localPaths.join(', ') : '—' }}</span>
            </div>
          </div>
        </div>

        <template #footer>
          <div class="flex justify-between gap-2">
            <UButton
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              @click="showDeleteConfirm = true"
            >
              Delete
            </UButton>
            <div class="flex gap-2">
              <UButton
                color="neutral"
                variant="ghost"
                @click="open = false"
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
          <span class="font-medium text-highlighted">{{ project?.name }}</span>?
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
