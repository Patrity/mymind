<script setup lang="ts">
import type { ProjectDTO } from '~~/shared/types/tasks'

// ── Props / model / emits ────────────────────────────────────────────────────
const props = defineProps<{
  project: ProjectDTO | null
}>()

const open = defineModel<boolean>('open')

const emit = defineEmits<{
  merged: [ProjectDTO]
}>()

// ── Composables ──────────────────────────────────────────────────────────────
const { merge, useProjectList } = useProjects()
const toast = useToast()

// ── Target selection ─────────────────────────────────────────────────────────
const targetSlug = ref<string | undefined>(undefined)

const { data: allProjects } = useProjectList()

const targetOptions = computed(() => {
  const currentSlug = props.project?.slug
  return (allProjects.value ?? [])
    .filter(p => p.slug !== currentSlug && p.slug !== 'uncategorized')
    .map(p => ({ label: p.name, value: p.slug }))
})

// The currently selected target project object (for name display)
const selectedTarget = computed(() =>
  targetOptions.value.find(o => o.value === targetSlug.value)
)

// Reset target when the modal opens
watch(open, (isOpen) => {
  if (isOpen) targetSlug.value = undefined
})

// ── Merge action ─────────────────────────────────────────────────────────────
const merging = ref(false)

async function confirmMerge() {
  if (!props.project || !targetSlug.value) return
  merging.value = true
  try {
    const winner = await merge(props.project.slug, targetSlug.value)
    toast.add({ color: 'success', title: 'Projects merged' })
    emit('merged', winner)
    open.value = false
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Merge failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    merging.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open">
    <template #content>
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-git-merge"
              class="size-5 text-error"
            />
            <span class="font-semibold">Merge project</span>
          </div>
        </template>

        <div class="flex flex-col gap-4">
          <UFormField
            label="Merge into"
            hint="All data from this project will move to the selected project."
          >
            <USelectMenu
              v-model="targetSlug"
              :items="targetOptions"
              value-key="value"
              placeholder="Select target project…"
              class="w-full"
            />
          </UFormField>

          <!-- Preview line -->
          <p
            v-if="project"
            class="text-sm text-muted"
          >
            <span class="font-semibold text-highlighted">
              {{ project.sessionCount }} sessions · {{ project.memoryCount }} memories · {{ project.documentCount }} docs · {{ project.taskCount }} tasks
            </span>
            will move to
            <span
              v-if="selectedTarget"
              class="font-medium text-highlighted"
            >{{ selectedTarget.label }}</span>
            <span
              v-else
              class="italic"
            >the selected project</span>.
          </p>

          <!-- Destructive warning -->
          <p class="text-sm text-error">
            <span class="font-semibold">{{ project?.name }}</span> will be permanently deleted. This cannot be undone.
          </p>
        </div>

        <template #footer>
          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              @click="open = false"
            >
              Cancel
            </UButton>
            <UButton
              color="error"
              :disabled="!targetSlug"
              :loading="merging"
              @click="confirmMerge"
            >
              Merge
            </UButton>
          </div>
        </template>
      </UCard>
    </template>
  </UModal>
</template>
