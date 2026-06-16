<script setup lang="ts">
import type { CommandPaletteGroup } from '@nuxt/ui'
import type { SearchResults } from '~~/shared/types/search'

const { search } = useGlobalSearch()

const searchTerm = ref('')
const results = ref<SearchResults | null>(null)
const loading = ref(false)
let debounceTimer: ReturnType<typeof setTimeout> | null = null

watch(searchTerm, (q) => {
  if (debounceTimer) clearTimeout(debounceTimer)
  if (!q.trim()) {
    results.value = null
    loading.value = false
    return
  }
  loading.value = true
  debounceTimer = setTimeout(async () => {
    try {
      results.value = await search(q.trim())
    } catch {
      results.value = null
    } finally {
      loading.value = false
    }
  }, 250)
})

onUnmounted(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
})

const groups = computed<CommandPaletteGroup[]>(() => {
  const r = results.value
  const list: CommandPaletteGroup[] = []

  if (r?.documents?.length) {
    list.push({
      id: 'documents',
      label: 'Documents',
      ignoreFilter: true,
      items: r.documents.map(doc => ({
        id: doc.id,
        label: doc.title || doc.path,
        suffix: doc.path,
        icon: 'i-lucide-file-text',
        onSelect: () => navigateTo(doc.to)
      }))
    })
  }

  if (r?.memories?.length) {
    list.push({
      id: 'memories',
      label: 'Memories',
      ignoreFilter: true,
      items: r.memories.map(mem => ({
        id: mem.id,
        label: mem.snippet,
        suffix: mem.scope,
        icon: 'i-lucide-brain',
        onSelect: () => navigateTo(mem.to)
      }))
    })
  }

  if (r?.images?.length) {
    list.push({
      id: 'images',
      label: 'Images',
      ignoreFilter: true,
      items: r.images.map(img => ({
        id: img.id,
        label: img.tags.join(', ') || 'Untitled image',
        icon: 'i-lucide-image',
        onSelect: () => navigateTo(img.to)
      }))
    })
  }

  if (r?.tasks?.length) {
    list.push({
      id: 'tasks',
      label: 'Tasks',
      ignoreFilter: true,
      items: r.tasks.map(task => ({
        id: task.id,
        label: task.title,
        suffix: task.status,
        icon: 'i-lucide-square-kanban',
        onSelect: () => navigateTo(task.to)
      }))
    })
  }

  if (r?.projects?.length) {
    list.push({
      id: 'projects',
      label: 'Projects',
      ignoreFilter: true,
      items: r.projects.map(proj => ({
        id: proj.slug,
        label: proj.name,
        icon: 'i-lucide-folder-kanban',
        onSelect: () => navigateTo(proj.to)
      }))
    })
  }

  if (r?.sessions?.length) {
    list.push({
      id: 'sessions',
      label: 'Sessions',
      ignoreFilter: true,
      items: r.sessions.map(sess => ({
        id: sess.id,
        label: sess.title,
        suffix: sess.project ?? sess.snippet ?? undefined,
        icon: 'i-lucide-history',
        onSelect: () => navigateTo(sess.to)
      }))
    })
  }

  if (r?.messages?.length) {
    list.push({
      id: 'messages',
      label: 'Messages',
      ignoreFilter: true,
      items: r.messages.map(msg => ({
        id: msg.id,
        label: msg.snippet,
        suffix: msg.role ?? undefined,
        icon: 'i-lucide-message-circle',
        onSelect: () => navigateTo(msg.to)
      }))
    })
  }

  return list
})
</script>

<template>
  <UDashboardSearch
    v-model:search-term="searchTerm"
    :groups="groups"
    :loading="loading"
    title="Search"
    description="Search documents, memories, images, tasks, projects, sessions and messages"
    placeholder="Search documents, memories, tasks, sessions…"
    :color-mode="false"
  />
</template>
