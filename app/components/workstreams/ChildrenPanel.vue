<script setup lang="ts">
// Cycle 83 (spec §6): a coordinator's Children panel — its tree budget meter, then one row per child
// (state, goal, model label, steps/active time used vs reserved, Steer and Cancel). Live through the
// `workstream` resource (useWorkstreamChildren is keyed under ['workstream', 'list']). Steer and
// Cancel are the child's own control routes — the same ones its detail page uses (steer needs a
// session). The goal is the coordinator's own text and renders as an escaped interpolation.
import { committedOf, reservationOf, type WorkstreamDTO } from '@mymind/core/shared/types/workstreams'
import { STATE_META, canCancel, childModelLabel, formatDuration, isTerminal } from '~/lib/workstreams/display'

const props = defineProps<{ coordinator: WorkstreamDTO }>()

const toast = useToast()
const { data, error, isPending } = useWorkstreamChildren(() => props.coordinator.id)
const kids = computed(() => data.value ?? [])
watch(error, (err) => {
  if (err) toast.add({ color: 'error', title: 'Could not load the children', description: workstreamErrorOf(err).message })
})

// ── The tree budget ─────────────────────────────────────────────────────────────────────────────
const tree = computed(() => props.coordinator.treeBudget)
const treeUsed = computed(() => props.coordinator.treeUsed ?? props.coordinator.used)
// The core's own formula (shared/types/workstreams.ts): what spawn would see as committed.
const committed = computed(() => committedOf(props.coordinator, kids.value))
const pct = (n: number, of: number) => Math.min(100, Math.round((n / Math.max(1, of)) * 100))
const tone = (p: number) => (p >= 100 ? 'error' : p >= 80 ? 'warning' : 'primary')
const live = computed(() => kids.value.filter(k => !isTerminal(k.state)).length)

// ── Controls (one row at a time) ────────────────────────────────────────────────────────────────
const { control } = useWorkstreamActions()
const pending = ref<{ id: string; action: 'cancel' | 'steer' } | null>(null)
const steerFor = ref<string | null>(null)
const draft = ref('')

async function act(k: WorkstreamDTO, action: 'cancel' | 'steer', text?: string): Promise<boolean> {
  pending.value = { id: k.id, action }
  try {
    await control.mutateAsync({ id: k.id, action, text })
    return true
  } catch (e) {
    toast.add({ color: 'error', title: action === 'cancel' ? 'Could not cancel the child' : 'Could not send', description: workstreamErrorOf(e).message })
    return false
  } finally {
    pending.value = null
  }
}

function openSteer(k: WorkstreamDTO, open: boolean) {
  steerFor.value = open ? k.id : null
  if (open) draft.value = ''
}

async function sendSteer(k: WorkstreamDTO) {
  const text = draft.value.trim()
  if (!text) return
  if (await act(k, 'steer', text)) {
    steerFor.value = null
    draft.value = ''
    toast.add({ title: 'Sent', description: 'The child picks it up at its next step.' })
  }
}
</script>

<template>
  <div
    class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
    data-testid="workstream-children"
  >
    <div
      v-if="tree"
      class="flex flex-col gap-2 rounded-md border border-default p-3"
      data-testid="workstream-tree-budget"
    >
      <div class="flex items-center justify-between text-xs text-muted">
        <span class="font-medium text-default">Tree budget</span>
        <span>{{ kids.length }} {{ kids.length === 1 ? 'child' : 'children' }} · {{ live }} still going</span>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <UTooltip text="Steps used by the coordinator and every child, against the tree's budget. Reserved: what live children (and the coordinator) still hold — a new child must fit in what is left.">
          <div class="flex flex-col gap-1">
            <div class="flex items-center justify-between text-xs text-muted">
              <span>Steps</span>
              <span
                class="tabular-nums"
                data-testid="tree-steps"
              >{{ treeUsed.steps }} used · {{ committed.maxSteps }} reserved / {{ tree.maxSteps }}</span>
            </div>
            <UProgress
              :model-value="pct(treeUsed.steps, tree.maxSteps)"
              :color="tone(pct(committed.maxSteps, tree.maxSteps))"
              size="sm"
            />
          </div>
        </UTooltip>
        <UTooltip text="Active time summed over the coordinator and every child (parallel children each count), against the tree's budget.">
          <div class="flex flex-col gap-1">
            <div class="flex items-center justify-between text-xs text-muted">
              <span>Active time</span>
              <span
                class="tabular-nums"
                data-testid="tree-wall"
              >{{ formatDuration(treeUsed.wallMs) }} used · {{ formatDuration(committed.maxWallMs) }} reserved / {{ formatDuration(tree.maxWallMs) }}</span>
            </div>
            <UProgress
              :model-value="pct(treeUsed.wallMs, tree.maxWallMs)"
              :color="tone(pct(committed.maxWallMs, tree.maxWallMs))"
              size="sm"
            />
          </div>
        </UTooltip>
      </div>
    </div>

    <p
      v-if="!isPending && !kids.length"
      class="py-6 text-center text-sm text-muted"
    >
      No children yet. They appear here as soon as it spawns them.
    </p>

    <ul
      v-else
      class="divide-y divide-default rounded-md border border-default"
    >
      <li
        v-for="k in kids"
        :key="k.id"
        class="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2"
        data-testid="workstream-child"
        :data-workstream="k.id"
      >
        <UIcon
          name="i-lucide-corner-down-right"
          class="size-4 shrink-0 text-dimmed"
        />
        <UBadge
          :color="STATE_META[k.state].color"
          :icon="STATE_META[k.state].icon"
          variant="subtle"
          size="sm"
          :label="STATE_META[k.state].label"
          data-testid="child-state"
        />
        <ULink
          :to="`/workstreams/${k.id}`"
          class="min-w-0 flex-1 basis-48 truncate text-sm font-medium text-highlighted"
          :title="k.goal"
        >
          {{ k.goal.replace(/\s+/g, ' ') }}
        </ULink>
        <UBadge
          color="neutral"
          variant="outline"
          size="sm"
          icon="i-lucide-cpu"
          :label="childModelLabel(k)"
          data-testid="child-model"
        />
        <UTooltip :text="isTerminal(k.state) ? 'Steps and active time it used (the rest went back to the tree).' : 'Used vs reserved from the tree.'">
          <span
            class="text-xs tabular-nums text-muted"
            data-testid="child-usage"
          >{{ k.used.steps }}/{{ reservationOf(k).maxSteps }} steps · {{ formatDuration(k.used.wallMs) }}/{{ formatDuration(reservationOf(k).maxWallMs) }}</span>
        </UTooltip>
        <div class="ms-auto flex shrink-0 items-center gap-1">
          <UPopover
            v-if="!isTerminal(k.state)"
            :open="steerFor === k.id"
            @update:open="(o: boolean) => openSteer(k, o)"
          >
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-message-square-share"
              :label="k.state === 'attention' && k.attention?.kind === 'question' ? 'Answer' : 'Steer'"
              :disabled="!!pending"
              data-testid="child-steer"
            />
            <template #content>
              <form
                class="flex w-80 flex-col gap-2 p-3"
                @submit.prevent="sendSteer(k)"
              >
                <UTextarea
                  v-model="draft"
                  :rows="3"
                  autoresize
                  :maxrows="8"
                  autofocus
                  class="w-full"
                  :placeholder="k.state === 'attention' && k.attention?.kind === 'question' ? 'Answer its question…' : 'A note it reads at its next step…'"
                  data-testid="child-steer-text"
                  @keydown.enter.exact.prevent="sendSteer(k)"
                />
                <div class="flex justify-end">
                  <UButton
                    type="submit"
                    size="xs"
                    icon="i-lucide-send"
                    label="Send"
                    :loading="pending?.id === k.id && pending.action === 'steer'"
                    :disabled="!draft.trim() || !!pending"
                    data-testid="child-steer-send"
                  />
                </div>
              </form>
            </template>
          </UPopover>
          <UButton
            v-if="canCancel(k.state)"
            size="xs"
            color="error"
            variant="ghost"
            icon="i-lucide-square"
            label="Cancel"
            :loading="pending?.id === k.id && pending.action === 'cancel'"
            :disabled="!!pending"
            data-testid="child-cancel"
            @click="act(k, 'cancel')"
          />
        </div>
      </li>
    </ul>
  </div>
</template>
