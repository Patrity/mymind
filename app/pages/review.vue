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
  /** Resolved server-side from the NEW memory (listReviewFeed) — not stored on the row. */
  project?: string | null
}

// A synthetic item (task-13) — NOT a review_queue row. `id` is a memories.id, so approving
// it goes through reviewMemory(id) via useMemories(), never POST /api/review/[id]/approve
// (which looks up review_queue by id and would 404 on a memories.id).
/**
 * Jev's score reads like a second confidence: higher means more likely worth keeping.
 * Colour is a nudge, not a verdict — the calibration behind it (n=28) supports ordering the
 * queue, not deciding anything, so the bands are deliberately coarse and never red/green
 * "right/wrong".
 */
function jevColor(score: number | null | undefined): string {
  if (score == null) return 'text-dimmed'
  if (score < 0.4) return 'text-warning'
  if (score < 0.6) return 'text-muted'
  return 'text-success'
}

function jevTooltip(score: number | null | undefined): string {
  if (score == null) return 'Not scored yet'
  const pct = Math.round(score * 100)
  const read = score < 0.4 ? 'likely transient or easily re-derived' : score < 0.6 ? 'mixed' : 'specific and durable'
  return `Jev's independent read: ${pct}% — ${read}. Advisory; it orders this queue, it does not decide.`
}

interface MemoryUnreviewedProposed {
  content: string
  scope: 'user' | 'agent' | 'world'
  tags: string[]
  project?: string | null
  confidence?: number | null
  /** Jev's second opinion, same orientation as confidence. Null until the scoring task
   *  has reached this memory. */
  jevScore?: number | null
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
  // null for a synthetic memory-unreviewed item — it has no backing document.
  docId: string | null
  kind: string
  proposed: DocProposed | MemoryConflictProposed | TriageProposed | MemoryUnreviewedProposed
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

function isMemoryUnreviewed(item: ReviewItem): item is ReviewItem & { proposed: MemoryUnreviewedProposed } {
  return item.kind === 'memory-unreviewed'
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

// Mirrors the scopeColor map in app/pages/memories.vue.
const MEMORY_SCOPE_COLOR: Record<'user' | 'agent' | 'world', 'primary' | 'info' | 'warning'> = {
  user: 'primary',
  agent: 'info',
  world: 'warning'
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

// The one action a memory-unreviewed item supports (task-13) — reuses the same composable
// action app/pages/memories.vue used for its now-removed "Mark reviewed" button.
const { review: reviewMemoryAction, archive: archiveMemoryAction } = useMemories()

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

// The four ways a conflict can end. Two buttons ("keep both" / "accept") assumed the NEW
// memory is always the better one — but enrichment can produce a worse restatement of a fact
// you already had, and both sides can be stale. Those cases had no button at all.
type ConflictResolution = 'keep-both' | 'archive-old' | 'archive-new' | 'archive-both'

const CONFLICT_TOAST: Record<ConflictResolution, { title: string, description: string, color: 'success' | 'neutral' | 'warning' }> = {
  'keep-both': { title: 'Both memories kept', description: 'Nothing archived — the conflict is marked resolved.', color: 'neutral' },
  'archive-old': { title: 'Old memory archived', description: 'The new memory supersedes it.', color: 'success' },
  'archive-new': { title: 'New memory archived', description: 'The existing memory stands.', color: 'warning' },
  'archive-both': { title: 'Both memories archived', description: 'Neither is kept.', color: 'warning' }
}

async function resolveConflict(id: string, resolution: ConflictResolution) {
  actioning.value[id] = true
  try {
    await $fetch(`/api/review/${id}/resolve`, { method: 'POST', body: { resolution } })
    toast.add({ ...CONFLICT_TOAST[resolution] })
    await refetch()
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Could not resolve conflict', description: err.data?.statusMessage ?? err.message })
  } finally {
    actioning.value[id] = false
  }
}

/** Menu for one conflict card. `kind` only changes the wording of the supersede case. */
function conflictActions(item: ReviewItem) {
  const isSupersede = item.kind === 'memory-supersede'
  return [[
    {
      label: 'Keep both',
      icon: 'i-lucide-copy',
      onSelect: () => resolveConflict(item.id, 'keep-both')
    },
    {
      label: isSupersede ? 'Archive old (accept)' : 'Archive old',
      icon: 'i-lucide-archive',
      onSelect: () => resolveConflict(item.id, 'archive-old')
    },
    {
      label: 'Archive new',
      icon: 'i-lucide-archive-x',
      onSelect: () => resolveConflict(item.id, 'archive-new')
    },
    {
      label: 'Archive both',
      icon: 'i-lucide-trash-2',
      color: 'error' as const,
      onSelect: () => resolveConflict(item.id, 'archive-both')
    }
  ]]
}

// ── memory-unreviewed helpers ─────────────────────────────────────────────
//
// `id` here is a memories.id, not a review_queue.id — go through reviewMemory(id),
// never POST /api/review/[id]/approve (that endpoint 404s on an id review_queue
// doesn't have).

async function markMemoryReviewed(id: string) {
  actioning.value[id] = true
  try {
    await reviewMemoryAction(id)
    toast.add({ color: 'success', title: 'Marked as reviewed' })
    await refetch()
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Review failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    actioning.value[id] = false
  }
}

/**
 * Discard an unreviewed memory.
 *
 * "Mark reviewed" used to be the ONLY exit from this queue, which meant the queue had one
 * outcome regardless of whether the memory was any good: junk could only ever be promoted
 * into the reviewed set, where `assembleContext` (reviewed: true) then feeds it to Bridget.
 * Rejecting is the other half of reviewing.
 *
 * Archive, not delete — and the archive endpoint hands back an undo token, so a misclick is
 * one toast action away from being reversed rather than gone.
 */
async function discardMemory(id: string) {
  actioning.value[id] = true
  try {
    const res = await archiveMemoryAction(id)
    toast.add({
      color: 'warning',
      title: 'Memory discarded',
      description: 'Archived, not deleted.',
      actions: res.undoToken
        ? [{
            label: 'Undo',
            color: 'neutral' as const,
            variant: 'outline' as const,
            onClick: () => undoDiscard(res.undoToken!)
          }]
        : undefined
    })
    await refetch()
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Discard failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    actioning.value[id] = false
  }
}

async function undoDiscard(undoToken: string) {
  try {
    // The endpoint's body key is `token`, not `undoToken` — its zod schema rejects the
    // latter outright, so sending the wrong name fails the undo, not just the naming.
    const res = await $fetch<{ ok: boolean, reason?: string }>('/api/agent/undo', { method: 'POST', body: { token: undoToken } })
    if (res.ok) toast.add({ color: 'success', title: 'Memory restored' })
    else toast.add({ color: 'error', title: 'Undo failed', description: res.reason ?? 'That discard could not be undone.' })
    await refetch()
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Undo failed', description: err.data?.statusMessage ?? err.message })
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
                  <!-- Two memories can read as flatly contradictory and both be correct, in
                       different projects — so the project is the first thing needed to judge
                       a conflict, not a detail. Resolved server-side from the NEW memory. -->
                  <UBadge
                    :label="(item.proposed as MemoryConflictProposed).project ?? 'no project'"
                    :color="(item.proposed as MemoryConflictProposed).project ? 'primary' : 'neutral'"
                    variant="soft"
                    size="xs"
                    :icon="(item.proposed as MemoryConflictProposed).project ? 'i-lucide-folder' : undefined"
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
              <!-- One menu, four outcomes. The default action stays the common one (the new
                   memory supersedes the old); the other three are a click away rather than
                   impossible. Nothing here is destructive-without-recovery — every branch
                   ARCHIVES, so a wrong call is reversible. -->
              <div class="flex justify-end gap-2">
                <UDropdownMenu :items="conflictActions(item)" :popper="{ placement: 'top-end' }">
                  <UButton
                    color="neutral"
                    variant="outline"
                    size="sm"
                    trailing-icon="i-lucide-chevron-down"
                    :loading="actioning[item.id]"
                  >
                    Resolve
                  </UButton>
                </UDropdownMenu>
                <UButton
                  :color="item.kind === 'memory-supersede' ? 'warning' : 'error'"
                  size="sm"
                  :loading="actioning[item.id]"
                  @click="resolveConflict(item.id, 'archive-old')"
                >
                  Archive old
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

          <!-- Unreviewed-memory card (task-13: folded in from /memories' removed
               "Mark reviewed" action). Synthetic item — id is a memories.id, not a
               review_queue.id, so it gets its own action (markMemoryReviewed), not
               approve/reject. -->
          <UCard v-else-if="isMemoryUnreviewed(item)">
            <template #header>
              <div class="flex items-start justify-between gap-2">
                <div class="flex items-center gap-2 flex-wrap min-w-0">
                  <UBadge
                    label="unreviewed memory"
                    color="neutral"
                    variant="outline"
                    size="xs"
                  />
                  <UBadge
                    :label="(item.proposed as MemoryUnreviewedProposed).scope"
                    :color="MEMORY_SCOPE_COLOR[(item.proposed as MemoryUnreviewedProposed).scope]"
                    variant="subtle"
                    size="xs"
                  />
                  <!-- Which codebase this came from. Without it a memory is unjudgeable:
                       "migrations are hand-written here" is correct in one project and wrong
                       in the next, and the reviewer had no way to tell them apart. -->
                  <UBadge
                    :label="(item.proposed as MemoryUnreviewedProposed).project ?? 'no project'"
                    :color="(item.proposed as MemoryUnreviewedProposed).project ? 'primary' : 'neutral'"
                    variant="soft"
                    size="xs"
                    :icon="(item.proposed as MemoryUnreviewedProposed).project ? 'i-lucide-folder' : undefined"
                  />
                  <span
                    v-if="(item.proposed as MemoryUnreviewedProposed).confidence != null"
                    class="text-xs text-muted"
                  >
                    {{ Math.round(((item.proposed as MemoryUnreviewedProposed).confidence ?? 0) * 100) }}% confidence
                  </span>
                  <!-- A SECOND opinion, not a restatement: `confidence` is enrichment
                       grading its own work, this is Jev reading the same text cold. Same
                       orientation (higher = keep), so a big gap between the two is the
                       signal worth looking at. Advisory only — it sorts, it never decides. -->
                  <UTooltip :text="jevTooltip((item.proposed as MemoryUnreviewedProposed).jevScore)">
                    <span
                      v-if="(item.proposed as MemoryUnreviewedProposed).jevScore != null"
                      :class="['text-xs font-medium', jevColor((item.proposed as MemoryUnreviewedProposed).jevScore)]"
                    >
                      {{ Math.round(((item.proposed as MemoryUnreviewedProposed).jevScore ?? 0) * 100) }}% Jev
                    </span>
                  </UTooltip>
                </div>
                <p class="text-xs text-dimmed shrink-0">
                  {{ new Date(item.createdAt).toLocaleString() }}
                </p>
              </div>
            </template>

            <div class="space-y-3">
              <p class="text-sm text-default leading-relaxed">
                {{ (item.proposed as MemoryUnreviewedProposed).content }}
              </p>
              <div
                v-if="(item.proposed as MemoryUnreviewedProposed).tags.length > 0"
                class="flex flex-wrap gap-1"
              >
                <UBadge
                  v-for="tag in (item.proposed as MemoryUnreviewedProposed).tags"
                  :key="tag"
                  :label="tag"
                  color="neutral"
                  variant="subtle"
                  size="xs"
                />
              </div>
            </div>

            <!-- Two outcomes, not one. Keeping a memory and rejecting it are both reviewing;
                 with only "Mark reviewed" the queue could promote junk but never shed it. -->
            <template #footer>
              <div class="flex justify-end gap-2">
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  icon="i-lucide-trash-2"
                  :loading="actioning[item.id]"
                  @click="discardMemory(item.id)"
                >
                  Discard
                </UButton>
                <UButton
                  color="primary"
                  variant="soft"
                  size="sm"
                  icon="i-lucide-check"
                  :loading="actioning[item.id]"
                  @click="markMemoryReviewed(item.id)"
                >
                  Mark reviewed
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
