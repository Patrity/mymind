<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { NavigationMenuItem } from '@nuxt/ui'
import type { ActivityCount } from '~~/shared/types/activity'

const { data: reviewCount } = useQuery({
  queryKey: ['review', 'count'],
  queryFn: () => $fetch<{ pending: number }>('/api/review/count')
})

const { data: memoryCount } = useQuery({
  queryKey: ['memory', 'count'],
  queryFn: () => $fetch<{ unreviewed: number }>('/api/memories/count')
})

const { data: activityCount } = useQuery({
  queryKey: ['activity', 'count'],
  queryFn: () => $fetch<ActivityCount>('/api/activity/count')
})

const { data: obsConfig } = useQuery({
  queryKey: ['observability-config'],
  queryFn: () => $fetch<{ alerts: { badge: boolean, toast: boolean } }>('/api/settings/observability-config')
})

const toast = useToast()
// Toast when a genuinely newer unacked error appears, de-duped by timestamp.
// On initial load we record the current latest without toasting (avoid noisy startup).
const lastToastedAt = ref<string | null>(null)
watch(() => activityCount.value?.latest, (latest) => {
  if (!latest) return
  if (obsConfig.value && obsConfig.value.alerts.toast === false) return
  if (lastToastedAt.value !== null && latest.at <= lastToastedAt.value) return // older/seen error surfaced after an ack — don't re-toast
  const first = lastToastedAt.value === null
  lastToastedAt.value = latest.at
  if (first) return // don't toast the pre-existing newest error on initial load
  toast.add({
    color: 'error',
    title: 'New error logged',
    description: latest.name ?? 'See Activity',
    actions: [{ label: 'View', onClick: () => { navigateTo('/activity/' + latest.id) } }]
  })
}, { deep: false })

const route = useRoute()

const settingsChildren: NavigationMenuItem[] = [
  { label: 'Providers', icon: 'i-lucide-server', to: '/settings/providers' },
  { label: 'Models', icon: 'i-lucide-box', to: '/settings/models' },
  { label: 'Model Configuration', icon: 'i-lucide-sliders-horizontal', to: '/settings/model-config' },
  { label: 'API Keys', icon: 'i-lucide-key-round', to: '/settings/api-keys' },
  { label: 'Activity & Alerts', icon: 'i-lucide-activity', to: '/settings/alerts' },
  { label: 'Bridget', icon: 'i-lucide-bot', to: '/settings/bridget' },
  { label: 'Search', icon: 'i-lucide-search', to: '/settings/search' },
  { label: 'Agent Tools', icon: 'i-lucide-terminal', to: '/settings/agent-tools' },
  { label: 'Secrets', icon: 'i-lucide-key-square', to: '/settings/secrets' },
  { label: 'Image Gen', icon: 'i-lucide-image', to: '/settings/image-gen' },
  { label: 'Analytics', icon: 'i-lucide-chart-line', to: '/settings/analytics' }
]

const mainItems = computed<NavigationMenuItem[]>(() => [
  { label: 'Capture', icon: 'i-lucide-plus', to: '/capture' },
  { label: 'Clipboard', icon: 'i-lucide-clipboard', to: '/clipboard' },
  { label: 'Agent', icon: 'i-lucide-bot', to: '/agent' },
  { label: 'Documents', icon: 'i-lucide-files', to: '/documents' },
  { label: 'Gallery', icon: 'i-lucide-image', to: '/gallery' },
  { label: 'Tasks', icon: 'i-lucide-square-kanban', to: '/tasks' },
  { label: 'Projects', icon: 'i-lucide-folder-kanban', to: '/projects' },
  { label: 'Sessions', icon: 'i-lucide-history', to: '/sessions' },
  { label: 'Analytics', icon: 'i-lucide-chart-line', to: '/analytics' },
  {
    label: 'Activity',
    icon: 'i-lucide-activity',
    to: '/activity',
    badge: (obsConfig.value?.alerts.badge !== false && (activityCount.value?.unacked ?? 0) > 0) ? activityCount.value!.unacked : undefined
  },
  {
    label: 'Memory',
    icon: 'i-lucide-brain',
    to: '/memories',
    badge: (memoryCount.value?.unreviewed ?? 0) > 0 ? memoryCount.value!.unreviewed : undefined
  },
  { label: 'Galaxy', icon: 'i-lucide-orbit', to: '/galaxy' },
  {
    label: 'Review',
    icon: 'i-lucide-inbox',
    to: '/review',
    badge: (reviewCount.value?.pending ?? 0) > 0 ? reviewCount.value!.pending : undefined
  },
  {
    label: 'Settings',
    icon: 'i-lucide-settings',
    defaultOpen: route.path.startsWith('/settings'),
    children: settingsChildren
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
          popover
        />
        <div class="mt-auto" />
      </template>

      <template #footer="{ collapsed }">
        <div :class="collapsed ? 'flex-col' : 'flex-row justify-center gap-2'" class="w-full flex">
          <UColorModeButton
            variant="ghost"
            color="neutral"
          />
        </div>
      </template>
    </UDashboardSidebar>

    <AppSearch />

    <slot />
  </UDashboardGroup>
</template>
