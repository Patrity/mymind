<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { useTimeAgo } from '@vueuse/core'

definePageMeta({ title: 'Review' })

interface DocProposed {
  title?: string | null
  project?: string | null
  domain?: string | null
  type?: string | null
  tags?: string[] | null
  path?: string | null
  reasoning?: string | null
}

interface MemoryConflictProposed {
  newId: string
  existingId: string
  confidence?: number | null
  reasoning?: string | null
  newContent?: string | null
  existingContent?: string | null
}

// Mirrors shared/types/triage.ts TriageAction — a DESTINATION, not a doc classification.
type TriageActionKind = 'task' | 'note' | 'memory' | 'append'

interface TriageActionDTO {
  kind: TriageActionKind
  confidence: number
  title?: string | null
  project?: string | null
  priority?: 'low' | 'medium' | 'high'
  dueDate?: string | null
  scope?: 'user' | 'agent' | 'world'
  content?: string | null
  targetDocId?: string | null
  tags?: string[] | null
  path?: string | null
}

interface TriageProposed {
  primary: TriageActionDTO
  secondary: TriageActionDTO[]
  reasoning: string
  queued: TriageActionDTO[]
  applied: TriageActionDTO[]
}

interface ReviewItem {
  id: string
  docId: string
  kind: string
  proposed: DocProposed | MemoryConflictProposed | TriageProposed
  createdAt: string
  docPath: string | null
}

// A row from GET /api/triage/recent — one EXECUTED triage_actions row (auto-applied or
// human-approved), not a proposal. This is the "recently applied" feed's data shape,
// deliberately separate from ReviewItem/TriageProposed above.
interface TriageRecentDTO {
  id: string
  docId: string
  kind: TriageActionKind
  entityType: 'task' | 'memory' | 'document'
  entityId: string | null
  confidence: number
  autoApplied: boolean
  payload: TriageActionDTO
  createdAt: string
  docPath: string | null
}

const MEMORY_CONFLICT_KINDS = new Set(['memory-supersede', 'memory-contradict'])

function isMemoryConflict(item: ReviewItem): item is ReviewItem & { proposed: MemoryConflictProposed } {
  return MEMORY_CONFLICT_KINDS.has(item.kind)
}

function isTriage(item: ReviewItem): item is ReviewItem & { proposed: TriageProposed } {
  return item.kind === 'triage'
}

/** "1 action" / "2 actions" — never "1 actions". */
function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

const TRIAGE_KIND_LABEL: Record<TriageActionKind, string> = {
  task: 'Task',
  note: 'Note',
  memory: 'Memory',
  append: 'Append'
}

const TRIAGE_KIND_COLOR: Record<TriageActionKind, 'info' | 'neutral' | 'primary' | 'warning'> = {
  task: 'info',
  note: 'neutral',
  memory: 'primary',
  append: 'warning'
}

/** Human-readable destination for a proposed triage action. */
function triageDestination(action: TriageActionDTO): string {
  switch (action.kind) {
    case 'task':
      return action.project ? `“${action.title ?? 'Untitled task'}” → ${action.project}` : `“${action.title ?? 'Untitled task'}”`
    case 'note':
      return action.path ?? action.title ?? 'New note'
    case 'memory':
      return action.scope ? `Memory (${action.scope})` : 'Memory'
    case 'append':
      return 'Append to closest matching document'
    default:
      return action.kind
  }
}

const toast = useToast()

const { data, refetch, isPending, error } = useQuery({
  queryKey: ['review', 'list'],
  queryFn: () => $fetch<ReviewItem[]>('/api/review')
})

const items = computed(() => data.value ?? [])

watch(error, (err) => {
  if (err) {
    const e = err as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Failed to load review queue', description: e.data?.statusMessage ?? e.message })
  }
})

// ── Recently applied (Task 12) ───────────────────────────────────────────────
//
// A FEED of already-executed actions, not a queue — nothing here is waiting on the
// user, and this deliberately never touches review_queue, so it cannot affect the
// sidebar Review badge (GET /api/review/count).

const { data: recentData, refetch: refetchRecent } = useQuery({
  queryKey: ['triage', 'recent'],
  queryFn: () => $fetch<TriageRecentDTO[]>('/api/triage/recent')
})

const recentItems = computed(() => recentData.value ?? [])

function rel(iso: string) { return useTimeAgo(new Date(iso)).value }

/**
 * Applied-context destination text. Deliberately separate from triageDestination
 * (above) rather than reused: that one renders a PROPOSAL, where an append's real
 * target is not resolved yet ("Append to closest matching document" is the best it can
 * say). Here the action already ran, so payload.content is worth previewing instead.
 */
function recentDestination(row: TriageRecentDTO): string {
  const a = row.payload
  switch (row.kind) {
    case 'task':
      return a.project ? `“${a.title ?? 'Untitled task'}” → ${a.project}` : `“${a.title ?? 'Untitled task'}”`
    case 'note':
      return a.path ?? a.title ?? 'Filed as a note'
    case 'memory':
      return a.scope ? `Memory (${a.scope})` : 'Memory'
    case 'append': {
      const preview = a.content ? a.content.slice(0, 60) + (a.content.length > 60 ? '…' : '') : null
      return preview ? `Appended: “${preview}”` : 'Appended to a document'
    }
    default:
      return row.kind
  }
}

const undoing = ref<Record<string, boolean>>({})

async function undoRecent(row: TriageRecentDTO) {
  undoing.value[row.id] = true
  try {
    // revertTriageAction always resolves { ok, reason } with a 200 (never throws
    // the actuator's raw error through) — mirror POST /api/agent/undo's contract.
    const res = await $fetch<{ ok: boolean, reason?: string }>(`/api/triage/${row.id}/revert`, { method: 'POST' })
    if (res.ok) {
      toast.add({ color: 'success', title: 'Reverted', description: `${TRIAGE_KIND_LABEL[row.kind]} action undone.` })
    } else {
      toast.add({ color: 'error', title: 'Undo failed', description: res.reason ?? 'That action could not be undone.' })
    }
    await refetchRecent()
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Undo failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    undoing.value[row.id] = false
  }
}

const actioning = ref<Record<string, boolean>>({})

async function approve(item: ReviewItem) {
  actioning.value[item.id] = true
  try {
    // `applied` is what the server actually applied (only populated for kind: 'triage') —
    // not item.proposed.queued.length, which is the pre-request queue and would silently
    // over-report if an action failed to apply.
    const res = await $fetch<{ ok: boolean, applied?: TriageActionDTO[] }>(`/api/review/${item.id}/approve`, { method: 'POST' })
    const description = isTriage(item)
      ? `Applied ${pluralize(res.applied?.length ?? 0, 'action')}.`
      : 'Document updated.'
    toast.add({ color: 'success', title: 'Proposal approved', description })
    await refetch()
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Approve failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    actioning.value[item.id] = false
  }
}

async function reject(item: ReviewItem) {
  actioning.value[item.id] = true
  try {
    await $fetch(`/api/review/${item.id}/reject`, { method: 'POST' })
    toast.add({ color: 'neutral', title: 'Proposal rejected' })
    await refetch()
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Reject failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    actioning.value[item.id] = false
  }
}

// ── Memory conflict helpers ────────────────────────────────────────────────

async function acceptConflict(id: string, kind: string) {
  actioning.value[id] = true
  try {
    await $fetch(`/api/review/${id}/approve`, { method: 'POST' })
    const label = kind === 'memory-supersede' ? 'New memory kept, old archived.' : 'Contradiction resolved — old memory archived.'
    toast.add({ color: 'success', title: 'Conflict resolved', description: label })
    await refetch()
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Accept failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    actioning.value[id] = false
  }
}

async function keepBoth(id: string) {
  actioning.value[id] = true
  try {
    await $fetch(`/api/review/${id}/reject`, { method: 'POST' })
    toast.add({ color: 'neutral', title: 'Both memories kept' })
    await refetch()
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Keep-both failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    actioning.value[id] = false
  }
}
</script>

<template>
  <UDashboardPanel
    id="review"
    grow
    :ui="{ body: '!p-0' }"
  >
    <template #header>
      <UDashboardNavbar title="Review">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="p-4 space-y-4 max-w-3xl mx-auto">
        <!-- Loading -->
        <div
          v-if="isPending"
          class="space-y-3"
        >
          <USkeleton
            v-for="i in 3"
            :key="i"
            class="h-40 w-full rounded-lg"
          />
        </div>

        <!-- Empty state -->
        <div
          v-else-if="!items || items.length === 0"
          class="flex flex-col items-center justify-center py-24 gap-3 text-center"
        >
          <UIcon
            name="i-lucide-inbox"
            class="size-12 text-muted"
          />
          <p class="text-sm font-medium text-muted">
            No pending proposals
          </p>
          <p class="text-xs text-dimmed">
            AI enrichment proposals will appear here for review.
          </p>
        </div>

        <!-- Items list -->
        <template
          v-for="item in items"
          v-else
          :key="item.id"
        >
          <!-- Memory conflict card (memory-supersede / memory-contradict) -->
          <UCard v-if="isMemoryConflict(item)">
            <template #header>
              <div class="flex items-start justify-between gap-2">
                <div class="flex items-center gap-2 flex-wrap min-w-0">
                  <UBadge
                    :label="item.kind === 'memory-supersede' ? 'Supersede' : 'Contradiction'"
                    :color="item.kind === 'memory-supersede' ? 'warning' : 'error'"
                    variant="subtle"
                    size="xs"
                  />
                  <UBadge
                    label="memory conflict"
                    color="neutral"
                    variant="outline"
                    size="xs"
                  />
                  <span
                    v-if="(item.proposed as MemoryConflictProposed).confidence != null"
                    class="text-xs text-muted"
                  >
                    {{ Math.round(((item.proposed as MemoryConflictProposed).confidence ?? 0) * 100) }}% confidence
                  </span>
                </div>
                <p class="text-xs text-dimmed shrink-0">
                  {{ new Date(item.createdAt).toLocaleString() }}
                </p>
              </div>
            </template>

            <!-- NEW vs EXISTING content -->
            <div class="space-y-3">
              <div>
                <p class="text-xs font-semibold text-success mb-1 uppercase tracking-wide">
                  New
                </p>
                <p class="text-sm text-default leading-relaxed p-3 rounded-md bg-muted">
                  {{ (item.proposed as MemoryConflictProposed).newContent ?? '(no content)' }}
                </p>
              </div>
              <div>
                <p class="text-xs font-semibold text-error mb-1 uppercase tracking-wide">
                  {{ item.kind === 'memory-supersede' ? 'Existing (will be archived on accept)' : 'Existing (conflicts)' }}
                </p>
                <p class="text-sm text-default leading-relaxed p-3 rounded-md bg-muted">
                  {{ (item.proposed as MemoryConflictProposed).existingContent ?? '(no content)' }}
                </p>
              </div>
              <div
                v-if="(item.proposed as MemoryConflictProposed).reasoning"
                class="p-3 rounded-md bg-elevated text-xs text-muted leading-relaxed"
              >
                <span class="font-semibold text-default">Reasoning: </span>{{ (item.proposed as MemoryConflictProposed).reasoning }}
              </div>
            </div>

            <template #footer>
              <div class="flex justify-end gap-2">
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  :loading="actioning[item.id]"
                  @click="keepBoth(item.id)"
                >
                  Keep both
                </UButton>
                <UButton
                  :color="item.kind === 'memory-supersede' ? 'warning' : 'error'"
                  size="sm"
                  :loading="actioning[item.id]"
                  @click="acceptConflict(item.id, item.kind)"
                >
                  Accept (archive old)
                </UButton>
              </div>
            </template>
          </UCard>

          <!-- Triage card (capture-triage proposals: task / note / memory / append) -->
          <UCard v-else-if="isTriage(item)">
            <template #header>
              <div class="flex items-start justify-between gap-2">
                <div class="flex items-center gap-2 flex-wrap min-w-0">
                  <UBadge
                    label="triage"
                    color="neutral"
                    variant="outline"
                    size="xs"
                  />
                  <p class="text-xs text-muted font-mono truncate">
                    {{ item.docPath ?? item.docId }}
                  </p>
                </div>
                <p class="text-xs text-dimmed shrink-0">
                  {{ new Date(item.createdAt).toLocaleString() }}
                </p>
              </div>
            </template>

            <div class="space-y-4">
              <!-- Actions awaiting a human decision -->
              <div class="space-y-2">
                <p class="text-xs font-semibold text-highlighted uppercase tracking-wide">
                  {{ pluralize(item.proposed.queued.length, 'action') }} awaiting review
                </p>
                <div
                  v-for="(action, i) in item.proposed.queued"
                  :key="`queued-${i}`"
                  class="p-3 rounded-md bg-muted space-y-1"
                >
                  <div class="flex items-center gap-2 flex-wrap">
                    <UBadge
                      :label="TRIAGE_KIND_LABEL[action.kind]"
                      :color="TRIAGE_KIND_COLOR[action.kind]"
                      variant="subtle"
                      size="xs"
                    />
                    <span class="text-xs text-muted">{{ Math.round(action.confidence * 100) }}% confidence</span>
                  </div>
                  <p class="text-sm text-default">
                    {{ triageDestination(action) }}
                  </p>
                </div>
              </div>

              <!-- Reasoning -->
              <div class="p-3 rounded-md bg-elevated text-xs text-muted leading-relaxed">
                <span class="font-semibold text-default">Reasoning: </span>{{ item.proposed.reasoning }}
              </div>

              <!-- Already auto-applied actions — read-only context -->
              <div
                v-if="item.proposed.applied.length > 0"
                class="space-y-2"
              >
                <USeparator />
                <p class="text-xs font-semibold text-dimmed uppercase tracking-wide">
                  {{ pluralize(item.proposed.applied.length, 'action') }} already applied automatically
                </p>
                <div
                  v-for="(action, i) in item.proposed.applied"
                  :key="`applied-${i}`"
                  class="p-3 rounded-md bg-muted/50 space-y-1"
                >
                  <div class="flex items-center gap-2 flex-wrap">
                    <UBadge
                      :label="TRIAGE_KIND_LABEL[action.kind]"
                      color="neutral"
                      variant="subtle"
                      size="xs"
                    />
                    <UBadge
                      label="auto-applied"
                      color="success"
                      variant="subtle"
                      size="xs"
                    />
                    <span class="text-xs text-dimmed">{{ Math.round(action.confidence * 100) }}% confidence</span>
                  </div>
                  <p class="text-sm text-muted">
                    {{ triageDestination(action) }}
                  </p>
                </div>
              </div>
            </div>

            <template #footer>
              <div class="flex justify-end gap-2">
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  :loading="actioning[item.id]"
                  @click="reject(item)"
                >
                  Reject
                </UButton>
                <UButton
                  color="primary"
                  size="sm"
                  :loading="actioning[item.id]"
                  @click="approve(item)"
                >
                  Approve
                </UButton>
              </div>
            </template>
          </UCard>

          <!-- Enrichment-doc card (original behaviour) -->
          <UCard v-else>
            <template #header>
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <p class="text-xs text-muted font-mono truncate">
                    {{ item.docPath ?? item.docId }}
                  </p>
                  <UBadge
                    :label="item.kind"
                    color="neutral"
                    variant="subtle"
                    size="xs"
                    class="mt-1"
                  />
                </div>
                <p class="text-xs text-dimmed shrink-0">
                  {{ new Date(item.createdAt).toLocaleString() }}
                </p>
              </div>
            </template>

            <!-- Proposed fields -->
            <div class="space-y-2">
              <div
                v-if="(item.proposed as DocProposed).title"
                class="flex gap-2 text-sm"
              >
                <span class="text-muted w-20 shrink-0">Title</span>
                <span class="font-medium text-highlighted">{{ (item.proposed as DocProposed).title }}</span>
              </div>
              <div
                v-if="(item.proposed as DocProposed).project"
                class="flex gap-2 text-sm"
              >
                <span class="text-muted w-20 shrink-0">Project</span>
                <span>{{ (item.proposed as DocProposed).project }}</span>
              </div>
              <div
                v-if="(item.proposed as DocProposed).domain"
                class="flex gap-2 text-sm"
              >
                <span class="text-muted w-20 shrink-0">Domain</span>
                <span>{{ (item.proposed as DocProposed).domain }}</span>
              </div>
              <div
                v-if="(item.proposed as DocProposed).type"
                class="flex gap-2 text-sm"
              >
                <span class="text-muted w-20 shrink-0">Type</span>
                <span>{{ (item.proposed as DocProposed).type }}</span>
              </div>
              <div
                v-if="(item.proposed as DocProposed).tags && (item.proposed as DocProposed).tags!.length > 0"
                class="flex gap-2 text-sm"
              >
                <span class="text-muted w-20 shrink-0">Tags</span>
                <div class="flex flex-wrap gap-1">
                  <UBadge
                    v-for="tag in (item.proposed as DocProposed).tags"
                    :key="tag"
                    :label="tag"
                    color="primary"
                    variant="subtle"
                    size="xs"
                  />
                </div>
              </div>
              <div
                v-if="(item.proposed as DocProposed).path"
                class="flex gap-2 text-sm"
              >
                <span class="text-muted w-20 shrink-0">New path</span>
                <span class="font-mono text-xs text-highlighted">{{ (item.proposed as DocProposed).path }}</span>
              </div>
              <div
                v-if="(item.proposed as DocProposed).reasoning"
                class="mt-3 p-3 rounded-md bg-muted text-xs text-muted leading-relaxed"
              >
                <span class="font-semibold text-default">Reasoning: </span>{{ (item.proposed as DocProposed).reasoning }}
              </div>
            </div>

            <template #footer>
              <div class="flex justify-end gap-2">
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  :loading="actioning[item.id]"
                  @click="reject(item)"
                >
                  Reject
                </UButton>
                <UButton
                  color="primary"
                  size="sm"
                  :loading="actioning[item.id]"
                  @click="approve(item)"
                >
                  Approve
                </UButton>
              </div>
            </template>
          </UCard>
        </template>

        <!-- Recently applied (Task 12) — a FEED of already-executed actions, not the
             pending queue above. Kept deliberately flat (one bordered container, no
             card stack, no primary-colored buttons, no Approve/Reject) so it reads as
             a passive log rather than more work waiting on the user. -->
        <div class="pt-2">
          <div class="flex items-center gap-2 mb-2">
            <UIcon
              name="i-lucide-history"
              class="size-4 text-dimmed"
            />
            <p class="text-xs font-semibold text-dimmed uppercase tracking-wide">
              Recently applied
            </p>
          </div>

          <div
            v-if="recentItems.length === 0"
            class="rounded-lg border border-dashed border-default px-4 py-6 text-center text-xs text-dimmed"
          >
            Nothing applied automatically yet.
          </div>

          <div
            v-else
            class="rounded-lg border border-default divide-y divide-default overflow-hidden bg-muted/30"
          >
            <div
              v-for="row in recentItems"
              :key="row.id"
              class="flex items-center gap-3 px-3 py-2"
            >
              <UBadge
                :label="TRIAGE_KIND_LABEL[row.kind]"
                color="neutral"
                variant="subtle"
                size="xs"
              />
              <UBadge
                :label="row.autoApplied ? 'Auto' : 'Approved'"
                :color="row.autoApplied ? 'success' : 'neutral'"
                variant="subtle"
                size="xs"
              />
              <span class="text-sm text-muted truncate flex-1 min-w-0">
                {{ recentDestination(row) }}
              </span>
              <span class="text-xs text-dimmed shrink-0">{{ rel(row.createdAt) }}</span>
              <UButton
                size="xs"
                variant="ghost"
                color="neutral"
                icon="i-lucide-undo-2"
                label="Undo"
                :loading="undoing[row.id]"
                @click="undoRecent(row)"
              />
            </div>
          </div>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
