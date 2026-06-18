<script setup lang="ts">
import type { CommandPaletteGroup, CommandPaletteItem } from '@nuxt/ui'
import type { SearchResults, SearchHit, SearchHitType } from '~~/shared/types/search'
import { highlightTokens } from '~/utils/highlight'

const { search } = useGlobalSearch()

const TOP_COUNT = 6
const searchTerm = ref('')
const results = ref<SearchResults | null>(null)
const loading = ref(false)
let debounceTimer: ReturnType<typeof setTimeout> | null = null

watch(searchTerm, (q) => {
  if (debounceTimer) clearTimeout(debounceTimer)
  if (!q.trim()) { results.value = null; loading.value = false; return }
  loading.value = true
  debounceTimer = setTimeout(async () => {
    try { results.value = await search(q.trim()) } catch { results.value = null }
    finally { loading.value = false }
  }, 250)
})
onUnmounted(() => { if (debounceTimer) clearTimeout(debounceTimer) })

// Item carries the hit so the slot can render snippet + highlight + score.
type HitItem = CommandPaletteItem & { hit: SearchHit }
const toItem = (h: SearchHit): HitItem => ({
  id: `${h.type}:${h.id}`,
  label: h.title,
  icon: h.icon,
  slot: 'hit' as const,
  hit: h,
  onSelect: () => navigateTo(h.to)
})

const TYPE_LABELS: Record<SearchHitType, string> = {
  document: 'Documents', memory: 'Memories', image: 'Images', task: 'Tasks',
  project: 'Projects', session: 'Sessions', message: 'Messages'
}
const TYPE_ORDER: SearchHitType[] = ['document', 'memory', 'image', 'task', 'project', 'session', 'message']

const groups = computed<CommandPaletteGroup<CommandPaletteItem>[]>(() => {
  const hits = results.value?.hits ?? []
  if (!hits.length) return []
  const list: CommandPaletteGroup<CommandPaletteItem>[] = []

  list.push({
    id: 'top', label: 'Top results', ignoreFilter: true,
    items: hits.slice(0, TOP_COUNT).map(toItem)
  })
  for (const type of TYPE_ORDER) {
    const items = hits.filter(h => h.type === type).map(toItem)
    if (items.length) list.push({ id: type, label: TYPE_LABELS[type], ignoreFilter: true, items })
  }
  return list
})

const showScore = computed(() => results.value?.reranked === true)
</script>

<template>
  <UDashboardSearch
    v-model:search-term="searchTerm"
    :groups="groups"
    :loading="loading"
    title="Search"
    description="Search documents, memories, images, tasks, projects, sessions and messages"
    placeholder="Search everything…"
    :color-mode="false"
  >
    <template #hit-label="{ item }">
      <div class="flex flex-col gap-0.5 min-w-0">
        <span class="truncate text-highlighted">{{ item.hit.title }}</span>
        <span v-if="item.hit.snippet" class="truncate text-xs text-muted">
          <template v-for="(seg, i) in highlightTokens(item.hit.snippet, searchTerm)" :key="i">
            <mark v-if="seg.match" class="bg-primary/15 text-highlighted rounded-[2px]">{{ seg.text }}</mark>
            <template v-else>{{ seg.text }}</template>
          </template>
        </span>
      </div>
    </template>
    <template #hit-trailing="{ item }">
      <UBadge v-if="showScore" :label="item.hit.score.toFixed(2)" color="neutral" variant="subtle" size="sm" />
    </template>
  </UDashboardSearch>
</template>
