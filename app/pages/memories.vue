<script setup lang="ts">
import type { MemoryDTO, MemoryRelationDTO, MemoryScope } from '~~/shared/types/memory'

definePageMeta({ title: 'Memories' })

const { create: createMemory, review: reviewMemory, archive: archiveMemory, useMemoryList } = useMemories()
const { useProjectList } = useProjects()
const toast = useToast()

// ── Filters ───────────────────────────────────────────────────────────────────
const q = ref('')
const scopeFilter = ref<MemoryScope | 'all'>('all')
const unreviewedOnly = ref(false)
const tagFilter = ref<string[]>([])
const projectFilter = ref<string | undefined>(undefined)

const scopeItems = [
  { label: 'All scopes', value: 'all' },
  { label: 'User', value: 'user' },
  { label: 'Agent', value: 'agent' },
  { label: 'World', value: 'world' }
]

// ── Debounced search query ────────────────────────────────────────────────────
const debouncedQ = ref('')
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(q, (val) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { debouncedQ.value = val }, 350)
})

// ── Data ──────────────────────────────────────────────────────────────────────
const isSearching = computed(() => debouncedQ.value.trim().length > 0)

const listParams = computed(() => ({
  q: debouncedQ.value.trim() || undefined,
  scope: scopeFilter.value !== 'all' ? (scopeFilter.value as MemoryScope) : undefined,
  reviewed: (!debouncedQ.value.trim() && unreviewedOnly.value) ? false : undefined,
  project: projectFilter.value || undefined
}))

const { data, refetch, isPending, error } = useMemoryList(listParams)
const memories = computed(() => data.value ?? [])

watch(error, (err) => {
  if (!err) return
  const e = err as { data?: { statusMessage?: string }, message?: string }
  toast.add({ color: 'error', title: 'Failed to load memories', description: e.data?.statusMessage ?? e.message })
})

/** All unique tags from the loaded set, for the filter selectmenu */
const availableTags = computed(() => {
  const seen = new Set<string>()
  for (const m of memories.value) {
    for (const t of m.tags) seen.add(t)
  }
  return [...seen].sort()
})

// ── Project filter options ──────────────────────────────────────────────────────
const { data: projectsData } = useProjectList()

/**
 * Project filter options: prefer the registered projects list (by slug);
 * fall back to distinct project values from the loaded memories.
 */
const projectItems = computed(() => {
  const fromProjects = (projectsData.value ?? []).map(p => ({ label: p.name, value: p.slug }))
  if (fromProjects.length) return fromProjects
  const seen = new Set<string>()
  for (const m of memories.value) {
    if (m.project) seen.add(m.project)
  }
  return [...seen].sort().map(p => ({ label: p, value: p }))
})

/** Client-side tag filter applied after server fetch */
const filteredMemories = computed(() => {
  if (!tagFilter.value.length) return memories.value
  return memories.value.filter(m =>
    tagFilter.value.some(t => m.tags.includes(t))
  )
})

// ── Actions ───────────────────────────────────────────────────────────────────
const actioning = ref<Record<string, boolean>>({})

async function doReview(id: string) {
  actioning.value[id] = true
  try {
    await reviewMemory(id)
    toast.add({ color: 'success', title: 'Marked as reviewed' })
    await refetch()
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
    await refetch()
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Archive failed', description: err.data?.statusMessage ?? err.message })
  } finally {
    actioning.value[id] = false
  }
}

// ── Add memory modal ──────────────────────────────────────────────────────────
const addOpen = ref(false)
const addForm = ref({
  content: '',
  scope: 'user' as MemoryScope,
  project: '',
  tagsRaw: '' as string
})
const addLoading = ref(false)

const addScopeItems = [
  { label: 'User', value: 'user' },
  { label: 'Agent', value: 'agent' },
  { label: 'World', value: 'world' }
]

function openAddModal() {
  addForm.value = { content: '', scope: 'user', project: '', tagsRaw: '' }
  addOpen.value = true
}

/** Parse comma-separated tags input into a trimmed, non-empty array */
function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
}

async function submitAdd() {
  if (!addForm.value.content.trim()) return
  addLoading.value = true
  try {
    await createMemory({
      content: addForm.value.content.trim(),
      scope: addForm.value.scope,
      project: addForm.value.project.trim() || null,
      tags: parseTags(addForm.value.tagsRaw)
    })
    addOpen.value = false
    toast.add({ color: 'success', title: 'Memory added' })
    await refetch()
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string }, message?: string }
    toast.add({ color: 'error', title: 'Failed to add memory', description: err.data?.statusMessage ?? err.message })
  } finally {
    addLoading.value = false
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

function relationLabel(rel: MemoryRelationDTO): string {
  if (rel.type === 'supersedes') return rel.direction === 'outgoing' ? '→ supersedes' : '← superseded by'
  if (rel.type === 'contradicts') return '⚠ contradicts'
  if (rel.type === 'duplicate-of') return rel.direction === 'outgoing' ? '≈ duplicate of' : '≈ duplicate'
  return rel.type
}

function relationColor(rel: MemoryRelationDTO): 'warning' | 'error' | 'neutral' | 'info' {
  if (rel.type === 'supersedes') return rel.direction === 'outgoing' ? 'warning' : 'neutral'
  if (rel.type === 'contradicts') return 'error'
  return 'info'
}

function firstEvidence(mem: MemoryDTO) {
  return mem.evidence?.[0] ?? null
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
        <template #trailing>
          <UButton
            label="Add memory"
            icon="i-lucide-plus"
            color="primary"
            size="sm"
            @click="openAddModal"
          />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="p-4 space-y-4 max-w-4xl mx-auto w-full">
        <!-- Filters -->
        <div class="flex flex-col sm:flex-row gap-3 items-start sm:items-center w-full flex-wrap">
          <UInput
            v-model="q"
            placeholder="Search memories…"
            icon="i-lucide-search"
            class="w-full sm:flex-1"
            :loading="isPending && isSearching"
            trailing
          />
          <USelect
            v-model="scopeFilter"
            :items="scopeItems"
            value-key="value"
            class="w-40 shrink-0"
          />
          <USelectMenu
            v-model="tagFilter"
            :items="availableTags"
            multiple
            placeholder="Filter by tag…"
            class="w-48 shrink-0"
          />
          <USelectMenu
            v-model="projectFilter"
            :items="projectItems"
            value-key="value"
            clear
            placeholder="All projects"
            class="w-44 shrink-0"
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
          v-if="isPending"
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
          v-else-if="!filteredMemories.length"
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
            {{ q.trim() ? 'Try a different search term.' : tagFilter.length ? 'No memories match the selected tags.' : 'Memories will appear here after enrichment.' }}
          </p>
        </div>

        <!-- Memory cards -->
        <UCard
          v-for="mem in filteredMemories"
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
                  v-if="mem.project"
                  :label="mem.project"
                  color="neutral"
                  variant="outline"
                  size="xs"
                  icon="i-lucide-folder"
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
              <div class="text-right shrink-0">
                <p class="text-xs text-dimmed">
                  {{ formatDate(mem.sourceDate ?? mem.createdAt) }}
                </p>
                <p
                  v-if="mem.sourceDate"
                  class="text-xs text-dimmed/70"
                >
                  enriched {{ formatDate(mem.createdAt) }}
                </p>
              </div>
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

          <!-- Provenance -->
          <div
            v-if="firstEvidence(mem)"
            class="mt-3 p-3 rounded-md bg-muted space-y-1"
          >
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-xs font-semibold text-muted uppercase tracking-wide">Provenance</span>
              <NuxtLink
                v-if="firstEvidence(mem)?.sessionId"
                :to="`/sessions/${firstEvidence(mem)!.sessionId}`"
                class="text-xs text-primary hover:underline font-mono"
              >
                session {{ firstEvidence(mem)!.sessionId!.slice(0, 8) }}…
              </NuxtLink>
            </div>
            <blockquote
              v-if="firstEvidence(mem)?.quote"
              class="text-xs text-dimmed italic border-l-2 border-muted pl-2"
            >
              {{ firstEvidence(mem)!.quote }}
            </blockquote>
            <p
              v-if="firstEvidence(mem)?.reasoning"
              class="text-xs text-muted"
            >
              {{ firstEvidence(mem)!.reasoning }}
            </p>
          </div>

          <!-- Relation badges -->
          <div
            v-if="mem.relations && mem.relations.length"
            class="mt-2 flex flex-wrap gap-1"
          >
            <UBadge
              v-for="(rel, ri) in mem.relations"
              :key="ri"
              :label="relationLabel(rel)"
              :color="relationColor(rel)"
              variant="subtle"
              size="xs"
              :title="rel.otherContent ?? rel.otherId"
            />
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

  <!-- Add memory modal -->
  <UModal v-model:open="addOpen" title="Add memory">
    <template #body>
      <div class="space-y-4">
        <UFormField label="Content" required>
          <UTextarea
            v-model="addForm.content"
            placeholder="What do you want to remember?"
            :rows="4"
            autoresize
            class="w-full"
          />
        </UFormField>

        <div class="grid grid-cols-2 gap-3">
          <UFormField label="Scope">
            <USelect
              v-model="addForm.scope"
              :items="addScopeItems"
              value-key="value"
              class="w-full"
            />
          </UFormField>

          <UFormField label="Project (optional)">
            <UInput
              v-model="addForm.project"
              placeholder="e.g. mymind"
              class="w-full"
            />
          </UFormField>
        </div>

        <UFormField
          label="Tags (optional)"
          description="Comma-separated, e.g. deployment, infra"
        >
          <UInput
            v-model="addForm.tagsRaw"
            placeholder="tag1, tag2, tag3"
            class="w-full"
          />
        </UFormField>
      </div>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :disabled="addLoading"
          @click="addOpen = false"
        >
          Cancel
        </UButton>
        <UButton
          color="primary"
          :loading="addLoading"
          :disabled="!addForm.content.trim()"
          @click="submitAdd"
        >
          Save memory
        </UButton>
      </div>
    </template>
  </UModal>
</template>
