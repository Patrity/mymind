<script setup lang="ts">
definePageMeta({ title: 'Review' })

interface Proposed {
  title?: string
  project?: string
  domain?: string
  type?: string
  tags?: string[]
  path?: string
  reasoning?: string
}

interface ReviewItem {
  id: string
  docId: string
  kind: string
  proposed: Proposed
  createdAt: string
  docPath: string | null
}

const toast = useToast()

const { data: items, refresh, pending } = await useFetch<ReviewItem[]>('/api/review')

const actioning = ref<Record<string, boolean>>({})

async function approve(id: string) {
  actioning.value[id] = true
  try {
    await $fetch(`/api/review/${id}/approve`, { method: 'POST' })
    toast.add({ color: 'success', title: 'Proposal approved', description: 'Document updated.' })
    await refresh()
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
    await refresh()
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Reject failed', description: err.data?.statusMessage ?? err.message })
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
          v-if="pending"
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
        <UCard
          v-for="item in items"
          v-else
          :key="item.id"
        >
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
              v-if="item.proposed.title"
              class="flex gap-2 text-sm"
            >
              <span class="text-muted w-20 shrink-0">Title</span>
              <span class="font-medium text-highlighted">{{ item.proposed.title }}</span>
            </div>
            <div
              v-if="item.proposed.project"
              class="flex gap-2 text-sm"
            >
              <span class="text-muted w-20 shrink-0">Project</span>
              <span>{{ item.proposed.project }}</span>
            </div>
            <div
              v-if="item.proposed.domain"
              class="flex gap-2 text-sm"
            >
              <span class="text-muted w-20 shrink-0">Domain</span>
              <span>{{ item.proposed.domain }}</span>
            </div>
            <div
              v-if="item.proposed.type"
              class="flex gap-2 text-sm"
            >
              <span class="text-muted w-20 shrink-0">Type</span>
              <span>{{ item.proposed.type }}</span>
            </div>
            <div
              v-if="item.proposed.tags && item.proposed.tags.length > 0"
              class="flex gap-2 text-sm"
            >
              <span class="text-muted w-20 shrink-0">Tags</span>
              <div class="flex flex-wrap gap-1">
                <UBadge
                  v-for="tag in item.proposed.tags"
                  :key="tag"
                  :label="tag"
                  color="primary"
                  variant="subtle"
                  size="xs"
                />
              </div>
            </div>
            <div
              v-if="item.proposed.path"
              class="flex gap-2 text-sm"
            >
              <span class="text-muted w-20 shrink-0">New path</span>
              <span class="font-mono text-xs text-highlighted">{{ item.proposed.path }}</span>
            </div>
            <div
              v-if="item.proposed.reasoning"
              class="mt-3 p-3 rounded-md bg-muted text-xs text-muted leading-relaxed"
            >
              <span class="font-semibold text-default">Reasoning: </span>{{ item.proposed.reasoning }}
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
      </div>
    </template>
  </UDashboardPanel>
</template>
