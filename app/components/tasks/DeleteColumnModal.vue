<script setup lang="ts">
import type { TaskColumnDTO } from '~~/shared/types/task-columns'

// Delete (or reassign-then-delete) a column. `taskCount` is passed in from tasks.vue's own
// already-loaded board state (columnsTasks[col.id]?.length) rather than re-fetched here —
// single source of truth, zero extra network calls.
//
// A 409 refusal (last column of its kind, or a bad/missing reassign target) is a deliberate,
// explainable no-op from the server (server/api/task-columns/[id].delete.ts) — rendered inline
// via errorMessage, NOT a toast, so the user sees exactly why nothing happened without it
// vanishing after a few seconds.
const props = defineProps<{
  column: TaskColumnDTO | null
  taskCount: number
}>()

const open = defineModel<boolean>('open')

// ── Composables ──────────────────────────────────────────────────────────────
const { remove, useColumnList } = useTaskColumns()
// Same shared query key as tasks.vue's board — see ColumnFormModal.vue for why an explicit
// refetch() is required (useColumnList() isn't SSE-wired).
const { data: columnsData, refetch: refetchColumns } = useColumnList()
const toast = useToast()

// Reassign targets must share the doomed column's `kind` — status is DERIVED from the target's
// kind, so moving cards across kinds (e.g. an open column's cards into a done one) would mark
// them completed/uncompleted everywhere with no user intent behind it. Renaming stays available
// for every kind; this list exists only to pick WHERE within the same kind the cards land.
const remainingColumns = computed(() =>
  (columnsData.value ?? []).filter(c => c.id !== props.column?.id && c.kind === props.column?.kind)
)
const targetItems = computed(() => remainingColumns.value.map(c => ({ label: c.name, value: c.id })))

// ── Form state ───────────────────────────────────────────────────────────────
const mode = ref<'delete' | 'reassign'>('delete')
const targetColumnId = ref<string | undefined>(undefined)
const busy = ref(false)
const errorMessage = ref('')

const modeItems = [
  { label: 'Delete the tasks', value: 'delete' as const },
  { label: 'Move them to →', value: 'reassign' as const }
]

watch(open, (isOpen) => {
  if (!isOpen) return
  mode.value = 'delete'
  targetColumnId.value = undefined
  errorMessage.value = ''
})

// A 409 refusal rendered inline (e.g. "choose a different column") is scoped to the mode that
// produced it — switching modes makes it stale, so it must not sit next to the now-irrelevant UI.
watch(mode, () => {
  errorMessage.value = ''
})

const taskCountLabel = computed(() => `${props.taskCount} ${props.taskCount === 1 ? 'task' : 'tasks'}`)

const canConfirm = computed(() =>
  !busy.value && (mode.value === 'delete' || !!targetColumnId.value))

// ── Submit ───────────────────────────────────────────────────────────────────
async function confirmDelete() {
  if (!props.column) return
  busy.value = true
  errorMessage.value = ''
  try {
    await remove(props.column.id, {
      mode: mode.value,
      targetColumnId: mode.value === 'reassign' ? targetColumnId.value : undefined
    })
    await refetchColumns()
    open.value = false
    toast.add({ color: 'success', title: 'Column deleted' })
  } catch (e: unknown) {
    const err = e as { status?: number, statusCode?: number, data?: { statusMessage?: string }, message?: string }
    const status = err.status ?? err.statusCode
    if (status === 409) {
      // Refusal — render the server's reason inline, not as a toast.
      errorMessage.value = err.data?.statusMessage ?? 'This column can’t be deleted.'
    } else {
      toast.add({ color: 'error', title: 'Failed to delete column', description: err.data?.statusMessage ?? err.message })
    }
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
              name="i-lucide-trash-2"
              class="size-5 text-error"
            />
            <span class="font-semibold">Delete "{{ column?.name }}"?</span>
          </div>
        </template>

        <div class="flex flex-col gap-4">
          <p class="text-sm text-muted">
            This column has {{ taskCountLabel }}.
          </p>

          <URadioGroup
            v-model="mode"
            :items="modeItems"
            value-key="value"
          />

          <UFormField
            v-if="mode === 'reassign'"
            label="Move to"
          >
            <USelectMenu
              v-model="targetColumnId"
              :items="targetItems"
              value-key="value"
              placeholder="Select a column…"
              class="w-full"
            />
          </UFormField>

          <UAlert
            v-if="errorMessage"
            color="error"
            variant="subtle"
            icon="i-lucide-alert-triangle"
            title="Can't delete this column"
            :description="errorMessage"
          />
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
              :loading="busy"
              :disabled="!canConfirm"
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
