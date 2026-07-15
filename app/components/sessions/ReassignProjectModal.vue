<script setup lang="ts">
// Shared reassignment modal: single-session "Move" (session detail) and
// bulk "Move to project" (sessions list, multi-select). `normalizePrefix`
// is the client-safe copy in `app/utils/path-routing.ts` (auto-imported) —
// do NOT import the server module here.
const props = defineProps<{
  sessionIds: string[]
  currentCwd?: string | null
  currentProject?: string | null
}>()

const open = defineModel<boolean>('open')

const emit = defineEmits<{ done: [] }>()

// ── Composables ──────────────────────────────────────────────────────────────
const { reassign, reassignMany } = useSessions()
const { useProjectList, create } = useProjects()
const { data: projects } = useProjectList()
const toast = useToast()

// ── Form state ───────────────────────────────────────────────────────────────
const CREATE = '__create__'
const selected = ref<string>('') // project slug, or CREATE sentinel
const newName = ref('')
const registerPrefix = ref(false)
const prefix = ref('')
const busy = ref(false)

// Pre-fill the prefix from the cwd (routing is opt-in via the switch).
watch(() => open.value, (isOpen) => {
  if (!isOpen) return
  selected.value = props.currentProject && props.currentProject !== 'uncategorized' ? props.currentProject : ''
  newName.value = ''
  registerPrefix.value = false
  prefix.value = props.currentCwd ? normalizePrefix(props.currentCwd) : ''
})

const projectItems = computed(() => [
  ...(projects.value ?? []).map(p => ({ label: p.name || p.slug, value: p.slug })),
  { label: '➕ Create new project…', value: CREATE }
])
const isCreate = computed(() => selected.value === CREATE)
const canSubmit = computed(() =>
  (isCreate.value ? newName.value.trim().length > 0 : selected.value.length > 0) && !busy.value)

async function submit() {
  busy.value = true
  try {
    let slug = selected.value
    if (isCreate.value) {
      try {
        const proj = await create({ name: newName.value.trim() })
        slug = proj.slug
      } catch (e: unknown) {
        const err = e as { data?: { statusMessage?: string }, message?: string }
        toast.add({ color: 'error', title: "Couldn't create project", description: err.data?.statusMessage ?? err.message })
        return
      }
    }
    const pfx = registerPrefix.value && prefix.value.trim() ? normalizePrefix(prefix.value) : null
    if (props.sessionIds.length === 1) {
      await reassign(props.sessionIds[0]!, { project: slug, pathPrefix: pfx })
    } else {
      await reassignMany({ ids: props.sessionIds, project: slug, pathPrefix: pfx })
    }
    toast.add({ color: 'success', title: `Moved ${props.sessionIds.length} session${props.sessionIds.length > 1 ? 's' : ''}` })
    open.value = false
    emit('done')
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Reassignment failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    busy.value = false
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
              name="i-lucide-folder-input"
              class="size-5"
            />
            <span class="font-semibold">{{ sessionIds.length > 1 ? `Move ${sessionIds.length} sessions` : 'Move session to project' }}</span>
          </div>
        </template>

        <div class="flex flex-col gap-4">
          <UFormField label="Project">
            <USelectMenu
              v-model="selected"
              :items="projectItems"
              value-key="value"
              placeholder="Select a project"
              class="w-full"
            />
          </UFormField>

          <UFormField
            v-if="isCreate"
            label="New project name"
          >
            <UInput
              v-model="newName"
              placeholder="e.g. Terawulf"
              class="w-full"
              autofocus
            />
          </UFormField>

          <div
            v-if="currentCwd"
            class="space-y-2"
          >
            <USwitch
              v-model="registerPrefix"
              label="Auto-route future sessions under this folder"
            />
            <UInput
              v-if="registerPrefix"
              v-model="prefix"
              class="w-full font-mono text-xs"
            />
            <p
              v-if="registerPrefix"
              class="text-xs text-dimmed"
            >
              New no-git sessions whose folder is under this path will route here automatically.
            </p>
          </div>
        </div>

        <template #footer>
          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              label="Cancel"
              @click="open = false"
            />
            <UButton
              color="primary"
              label="Move"
              :loading="busy"
              :disabled="!canSubmit"
              @click="submit"
            />
          </div>
        </template>
      </UCard>
    </template>
  </UModal>
</template>
