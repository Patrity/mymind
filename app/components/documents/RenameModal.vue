<script setup lang="ts">
import { dirnameOf } from '~/lib/documents/folder-list'
import { basenameOf, describeFolderError, type DocTreeTarget } from '~/composables/useDocumentTree'
import type { FolderImpact } from '~/composables/useFolders'

const props = defineProps<{
  target: DocTreeTarget | null
  open: boolean
  /** Files call the document endpoints; folders call `useFolders().patch` at `PATCH
   *  /api/folders/[id]` — see useDocumentTree.ts's `describeFolderError` for why the two can't
   *  share one error path. */
  kind: 'file' | 'folder'
}>()

const emit = defineEmits<{ 'update:open': [boolean], done: [] }>()

const toast = useToast()
const { impact: fetchImpact } = useFolders()
const renameDocument = useRenameDocumentMutation()
const renameFolder = useMoveFolderMutation()

const renameName = ref('')
const renameLoading = ref(false)

// A folder rename is a move within the same parent (moveFolder handles both identically), and
// renaming the folder that IS a project's `/projects/<slug>` directory changes which project
// every document beneath it belongs to. Preview via `impact()` before committing, same as Move.
const impact = ref<FolderImpact | null>(null)
const impactLoading = ref(false)
const impactError = ref(false)
const projectChangeAck = ref(false)
// The proposed path this preview was fetched for — a stale preview must never authorize a
// DIFFERENT proposed name silently if the user keeps typing after seeing a clean preview.
const previewedPath = ref<string | null>(null)

const title = computed(() => props.kind === 'folder' ? 'Rename folder' : 'Rename document')

const proposedPath = computed(() => {
  if (!props.target || !renameName.value.trim()) return null
  const dir = dirnameOf(props.target.path)
  const name = renameName.value.trim()
  return dir === '/' ? '/' + name : dir + '/' + name
})

const needsAck = computed(() =>
  !!impact.value?.projectChanges.length && previewedPath.value === proposedPath.value)

// Reset on each open so a previous attempt never leaks into the next one.
watch(() => props.open, (isOpen) => {
  if (!isOpen || !props.target) return
  renameName.value = basenameOf(props.target.path)
  impact.value = null
  previewedPath.value = null
  impactError.value = false
  projectChangeAck.value = false
})

// Typing a different name invalidates whatever was last previewed.
watch(renameName, () => {
  impact.value = null
  previewedPath.value = null
  impactError.value = false
  projectChangeAck.value = false
})

async function confirmRename() {
  if (!props.target || !proposedPath.value) return
  const newPath = proposedPath.value

  if (props.kind === 'folder' && newPath !== props.target.path) {
    // Ensure a FRESH, matching preview before ever committing — (re)fetch if we don't already
    // hold one for this exact proposed path, or the last attempt failed. On success, only
    // `previewedPath` moves — never on failure, or a failed check would silently read as "no
    // project changes" on the very next line.
    if (previewedPath.value !== newPath || impactError.value) {
      impactLoading.value = true
      impactError.value = false
      try {
        impact.value = await fetchImpact(props.target.id, newPath)
        previewedPath.value = newPath
      } catch {
        impact.value = null
        previewedPath.value = null
        impactError.value = true
      } finally {
        impactLoading.value = false
      }
    }
    // Fail CLOSED: a folder rename that changes its path never proceeds without a successful,
    // matching preview — an unknown outcome blocks, it does not default to "safe".
    if (impactError.value || previewedPath.value !== newPath) return
    if (impact.value?.projectChanges.length && !projectChangeAck.value) return
  }

  renameLoading.value = true
  try {
    if (props.kind === 'folder') {
      const result = await renameFolder.mutateAsync({ id: props.target.id, oldPath: props.target.path, newPath })
      // Defend against the known repo-wide trap: an unmatched relative route resolves to the
      // SPA shell with a 200, which ofetch does not throw on. A real PATCH always answers
      // `{ ok: true }` — anything else (including a parsed non-JSON body) is treated as failure
      // rather than reported as a success toast.
      if (!result || result.ok !== true) {
        throw new Error('The server did not confirm the folder rename')
      }
    } else {
      await renameDocument.mutateAsync({ id: props.target.id, oldPath: props.target.path, newPath })
    }
    // No success toast (Task 17 toast discipline): the row's new name is immediately visible in
    // the tree, for both a file and a folder.
    emit('update:open', false)
    emit('done')
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({
      color: 'error',
      title: 'Rename failed',
      description: props.kind === 'folder' ? describeFolderError(e) : (err.data?.statusMessage ?? err.message)
    })
  } finally {
    renameLoading.value = false
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
              name="i-lucide-pencil"
              class="size-5"
            />
            <span class="font-semibold">{{ title }}</span>
          </div>
        </template>

        <div class="space-y-3">
          <UFormField label="New name">
            <UInput
              v-model="renameName"
              autofocus
              class="w-full font-mono text-sm"
              placeholder="filename.md"
              @keyup.enter="confirmRename"
            />
          </UFormField>

          <UAlert
            v-if="impactError"
            color="error"
            icon="i-lucide-triangle-alert"
            title="Couldn't check what this rename affects"
            description="We can't confirm whether this crosses a project boundary — click Rename to try the check again before it commits to anything."
          />

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
              :loading="renameLoading || impactLoading"
              :disabled="!renameName.trim() || (needsAck && !projectChangeAck)"
              @click="confirmRename"
            >
              Rename
            </UButton>
          </div>
        </template>
      </UCard>
    </template>
  </UModal>
</template>
