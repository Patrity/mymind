<script setup lang="ts">
import { dirnameOf } from '~/lib/documents/folder-list'
import { basenameOf, describeFolderError, type DocTreeTarget } from '~/composables/useDocumentTree'
import type { FolderImpact } from '~/composables/useFolders'

const props = defineProps<{
  target: DocTreeTarget | null
  open: boolean
  folders: string[]
  /** Files call the document endpoints; folders call `useFolders().patch` at `PATCH
   *  /api/folders/[id]`. */
  kind: 'file' | 'folder'
}>()

const emit = defineEmits<{ 'update:open': [boolean], done: [] }>()

const toast = useToast()
const { move } = useDocuments()
const { patch: patchFolder, impact: fetchImpact } = useFolders()

const moveDestFolder = ref('')
const moveLoading = ref(false)

// `documents.path` determines project membership, so moving a folder into or out of a
// `/projects/<slug>/` prefix re-associates every document inside it. Preview via `impact()`
// as soon as a destination is picked — before the user ever presses Move — and require an
// explicit checkbox when it changes anything, so this can't be missed or hidden.
const impact = ref<FolderImpact | null>(null)
const impactLoading = ref(false)
const projectChangeAck = ref(false)

const title = computed(() => props.kind === 'folder' ? 'Move folder' : 'Move document')

// A folder can't be moved into itself or one of its own descendants (the service refuses this
// as `invalid`) — filtered out of the picker so the obviously-invalid choices aren't offered.
const destinationOptions = computed(() => {
  if (props.kind !== 'folder' || !props.target) return props.folders
  const own = props.target.path
  return props.folders.filter(p => p !== own && !p.startsWith(own + '/'))
})

function destinationPath(dir: string): string | null {
  if (!props.target || !dir) return null
  const base = basenameOf(props.target.path)
  return dir === '/' ? '/' + base : dir + '/' + base
}

// Reset on each open so a previous attempt never leaks into the next one.
watch(() => props.open, (isOpen) => {
  if (!isOpen || !props.target) return
  moveDestFolder.value = dirnameOf(props.target.path)
  impact.value = null
  projectChangeAck.value = false
})

// Re-preview every time the chosen destination changes — a discrete selection, not a keystroke
// stream, so fetching eagerly here (rather than only on submit) is cheap and shows the warning
// the moment it becomes true instead of only after the user has already decided to submit.
watch(moveDestFolder, async (dir) => {
  impact.value = null
  projectChangeAck.value = false
  if (props.kind !== 'folder' || !props.target) return
  const dest = destinationPath(dir)
  if (!dest || dest === props.target.path) return
  impactLoading.value = true
  try {
    impact.value = await fetchImpact(props.target.id, dest)
  } catch {
    impact.value = null
  } finally {
    impactLoading.value = false
  }
})

const needsAck = computed(() => !!impact.value?.projectChanges.length)

async function confirmMove() {
  if (!props.target || !moveDestFolder.value) return
  const dest = destinationPath(moveDestFolder.value)
  if (!dest) return
  // Same-folder no-op: destination equals current path — just close.
  if (dest === props.target.path) {
    emit('update:open', false)
    return
  }
  if (needsAck.value && !projectChangeAck.value) return

  moveLoading.value = true
  try {
    if (props.kind === 'folder') {
      const result = await patchFolder(props.target.id, { path: dest })
      // Defend against the known repo-wide trap: an unmatched relative route resolves to the
      // SPA shell with a 200, which ofetch does not throw on. A real PATCH always answers
      // `{ ok: true }` — anything else is treated as failure, never reported as success.
      if (!result || result.ok !== true) {
        throw new Error('The server did not confirm the folder move')
      }
    } else {
      await move(props.target.id, dest)
    }
    toast.add({ color: 'success', title: `Moved to "${moveDestFolder.value}"` })
    emit('update:open', false)
    emit('done')
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({
      color: 'error',
      title: 'Move failed',
      description: props.kind === 'folder' ? describeFolderError(e) : (err.data?.statusMessage ?? err.message)
    })
  } finally {
    moveLoading.value = false
  }
}
</script>

<template>
  <UModal
    :open="open"
    @update:open="emit('update:open', $event)"
  >
    <template #content>
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon
              name="i-lucide-folder-input"
              class="size-5"
            />
            <span class="font-semibold">{{ title }}</span>
          </div>
        </template>

        <div class="space-y-3">
          <UFormField
            label="Destination folder"
            :description="target ? `Moving: ${target.label}` : ''"
          >
            <USelectMenu
              v-model="moveDestFolder"
              :items="destinationOptions"
              class="w-full font-mono text-sm"
              placeholder="Select folder"
            />
          </UFormField>

          <p
            v-if="impactLoading"
            class="text-xs text-dimmed"
          >
            Checking what this move affects…
          </p>

          <UAlert
            v-if="needsAck"
            color="warning"
            icon="i-lucide-triangle-alert"
            title="This changes project membership"
          >
            <template #description>
              <ul class="text-xs space-y-0.5">
                <li
                  v-for="c in impact!.projectChanges"
                  :key="`${c.from}-${c.to}`"
                >
                  {{ c.count }} document{{ c.count === 1 ? '' : 's' }}:
                  {{ c.from ?? 'no project' }} → {{ c.to ?? 'no project' }}
                </li>
              </ul>
            </template>
          </UAlert>

          <div
            v-if="needsAck"
            class="flex items-center gap-2"
          >
            <UCheckbox v-model="projectChangeAck" />
            <span class="text-sm text-muted">I understand this will change project membership</span>
          </div>
        </div>

        <template #footer>
          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              @click="emit('update:open', false)"
            >
              Cancel
            </UButton>
            <UButton
              :loading="moveLoading"
              :disabled="!moveDestFolder || (needsAck && !projectChangeAck)"
              @click="confirmMove"
            >
              Move
            </UButton>
          </div>
        </template>
      </UCard>
    </template>
  </UModal>
</template>
