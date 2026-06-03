<script setup lang="ts">
import type { MemoryDTO, MemoryScope } from '~~/shared/types/memory'

definePageMeta({ title: 'Memories' })

const { search: searchMemories, list: listMemories, review: reviewMemory, archive: archiveMemory } = useMemories()
const toast = useToast()

// ── Filters ───────────────────────────────────────────────────────────────────
const q = ref('')
const scopeFilter = ref<MemoryScope | 'all'>('all')
const unreviewedOnly = ref(false)

const scopeItems = [
  { label: 'All scopes', value: 'all' },
  { label: 'User', value: 'user' },
  { label: 'Agent', value: 'agent' },
  { label: 'World', value: 'world' }
]

// ── Data ──────────────────────────────────────────────────────────────────────
const memories = ref<MemoryDTO[]>([])
const loading = ref(false)
const isSearching = computed(() => q.value.trim().length > 0)

async function load() {
  loading.value = true
  try {
    const scope = scopeFilter.value !== 'all' ? (scopeFilter.value as MemoryScope) : undefined
    if (q.value.trim()) {
      memories.value = await searchMemories(q.value.trim(), { scope })
    } else {
      memories.value = await listMemories({
        scope,
        reviewed: unreviewedOnly.value ? false : undefined
      })
    }
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Failed to load memories', description: err.data?.statusMessage ?? err.message })
  } finally {
    loading.value = false
  }
}

// Debounced search
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(q, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(load, 350)
})

watch([scopeFilter, unreviewedOnly], load)

onMounted(load)

// ── Actions ───────────────────────────────────────────────────────────────────
const actioning = ref<Record<string, boolean>>({})

async function doReview(id: string) {
  actioning.value[id] = true
  try {
    await reviewMemory(id)
    toast.add({ color: 'success', title: 'Marked as reviewed' })
    await load()
    await refreshNuxtData('memory-count')
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Review failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    actioning.value[id] = false
  }
}

const archiveConfirmId = ref<string | null>(null)

async function doArchive(id: string) {
  actioning.value[id] = true
  archiveConfirmId.value = null
  try {
    await archiveMemory(id)
    toast.add({ color: 'neutral', title: 'Memory archived' })
    await load()
    await refreshNuxtData('memory-count')
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Archive failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    actioning.value[id] = false
  }
}

// ── Scope badge colors ────────────────────────────────────────────────────────
const scopeColor: Record<MemoryScope, 'primary' | 'info' | 'warning'> = {
  user: 'primary',
  agent: 'info',
  world: 'warning'
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
</script>

<template>
  <UDashboardPanel
    id="memories"
    grow
    :ui="{ body: '!p-0' }"
  >
    <template #header>
      <UDashboardNavbar title="Memories">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="p-4 space-y-4 max-w-4xl mx-auto w-full">
        <!-- Filters -->
        <div class="flex flex-col sm:flex-row gap-3 items-start sm:items-center w-full">
          <UInput
            v-model="q"
            placeholder="Search memories…"
            icon="i-lucide-search"
            class="w-full sm:flex-1"
            :loading="loading && q.trim().length > 0"
            trailing
          />
          <USelect
            v-model="scopeFilter"
            :items="scopeItems"
            value-key="value"
            class="w-40 shrink-0"
          />
          <div class="flex items-center gap-2 shrink-0">
            <USwitch
              v-model="unreviewedOnly"
              label="Unreviewed only"
              size="sm"
            />
          </div>
        </div>

        <!-- Loading skeletons -->
        <div
          v-if="loading"
          class="space-y-3"
        >
          <USkeleton
            v-for="i in 4"
            :key="i"
            class="h-32 w-full rounded-lg"
          />
        </div>

        <!-- Empty state -->
        <div
          v-else-if="!memories.length"
          class="flex flex-col items-center justify-center py-24 gap-3 text-center"
        >
          <UIcon
            name="i-lucide-brain"
            class="size-12 text-muted"
          />
          <p class="text-sm font-medium text-muted">
            No memories found
          </p>
          <p class="text-xs text-dimmed">
            {{ q.trim() ? 'Try a different search term.' : 'Memories will appear here after enrichment.' }}
          </p>
        </div>

        <!-- Memory cards -->
        <UCard
          v-for="mem in memories"
          v-else
          :key="mem.id"
        >
          <template #header>
            <div class="flex items-start justify-between gap-2 flex-wrap">
              <div class="flex items-center gap-2 flex-wrap min-w-0">
                <UBadge
                  :label="mem.scope"
                  :color="scopeColor[mem.scope]"
                  variant="subtle"
                  size="xs"
                />
                <UBadge
                  v-if="mem.reviewedAt"
                  label="reviewed"
                  color="success"
                  variant="subtle"
                  size="xs"
                />
                <UBadge
                  v-if="isSearching && mem.relevance !== undefined"
                  :label="`rel ${Math.round(mem.relevance * 100)}%`"
                  color="info"
                  variant="outline"
                  size="xs"
                />
                <UBadge
                  v-else-if="!isSearching && mem.confidence !== null"
                  :label="`${Math.round(mem.confidence * 100)}% confidence`"
                  color="neutral"
                  variant="outline"
                  size="xs"
                />
              </div>
              <p class="text-xs text-dimmed shrink-0">
                {{ formatDate(mem.createdAt) }}
              </p>
            </div>
          </template>

          <!-- Content -->
          <p class="text-sm text-default leading-relaxed">
            {{ mem.content }}
          </p>

          <!-- Tags + source -->
          <div class="mt-3 space-y-2">
            <div
              v-if="mem.tags.length"
              class="flex flex-wrap gap-1"
            >
              <UBadge
                v-for="tag in mem.tags"
                :key="tag"
                :label="tag"
                color="neutral"
                variant="subtle"
                size="xs"
              />
            </div>
            <p
              v-if="mem.source"
              class="text-xs text-dimmed font-mono truncate"
            >
              {{ mem.source }}
            </p>
          </div>

          <template #footer>
            <div class="flex justify-end gap-2">
              <UButton
                v-if="!mem.reviewedAt"
                color="primary"
                variant="soft"
                size="sm"
                icon="i-lucide-check"
                :loading="actioning[mem.id]"
                @click="doReview(mem.id)"
              >
                Mark reviewed
              </UButton>

              <!-- Archive confirm inline -->
              <template v-if="archiveConfirmId === mem.id">
                <span class="text-xs text-muted self-center">Archive this memory?</span>
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  @click="archiveConfirmId = null"
                >
                  Cancel
                </UButton>
                <UButton
                  color="error"
                  size="sm"
                  :loading="actioning[mem.id]"
                  @click="doArchive(mem.id)"
                >
                  Confirm
                </UButton>
              </template>
              <UButton
                v-else
                color="neutral"
                variant="ghost"
                size="sm"
                icon="i-lucide-archive"
                :loading="actioning[mem.id]"
                @click="archiveConfirmId = mem.id"
              >
                Archive
              </UButton>
            </div>
          </template>
        </UCard>
      </div>
    </template>
  </UDashboardPanel>
</template>
