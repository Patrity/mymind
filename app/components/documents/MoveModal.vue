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
  /** Destination folder to open with, instead of the target's current parent. Set by Tree.vue
   *  when a *drag* lands a folder somewhere that changes project membership: the drop can't be
   *  performed silently, so it is handed to this modal — already pointed at where the user
   *  dropped it — to collect the same acknowledgement a menu-driven move requires. */
  destination?: string | null
}>()

const emit = defineEmits<{ 'update:open': [boolean], done: [] }>()

const toast = useToast()
const { impact: fetchImpact, patch: patchFolder } = useFolders()
const moveDocument = useMoveDocumentMutation()
const moveFolder = useMoveFolderMutation()

const moveDestFolder = ref('')
const moveLoading = ref(false)

// `documents.path` determines project membership, so moving a folder into or out of a
// `/projects/<slug>/` prefix re-associates every document inside it. Preview via `impact()`
// as soon as a destination is picked — before the user ever presses Move — and require an
// explicit checkbox when it changes anything, so this can't be missed or hidden.
const impact = ref<FolderImpact | null>(null)
const impactLoading = ref(false)
const impactError = ref(false)
const projectChangeAck = ref(false)
// The destination this preview was actually fetched for — `confirmMove` re-checks this against
// the CURRENT destination before ever writing, rather than trusting `impact.value` on its own.
// That's what closes the race below: a background preview fetch resolving late (or never) can't
// silently authorize a commit for a destination it never actually confirmed.
const previewedPath = ref<string | null>(null)

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

// Monotonic token for the preview fetch below. Two previews can be in flight at once (opening
// with a `destination` sets `moveDestFolder`, which also fires the destination watch), and an
// out-of-order response must never be the one that sets `previewedPath` — that field is what
// `confirmMove` treats as authorization, so a stale winner would authorize a commit for a
// destination it never actually checked.
let previewToken = 0

/**
 * Preview what moving the target folder into `dir` would change, and reset the acknowledgement.
 *
 * A UX convenience only: `confirmMove` below does NOT trust it on its own (see the
 * `previewedPath` re-check there) — clicking Move before this resolves must not skip the check.
 */
async function previewImpact(dir: string) {
  const token = ++previewToken
  impact.value = null
  previewedPath.value = null
  impactError.value = false
  projectChangeAck.value = false
  if (props.kind !== 'folder' || !props.target) return
  const dest = destinationPath(dir)
  if (!dest || dest === props.target.path) return
  impactLoading.value = true
  try {
    const result = await fetchImpact(props.target.id, dest)
    if (token !== previewToken) return
    impact.value = result
    previewedPath.value = dest
  } catch {
    if (token !== previewToken) return
    impact.value = null
    previewedPath.value = null
    impactError.value = true
  } finally {
    if (token === previewToken) impactLoading.value = false
  }
}

// Reset on each open AND on every target swap — not just `open` — so a previous attempt never
// leaks into the next one, and preview straight away rather than waiting for the destination to
// *change*. Watching `target` too matters because `open` can already be `true` when the target
// changes: a menu-driven Move can open this dialog for one target while a drag's cross-project
// impact check is still resolving in the background; when that check later hands off to
// `openMoveModal`, it re-points the SAME open dialog at the folder it gates, without ever
// toggling `open`. A `watch(() => props.open, …)` would miss that entirely — `open` stays `true`
// throughout, so it would never re-fire, leaving `moveDestFolder`/`impact`/`previewedPath`/
// `projectChangeAck` all showing state for the PREVIOUS target while the dialog now claims to be
// about a different one. Re-opening on the same destination (a repeated drag to the same folder)
// leaves `moveDestFolder` untouched too, so without this the watch below never fires and the
// user is left pressing a Move button that silently refuses for want of an acknowledgement it
// was never shown.
watch([() => props.open, () => props.target], ([isOpen]) => {
  if (!isOpen || !props.target) return
  moveDestFolder.value = props.destination ?? dirnameOf(props.target.path)
  void previewImpact(moveDestFolder.value)
})

// Re-preview every time the chosen destination changes — a discrete selection, not a keystroke
// stream, so fetching eagerly here (rather than only on submit) is cheap and shows the warning
// the moment it becomes true instead of only after the user has already decided to submit.
watch(moveDestFolder, (dir) => {
  void previewImpact(dir)
})

const needsAck = computed(() =>
  !!impact.value?.projectChanges.length && previewedPath.value === destinationPath(moveDestFolder.value))

async function confirmMove() {
  if (!props.target || !moveDestFolder.value) return
  const dest = destinationPath(moveDestFolder.value)
  if (!dest) return
  // Same-folder no-op: destination equals current path — just close.
  if (dest === props.target.path) {
    emit('update:open', false)
    return
  }

  if (props.kind === 'folder') {
    // CRITICAL: never commit without a FRESH, matching preview. The watch above is a UX
    // convenience that can still be in flight (or have failed) the instant this runs — awaiting
    // it here, unconditionally, is what actually closes the "click Move before the background
    // fetch resolves" race. Skip the extra round-trip only when we already hold a preview for
    // this EXACT destination.
    if (previewedPath.value !== dest || impactError.value) {
      // Claim the preview token so any background `previewImpact` still in flight can no longer
      // write `previewedPath` — deliberately NOT a call to `previewImpact` itself, which would
      // clear `projectChangeAck` and throw away the acknowledgement we are about to check.
      const token = ++previewToken
      impactLoading.value = true
      impactError.value = false
      try {
        const result = await fetchImpact(props.target.id, dest)
        if (token === previewToken) {
          impact.value = result
          previewedPath.value = dest
        }
      } catch {
        if (token === previewToken) {
          impact.value = null
          previewedPath.value = null
          impactError.value = true
        }
      } finally {
        if (token === previewToken) impactLoading.value = false
      }
    }
    // Fail CLOSED: a folder move never proceeds without a successful, matching preview — an
    // unknown outcome is treated as "assume the worst", not "assume it's fine".
    if (impactError.value || previewedPath.value !== dest) return
    if (impact.value?.projectChanges.length && !projectChangeAck.value) return
  }

  moveLoading.value = true
  // Captured synchronously, before the mutation's `await` below — NOT because `props.target` is
  // guaranteed stable while this dialog is open (it can be swapped for a different target if the
  // dialog is re-pointed while already open; see the `open`+`target` watcher above and the
  // `promptMove`/`promptFolderMove` guards that stop a swap from landing while a move is
  // actually IN FLIGHT). Reading `props.target` again after the await could observe a swapped
  // value, so these are captured now to guarantee they're the PRE-move id/path Undo needs to
  // hand back to `patch()`.
  const folderId = props.target.id
  const originalPath = props.target.path
  try {
    if (props.kind === 'folder') {
      const result = await moveFolder.mutateAsync({ id: props.target.id, oldPath: props.target.path, newPath: dest })
      // Defend against the known repo-wide trap: an unmatched relative route resolves to the
      // SPA shell with a 200, which ofetch does not throw on. A real PATCH always answers
      // `{ ok: true }` — anything else is treated as failure, never reported as success.
      if (!result || result.ok !== true) {
        throw new Error('The server did not confirm the folder move')
      }
    } else {
      await moveDocument.mutateAsync({ id: props.target.id, oldPath: props.target.path, newPath: dest })
    }
    // Task 17 toast discipline: a FILE move gets no toast — its new location is immediately
    // visible in the tree. A FOLDER move keeps one specifically because it earns an Undo — a
    // folder move can carry many documents out of view at once (scrolled away, or into a
    // collapsed sibling), so a one-click way back is worth the toast that a plain file move
    // no longer gets.
    if (props.kind === 'folder') {
      toast.add({
        color: 'success',
        title: `Moved to "${moveDestFolder.value}"`,
        actions: [{ label: 'Undo', onClick: () => undoFolderMove(folderId, originalPath) }]
      })
    }
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

/**
 * Undo a folder move by patching it straight back to where it was. Deliberately the raw
 * `patch()` fetcher, not `useMoveFolderMutation()` — Undo is a rare escape hatch clicked from a
 * toast that may already be gone from screen, not a path that needs its own optimistic paint;
 * the folder PATCH endpoint publishes its own live event either way, which is what actually
 * repaints the tree (see FolderColorPicker.vue's identical note on that).
 */
async function undoFolderMove(id: string, originalPath: string) {
  try {
    const result = await patchFolder(id, { path: originalPath })
    if (!result || result.ok !== true) throw new Error('The server did not confirm the undo')
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Undo failed', description: err.data?.statusMessage ?? err.message })
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
            v-if="impactError"
            color="error"
            icon="i-lucide-triangle-alert"
            title="Couldn't check what this move affects"
            description="We can't confirm whether this crosses a project boundary — click Move to try the check again before it commits to anything."
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
              :loading="moveLoading"
              :disabled="!moveDestFolder || impactLoading || (needsAck && !projectChangeAck)"
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
