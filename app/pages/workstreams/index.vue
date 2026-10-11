<script setup lang="ts">
/**
 * /workstreams (cycle 81 spec §5.5) — Bridget's long-running background work: state, goal, elapsed,
 * steps, cost and where it was started. Live via the `workstream` resource. "New workstream" starts
 * one from here (the same start path as the tool, cap of 3 included).
 */
import type { TableColumn } from '@nuxt/ui'
import type { WorkstreamDTO } from '@mymind/core/shared/types/workstreams'
import { BUDGET_LIMITS, DEFAULT_WORKSTREAM_BUDGET } from '@mymind/core/shared/types/workstreams'
import { BUDGET_NOTES, STATE_META, elapsedMs, formatCost, formatDuration } from '~/lib/workstreams/display'

definePageMeta({ title: 'Workstreams' })

const toast = useToast()
const { data, error, isPending } = useWorkstreamList()
const rows = computed(() => data.value ?? [])
watch(error, (err) => {
  if (err) toast.add({ color: 'error', title: 'Could not load workstreams', description: workstreamErrorOf(err).message })
})

// Elapsed times drift; re-render every 15s.
const now = ref(Date.now())
useIntervalFn(() => { now.value = Date.now() }, 15_000)

const columns: TableColumn<WorkstreamDTO>[] = [
  { accessorKey: 'state', header: 'State' },
  { accessorKey: 'goal', header: 'Goal' },
  { id: 'elapsed', header: 'Elapsed' },
  { id: 'steps', header: 'Steps' },
  { id: 'cost', header: 'Cost' },
  { id: 'origin', header: 'Started from' }
]

// ── New workstream ──────────────────────────────────────────────────────────
const { start } = useWorkstreamActions()
const newOpen = ref(false)
const goal = ref('')
const maxSteps = ref<number>(DEFAULT_WORKSTREAM_BUDGET.maxSteps)
const maxMinutes = ref<number>(DEFAULT_WORKSTREAM_BUDGET.maxWallMs / 60_000)
const startError = ref<{ message: string; code: string | null } | null>(null)

function openNew() {
  goal.value = ''
  maxSteps.value = DEFAULT_WORKSTREAM_BUDGET.maxSteps
  maxMinutes.value = DEFAULT_WORKSTREAM_BUDGET.maxWallMs / 60_000
  startError.value = null
  newOpen.value = true
}

async function create() {
  startError.value = null
  try {
    const ws = await start.mutateAsync({
      goal: goal.value.trim(),
      budget: { maxSteps: maxSteps.value, maxWallMs: Math.round(maxMinutes.value * 60_000) }
    })
    newOpen.value = false
    await navigateTo(`/workstreams/${ws.id}`)
  } catch (e) {
    startError.value = workstreamErrorOf(e)
  }
}
</script>

<template>
  <UDashboardPanel
    id="workstreams-panel"
    grow
  >
    <template #header>
      <UDashboardNavbar title="Workstreams">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            icon="i-lucide-plus"
            size="xs"
            color="primary"
            label="New workstream"
            data-testid="new-workstream"
            @click="openNew"
          />
        </template>
      </UDashboardNavbar>
      <AgentWorkerOfflineBanner />
      <AgentSandboxUnavailableBanner />
    </template>

    <template #body>
      <p class="text-sm text-muted">
        Long-running work Bridget does on her own, in its own thread and within a budget — across many
        steps, while you are away and across restarts. She tells you when one finishes or needs you.
        At most three run at once.
      </p>

      <UTable
        :data="rows"
        :columns="columns"
        :loading="isPending"
        data-testid="workstreams-table"
      >
        <template #state-cell="{ row }">
          <UBadge
            :color="STATE_META[row.original.state].color"
            :icon="STATE_META[row.original.state].icon"
            variant="subtle"
            size="sm"
            :label="STATE_META[row.original.state].label"
            :data-testid="`ws-state-${row.original.id}`"
          />
        </template>

        <template #goal-cell="{ row }">
          <ULink
            :to="`/workstreams/${row.original.id}`"
            class="line-clamp-2 max-w-xl whitespace-normal font-medium text-highlighted"
            :data-workstream="row.original.id"
          >
            {{ row.original.goal }}
          </ULink>
        </template>

        <template #elapsed-cell="{ row }">
          <UTooltip :text="`Active ${formatDuration(row.original.used.wallMs)} of ${formatDuration(row.original.budget.maxWallMs)}. ${BUDGET_NOTES.wall}`">
            <span class="tabular-nums">{{ formatDuration(elapsedMs(row.original, now)) }}</span>
          </UTooltip>
        </template>

        <template #steps-cell="{ row }">
          <UTooltip :text="BUDGET_NOTES.steps">
            <span class="tabular-nums">{{ row.original.used.steps }} / {{ row.original.budget.maxSteps }}</span>
          </UTooltip>
        </template>

        <template #cost-cell="{ row }">
          <UTooltip :text="BUDGET_NOTES.steps">
            <span class="tabular-nums text-muted">{{ formatCost(row.original.used.costUsd) }}</span>
          </UTooltip>
        </template>

        <template #origin-cell="{ row }">
          <ULink
            v-if="row.original.originConversationId"
            :to="{ path: '/agent', query: { c: row.original.originConversationId } }"
            class="text-sm text-muted hover:text-highlighted"
          >
            a chat
          </ULink>
          <span
            v-else
            class="text-sm text-dimmed"
          >here</span>
        </template>

        <template #empty>
          <div class="flex flex-col items-center justify-center gap-3 py-12 text-muted">
            <UIcon
              name="i-lucide-cog"
              class="size-12 text-dimmed"
            />
            <p class="text-sm">
              No workstreams yet. Ask Bridget to start one, or start one here.
            </p>
          </div>
        </template>
      </UTable>

      <UModal
        v-model:open="newOpen"
        title="New workstream"
        description="It cannot see any chat — write a self-contained goal: the task, the constraints, what done looks like."
      >
        <template #body>
          <form
            class="flex flex-col gap-4"
            @submit.prevent="create"
          >
            <UFormField
              label="Goal"
              required
            >
              <UTextarea
                v-model="goal"
                :rows="4"
                autoresize
                autofocus
                class="w-full"
                placeholder="Research … and write a summary with sources"
                data-testid="new-workstream-goal"
              />
            </UFormField>
            <div class="grid grid-cols-2 gap-3">
              <UFormField
                label="Max steps"
                :help="BUDGET_NOTES.steps"
              >
                <UInputNumber
                  v-model="maxSteps"
                  :min="BUDGET_LIMITS.maxSteps.min"
                  :max="BUDGET_LIMITS.maxSteps.max"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                label="Max active minutes"
                :help="BUDGET_NOTES.wall"
              >
                <UInputNumber
                  v-model="maxMinutes"
                  :min="BUDGET_LIMITS.maxWallMs.min / 60_000"
                  :max="BUDGET_LIMITS.maxWallMs.max / 60_000"
                  class="w-full"
                />
              </UFormField>
            </div>
            <UAlert
              v-if="startError"
              :color="startError.code === 'cap' ? 'warning' : 'error'"
              variant="subtle"
              :icon="startError.code === 'cap' ? 'i-lucide-octagon-pause' : 'i-lucide-circle-alert'"
              :title="startError.code === 'cap' ? 'Too many workstreams in progress' : 'Could not start it'"
              :description="startError.message"
              data-testid="new-workstream-error"
            />
            <div class="flex justify-end gap-2">
              <UButton
                color="neutral"
                variant="ghost"
                label="Cancel"
                @click="newOpen = false"
              />
              <UButton
                type="submit"
                label="Start"
                icon="i-lucide-play"
                :loading="start.isPending.value"
                :disabled="goal.trim().length < 3"
                data-testid="start-workstream"
              />
            </div>
          </form>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
