<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'

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

interface ReviewItem {
  id: string
  docId: string
  kind: string
  proposed: DocProposed | MemoryConflictProposed
  createdAt: string
  docPath: string | null
}

const MEMORY_CONFLICT_KINDS = new Set(['memory-supersede', 'memory-contradict'])

function isMemoryConflict(item: ReviewItem): item is ReviewItem & { proposed: MemoryConflictProposed } {
  return MEMORY_CONFLICT_KINDS.has(item.kind)
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

const actioning = ref<Record<string, boolean>>({})

async function approve(id: string) {
  actioning.value[id] = true
  try {
    await $fetch(`/api/review/${id}/approve`, { method: 'POST' })
    toast.add({ color: 'success', title: 'Proposal approved', description: 'Document updated.' })
    await refetch()
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Approve failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    actioning.value[id] = false
  }
}

async function reject(id: string) {
  actioning.value[id] = true
  try {
    await $fetch(`/api/review/${id}/reject`, { method: 'POST' })
    toast.add({ color: 'neutral', title: 'Proposal rejected' })
    await refetch()
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Reject failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    actioning.value[id] = false
  }
}

// ── Memory conflict helpers ────────────────────────────────────────────────

async function acceptConflict(id: string, kind: string) {
  actioning.value[id] = true
  try {
    await $fetch(`/api/review/${id}/approve`, { method: 'POST' })
    const label = kind === 'memory-supersede' ? 'New memory kept, old archived.' : 'New memory kept, old archived.'
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
                  @click="reject(item.id)"
                >
                  Reject
                </UButton>
                <UButton
                  color="primary"
                  size="sm"
                  :loading="actioning[item.id]"
                  @click="approve(item.id)"
                >
                  Approve
                </UButton>
              </div>
            </template>
          </UCard>
        </template>
      </div>
    </template>
  </UDashboardPanel>
</template>
