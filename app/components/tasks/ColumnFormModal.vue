<script setup lang="ts">
import { TASK_COLUMN_KINDS, TASK_COLUMN_COLORS } from '~~/shared/types/task-columns'
import type { TaskColumnDTO, TaskColumnKind, TaskColumnColor } from '~~/shared/types/task-columns'

// Create/edit a column. `column` present = edit (name + colour only); absent = create
// (name + kind + colour). `kind` is deliberately NOT offered in edit mode — changing a
// column's kind after creation would silently reclassify every card in it (status derives
// from column kind), e.g. flipping a "Done" column to `open` would un-complete every task in
// it and clear their completedAt. The server route also refuses `kind` in a PATCH body.
const props = defineProps<{
  column?: TaskColumnDTO | null
}>()

const open = defineModel<boolean>('open')

// ── Composables ──────────────────────────────────────────────────────────────
const { create, update, useColumnList } = useTaskColumns()
// Same query key as tasks.vue's own useColumnList() — TanStack Query dedupes by key and
// shares the cache, so refetch() here updates every consumer, including the board. Explicit
// refetch is required: useColumnList() is NOT wired into the SSE live-invalidation path (see
// useTaskColumns.ts's own rationale comment) — a created/renamed column would otherwise not
// appear until a manual page reload.
const { refetch: refetchColumns } = useColumnList()
const toast = useToast()

// ── Solid swatch preview for the colour picker ──────────────────────────────────
// A SEPARATE static map from tasks.vue's TINT (that one is a 5%-opacity board wash; a picker
// swatch needs a solid, distinguishable dot). Same construction principle as TINT and verified
// the same way (Task 7's report): Tailwind's scanner only emits classes it can see literally in
// source, so `bg-${color}` gets silently purged — every value here is a literal string. `neutral`
// has no bare `bg-neutral` utility (Nuxt UI only ships numbered shades for the neutral scale, no
// DEFAULT alias, unlike the other six semantic colours) so it pins an explicit shade instead.
const SWATCH: Record<TaskColumnColor, string> = {
  primary: 'bg-primary',
  secondary: 'bg-secondary',
  success: 'bg-success',
  info: 'bg-info',
  warning: 'bg-warning',
  error: 'bg-error',
  neutral: 'bg-neutral-500'
}

const KIND_LABELS: Record<TaskColumnKind, string> = {
  open: 'Open',
  started: 'Started',
  done: 'Done',
  blocked: 'Blocked'
}
const kindItems = TASK_COLUMN_KINDS.map(k => ({ label: KIND_LABELS[k], value: k }))

const isEdit = computed(() => !!props.column)

// ── Form state ───────────────────────────────────────────────────────────────
interface FormState {
  name: string
  kind: TaskColumnKind
  color: TaskColumnColor
}

function emptyForm(): FormState {
  return props.column
    ? { name: props.column.name, kind: props.column.kind, color: props.column.color }
    : { name: '', kind: 'open', color: 'neutral' }
}

const form = ref<FormState>(emptyForm())
const saving = ref(false)

watch(open, (isOpen) => {
  if (isOpen) form.value = emptyForm()
})

// ── Submit ───────────────────────────────────────────────────────────────────
async function submit() {
  if (!form.value.name.trim()) return
  saving.value = true
  try {
    if (isEdit.value && props.column) {
      await update(props.column.id, { name: form.value.name.trim(), color: form.value.color })
    } else {
      await create({ name: form.value.name.trim(), kind: form.value.kind, color: form.value.color })
    }
    await refetchColumns()
    open.value = false
    toast.add({ color: 'success', title: isEdit.value ? 'Column updated' : 'Column created' })
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({
      color: 'error',
      title: isEdit.value ? 'Failed to update column' : 'Failed to create column',
      description: err.data?.statusMessage ?? err.message
    })
  } finally {
    saving.value = false
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
              :name="isEdit ? 'i-lucide-pencil' : 'i-lucide-square-plus'"
              class="size-5"
            />
            <span class="font-semibold">{{ isEdit ? 'Edit column' : 'New column' }}</span>
          </div>
        </template>

        <div class="flex flex-col gap-4">
          <UFormField
            label="Name"
            required
          >
            <UInput
              v-model="form.name"
              placeholder="Column name"
              autofocus
              class="w-full"
              @keyup.enter="submit"
            />
          </UFormField>

          <UFormField
            v-if="!isEdit"
            label="Kind"
            hint="What this column means for cards in it — can't be changed later."
          >
            <USelectMenu
              v-model="form.kind"
              :items="kindItems"
              value-key="value"
              class="w-full"
            />
          </UFormField>

          <UFormField label="Colour">
            <div class="flex flex-wrap gap-2">
              <button
                v-for="c in TASK_COLUMN_COLORS"
                :key="c"
                type="button"
                class="size-8 rounded-full ring-offset-2 ring-offset-default transition-all flex items-center justify-center"
                :class="[SWATCH[c], form.color === c ? 'ring-2 ring-inverted' : 'hover:scale-110']"
                :aria-label="`Set colour ${c}`"
                @click="form.color = c"
              >
                <UIcon
                  v-if="form.color === c"
                  name="i-lucide-check"
                  class="size-4 text-white"
                />
              </button>
            </div>
          </UFormField>
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
              :loading="saving"
              :disabled="!form.name.trim()"
              @click="submit"
            >
              {{ isEdit ? 'Save' : 'Create' }}
            </UButton>
          </div>
        </template>
      </UCard>
    </template>
  </UModal>
</template>
