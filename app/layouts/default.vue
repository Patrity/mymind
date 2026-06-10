<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const { data: reviewCount, refresh: refreshReviewCount } = await useFetch('/api/review/count', {
  key: 'review-count',
  default: () => ({ pending: 0 })
})

const { data: memoryCount, refresh: refreshMemoryCount } = await useFetch('/api/memories/count', {
  key: 'memory-count',
  default: () => ({ unreviewed: 0 })
})

// Refresh counts every 60 seconds
let countTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  countTimer = setInterval(() => {
    refreshReviewCount()
    refreshMemoryCount()
  }, 60_000)
})
onUnmounted(() => { if (countTimer) clearInterval(countTimer) })

const mainItems = computed<NavigationMenuItem[]>(() => [
  { label: 'Capture', icon: 'i-lucide-plus', to: '/capture' },
  { label: 'Clipboard', icon: 'i-lucide-clipboard', to: '/clipboard' },
  { label: 'Voice', icon: 'i-lucide-mic', to: '/voice' },
  { label: 'Documents', icon: 'i-lucide-files', to: '/documents' },
  { label: 'Gallery', icon: 'i-lucide-image', to: '/gallery' },
  { label: 'Tasks', icon: 'i-lucide-square-kanban', to: '/tasks' },
  { label: 'Projects', icon: 'i-lucide-folder-kanban', to: '/projects' },
  { label: 'Sessions', icon: 'i-lucide-history', to: '/sessions' },
  {
    label: 'Memory',
    icon: 'i-lucide-brain',
    to: '/memories',
    badge: memoryCount.value.unreviewed > 0 ? memoryCount.value.unreviewed : undefined
  },
  {
    label: 'Review',
    icon: 'i-lucide-inbox',
    to: '/review',
    badge: reviewCount.value.pending > 0 ? reviewCount.value.pending : undefined
  }
])
</script>

<template>
  <!-- Panel sizes app-wide are PERCENTAGES (Nuxt UI default unit) -->
  <UDashboardGroup>
    <UDashboardSidebar
      id="mymind-sidebar"
      collapsible
      resizable
      :default-size="14"
      :min-size="11"
      :max-size="20"
      class="bg-elevated/25"
      :ui="{ footer: 'lg:border-t lg:border-default' }"
    >
      <template #header="{ collapsed }">
        <ULink
          to="/documents"
          class="flex items-center gap-2 mx-1"
        >
          <UIcon
            name="i-lucide-brain"
            class="size-6 text-primary shrink-0"
          />
          <span
            v-if="!collapsed"
            class="text-sm font-semibold tracking-tight"
          >MyMind</span>
        </ULink>
      </template>

      <template #default="{ collapsed }">
        <UDashboardSearchButton
          :collapsed="collapsed"
          class="bg-transparent ring-default"
        />

        <UNavigationMenu
          :collapsed="collapsed"
          :items="mainItems"
          orientation="vertical"
          tooltip
        />
        <div class="mt-auto" />
      </template>

      <template #footer="{ collapsed }">
        <UColorModeButton
          v-if="!collapsed"
          size="xs"
          variant="ghost"
          color="neutral"
          class="mx-2 mb-2"
        />
      </template>
    </UDashboardSidebar>

    <AppSearch />

    <slot />
  </UDashboardGroup>
</template>
